"""
Executive audit report.

GET /api/v1/reports/executive-audit-pdf?prepared_for=...&prepared_by=...&notes=...&include_governance=true&source=auto
returns a client-ready multi-page PDF built from what the server itself holds: the business priorities and their review state, the
"needs attention" triage, the 30/60/90-day decay scenarios, cannibalization findings after validation, data freshness, and the
reviewer sign-off history.

Data source (`source`): "live" uses the synced Search Console data, "sample" uses the built-in demo figures (the same ones the dashboard
shows without a sync) and says DEMO DATA on every page, "auto" (default) is live when a sync exists and sample otherwise. A report made
from demo figures can never pass for real results. Read-only: nothing is written except what the evidence audit stores when it re-runs.
"""

import asyncio
import datetime
import re
from contextlib import closing
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response

import alerting_engine_router as alerting
import evidence_audit_router as audit
import governance_store as gov
import gsc_connector_router as gsc
import triage_router as triage
from cannibalization_validation import validate_split_map
from decay_router import DecayRequest, MetricRow, _run_decay
from forecasting_engine_router import PageIn, Period, Scenario, aggregate_forecasts, forecast_page
from opportunities_router import all_opportunities
from report_demo_data import DEMO_PERIOD_DAYS, demo_cannibalization_rows, demo_decay_rows
from report_pdf import DISCLAIMER, render_pdf

router = APIRouter(prefix="/reports", tags=["Reports"])  # app.py mounts it under /api/v1

HIGH_RISK_IMPRESSIONS, MEDIUM_RISK_IMPRESSIONS = 500, 100  # the same bands the cannibalization view uses
MAX_PRIORITIES, MAX_FORECAST_PAGES, MAX_CANNIBAL, MAX_HISTORY, MAX_FINDINGS = 12, 6, 8, 25, 6
_CTRL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


def clean_text(v: str, limit: int) -> str:
    """User text: no control characters, bounded. (Markup is escaped later, where it is drawn.)"""
    return _CTRL.sub(" ", v or "").strip()[:limit]


def risk_for(total: int) -> str:
    return "High" if total > HIGH_RISK_IMPRESSIONS else "Medium" if total >= MEDIUM_RISK_IMPRESSIONS else "Low"


# ---------------------------------------------------------------------------
# Data collection
# ---------------------------------------------------------------------------
def resolve_source(requested: str) -> str:
    has_live = bool(gsc._status().get("last_sync")) and bool(gsc.load_rows("current"))
    if requested == "live" and not has_live:
        raise HTTPException(status_code=409, detail="There is no synced Search Console data yet. Sync first, or choose the sample data.")
    return "live" if (requested == "live" or (requested == "auto" and has_live)) else "sample"


def _period_days() -> int:
    last = gsc._status().get("last_sync")
    if not last:
        return DEMO_PERIOD_DAYS
    d = (datetime.date.fromisoformat(last["end_date"]) - datetime.date.fromisoformat(last["start_date"])).days + 1
    return max(7, min(120, d))


def collect_forecast(source: str) -> dict:
    """30/60/90-day decay scenarios from the two comparison windows, with the engine's own range band."""
    if source == "live":
        cur, prev = gsc.load_rows("current"), gsc.load_rows("previous")
        if not prev:
            return {"available": False, "reason": "The last Search Console sync has no comparison period, so there is nothing to project from. Sync again with the comparison option on."}
        mk = lambda rows: [MetricRow(url=r[1], query=r[0], impressions=r[3], clicks=r[2], average_position=max(0.0, r[5])) for r in rows]  # noqa: E731
        previous, current = mk(prev), mk(cur)
        days = _period_days()
    else:
        previous, current = demo_decay_rows()
        days = DEMO_PERIOD_DAYS
    decay = _run_decay(DecayRequest(previous=previous, current=current))
    pages, gone = [], []
    for d in decay["decayed"]:
        if d["prior_position"] is None:
            continue
        if d["current_position"] is None:
            gone.append(d["url"])  # lost every impression: nothing left to project
            continue
        pages.append(PageIn(
            url=d["url"], keyword=(d["top_queries"][0]["query"] if d["top_queries"] else ""), period_days=days,
            history=[Period(clicks=d["prior_clicks"], position=max(1.0, d["prior_position"]), impressions=d["prior_impressions"]),
                     Period(clicks=d["current_clicks"], position=max(1.0, d["current_position"]), impressions=d["current_impressions"])],
        ))
    scenario = Scenario()
    results = sorted((forecast_page(p, scenario) for p in pages), key=lambda r: (-r["losses"]["d90"], r["url"]))
    decaying = [r for r in results if r["status"] == "decaying"]
    if not decaying and not gone:
        return {"available": False, "reason": "No page is losing ground enough to project: nothing is decaying in this comparison."}
    agg = aggregate_forecasts(results)
    return {
        "available": True, "source": source, "period_days": days, "urls_analyzed": decay["summary"]["urls_analyzed"],
        "totals": agg["totals"], "points": agg["points"], "curve": agg["curve"], "gone": gone,
        "pages": [{
            "url": r["url"], "keyword": r["keyword"], "clicks_30d": r["current"]["clicks_30d"], "position_now": r["current"]["position"],
            "position_day90": r["points"][-1]["position"], "loss_90d": r["losses"]["d90"], "recoverable_90d": r["losses"]["recoverable_90d"],
            "tier": r["tier"], "confidence": r["confidence"],
        } for r in decaying[:MAX_FORECAST_PAGES]],
        "decaying_total": len(decaying),
        "low_confidence": sum(1 for r in decaying if r["confidence"] == "low"),
        "assumptions": {
            "recovery_pct": scenario.recovery_pct, "refresh_lag_days": scenario.refresh_lag_days, "ramp_days": scenario.ramp_days,
            "band": (decaying[0]["assumptions"]["band"] if decaying else "0.5x to 1.5x the fitted velocity"),
        },
    }


def collect_cannibalization(source: str) -> dict:
    """Candidates -> the six validation checks -> only the harmful overlaps are findings; the rest are counted, with the reason."""
    if source == "live":
        cur, prev = gsc.load_rows("current"), gsc.load_rows("previous")
    else:
        cur, prev = demo_cannibalization_rows(), []
    split = alerting._split_map(cur, 10)
    verdicts = validate_split_map(split, prev)
    counts = {"harmful": 0, "false_positive": 0, "cleared": 0}
    harmful = []
    for key, v in split.items():
        val = verdicts[key]
        counts[val["verdict"]] += 1
        if val["verdict"] != "harmful":
            continue
        urls = sorted(({"url": u, "impressions": d["imps"], "position": round(d["pos_w"] / d["imps"], 1) if d["imps"] else 0.0} for u, d in v["urls"].items()),
                      key=lambda x: (-x["impressions"], x["position"]))
        total = sum(u["impressions"] for u in urls)
        harmful.append({"query": v["query"], "total_impressions": total, "risk": risk_for(total), "urls": urls[:6], "headline": val["headline"],
                        "tested": val["tested"], "total_checks": val["total"], "confidence": val["confidence"]})
    harmful.sort(key=lambda r: -r["total_impressions"])
    return {"source": source, "candidates": sum(counts.values()), "counts": counts, "harmful": harmful[:MAX_CANNIBAL], "harmful_total": len(harmful)}


def collect_priorities() -> dict:
    states = gov.all_states()
    rows = []
    items = all_opportunities()
    for o in items:
        st = states.get(o["id"]) or gov.default_state(o["id"])
        rows.append({"id": o["id"], "priority": o["priority"], "keyword": o["keyword"], "impressions": o["impressions"], "score": o["score"],
                     "high_priority": o["high_priority"], "custom": o["custom"], "status": st["status"], "reviewer": st.get("reviewer")})
    rows.sort(key=lambda r: (-r["score"], r["priority"]))
    counts: dict[str, int] = {}
    for r in rows:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    threshold = items[0]["threshold"] if items else 65
    return {"threshold": threshold, "total": len(rows), "high_priority": sum(r["high_priority"] for r in rows),
            "waiting": sum(1 for r in rows if r["high_priority"] and r["status"] == "Proposed"), "status_counts": counts, "rows": rows[:MAX_PRIORITIES]}


def collect_governance() -> dict:
    names = {o["id"]: o["priority"] for o in all_opportunities()}
    chain = gov.verify_chain()
    with closing(gov._connect()) as conn:
        rows = conn.execute(
            "SELECT opportunity_id, event, actor, from_status, to_status, verdict, comment, created_at FROM governance_history "
            "WHERE event IN ('decision', 'baseline_locked', 'completed', 'reset', 'deleted') ORDER BY id DESC LIMIT ?", (MAX_HISTORY,)
        ).fetchall()
        total = conn.execute("SELECT COUNT(*) FROM governance_history").fetchone()[0]
    entries = [{"when": r[7], "opportunity": names.get(r[0], f"Opportunity #{r[0]} (since deleted)"), "event": r[1], "actor": r[2],
                "from_status": r[3], "to_status": r[4], "verdict": r[5], "comment": r[6] or ""} for r in rows]
    return {"chain": chain, "entries": entries, "log_total": total, "shown": len(entries)}


def collect_freshness() -> dict:
    a = audit.current_result()
    return {"ran_at": a["ran_at"], "status": a["status"], "counts": a["counts"], "sources": a["sources"],
            "findings": [{"severity": f["severity"], "title": f["title"], "detail": f["detail"]} for f in a["findings"][:MAX_FINDINGS]],
            "hidden_findings": max(0, len(a["findings"]) - MAX_FINDINGS)}


def collect_report(prepared_for: str, prepared_by: str, notes: str, include_governance: bool, source: str, now: datetime.datetime | None = None) -> dict:
    now = now or datetime.datetime.now(datetime.timezone.utc)
    resolved = resolve_source(source)
    gsc_status = gsc._status().get("last_sync")
    tri = triage.build_attention(now)
    priorities = collect_priorities()
    forecast = collect_forecast(resolved)
    cannibal = collect_cannibalization(resolved)
    fresh = collect_freshness()
    report = {
        "meta": {
            "title": "SEO Executive Audit", "prepared_for": prepared_for or "Your organisation", "prepared_by": prepared_by, "notes": notes,
            "generated_at": now.isoformat(timespec="seconds"), "date_display": now.strftime("%d %B %Y"), "time_display": now.strftime("%H:%M UTC"),
            "data_source": resolved,
            "data_source_label": (f"Live Search Console data: {gsc_status['site_url']}, {gsc_status['start_date']} to {gsc_status['end_date']} (synced {_pretty(gsc_status['synced_at'])})"
                                  if resolved == "live" and gsc_status else "DEMO DATA: built-in sample figures, not your results"),
            "include_governance": include_governance, "disclaimer": DISCLAIMER,
        },
        "priorities": priorities, "triage": tri, "forecast": forecast, "cannibalization": cannibal, "freshness": fresh,
        "governance": collect_governance() if include_governance else None,
    }
    t = forecast.get("totals") if forecast.get("available") else None
    report["kpis"] = [
        {"label": "Opportunities tracked", "value": str(priorities["total"]), "hint": f"{priorities['high_priority']} at score {priorities['threshold']:g}+"},
        {"label": "Waiting for sign-off", "value": str(priorities["waiting"]), "hint": "high-priority, no reviewer decision yet"},
        {"label": "Harmful overlaps", "value": str(cannibal["counts"]["harmful"]), "hint": f"of {cannibal['candidates']} candidates after six checks"},
        {"label": "Clicks at risk, 90 days", "value": f"{round(t['loss_90d']):,}" if t else "n/a", "hint": (f"{t['decaying']} decaying pages (scenario)" if t else "no projection available")},
        {"label": "Needs attention", "value": str(tri["total"]), "hint": tri["message"]},
        {"label": "Evidence audit", "value": {"ok": "Clean", "issues": "Notes", "errors": "Errors"}[fresh["status"]],
         "hint": f"{fresh['counts']['error']} errors, {fresh['counts']['warning']} warnings"},
    ]
    return report


def _pretty(iso: str) -> str:
    try:
        return datetime.datetime.fromisoformat(iso).strftime("%d %b %Y, %H:%M UTC")
    except ValueError:
        return iso


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:40] or "report"


@router.get("/executive-audit-pdf")
async def executive_audit_pdf(
    prepared_for: str = Query("", max_length=80, description="Client or organisation the report is for"),
    prepared_by: str = Query("", max_length=80),
    notes: str = Query("", max_length=1000, description="Optional note shown in the executive summary"),
    include_governance: bool = Query(True, description="Include the reviewer sign-off history"),
    source: Literal["auto", "live", "sample"] = Query("auto"),
):
    """The executive audit as a PDF download."""
    pf, pb, nt = clean_text(prepared_for, 80), clean_text(prepared_by, 80), clean_text(notes, 1000)

    def build() -> tuple[bytes, int, dict]:
        report = collect_report(pf, pb, nt, include_governance, source)
        pdf, pages = render_pdf(report)
        return pdf, pages, report["meta"]

    try:
        pdf, pages, meta = await asyncio.to_thread(build)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001 - never hand the browser a half-written file or a traceback
        raise HTTPException(status_code=500, detail=f"The report could not be generated ({type(e).__name__}). Check the server log.") from e
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d")
    return Response(
        content=pdf, media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="SEO-Executive-Audit-{_slug(pf)}-{stamp}.pdf"',
            "Cache-Control": "no-store",
            "X-Report-Source": meta["data_source"],
            "X-Report-Pages": str(pages),
        },
    )

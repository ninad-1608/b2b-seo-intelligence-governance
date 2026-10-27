"""
Data provenance & freshness audit.

Re-checks what the dashboard has STORED against itself, with no network calls:
  stale_data        Search Console snapshot / crawl check older than STALE_DAYS (GA4 is reported as "missing": it is never stored)
  text_consistency  the figures written into open alerts (their text) versus the current Search Console data; > DISCREPANCY_PCT apart is flagged
  integrity         the synced snapshot (rows, counts, positions, queries) and the locked measurement baselines

Results are stored in audit.db (never commit it). GET /api/v1/audit/status returns the latest run; it re-runs first if the evidence has
changed since (a new sync, check or baseline) or the last run is over an hour old. POST /api/v1/audit/run forces a run. When the app is
started normally a background task also runs it every EVIDENCE_AUDIT_MINUTES (default 60, 0 = off).

Limits worth knowing: an alert is only compared on the figures it states (clicks, impressions, CTR, position, lost clicks, split
impressions). Baselines are frozen on purpose, so they are checked for completeness, not compared with today's numbers.
"""

import asyncio
import datetime
import json
import logging
import os
import sqlite3
import time
from contextlib import asynccontextmanager, closing, suppress
from pathlib import Path

from fastapi import APIRouter

import alerting_engine_router as alerting
import governance_store as gov
import gsc_connector_router as gsc

router = APIRouter(prefix="/audit", tags=["Evidence Audit"])  # app.py mounts it under /api/v1
log = logging.getLogger("evidence_audit")

DB_PATH = Path(__file__).resolve().parent / "audit.db"  # never commit this file
STALE_DAYS = 7  # same line the "Needs your attention" strip uses
ERROR_STALE_DAYS = 14
DISCREPANCY_PCT = 25.0
ERROR_DISCREPANCY_PCT = 50.0
MAX_AGE_MINUTES = 60
KEEP_RUNS = 30
POSITION_MAX = 1000  # Search Console positions are small; anything beyond this is not a position

SEV_RANK = {"error": 3, "warning": 2, "info": 1}


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _parse(ts: str | None) -> datetime.datetime | None:
    if not ts:
        return None
    try:
        d = datetime.datetime.fromisoformat(ts)
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=datetime.timezone.utc)


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.execute("CREATE TABLE IF NOT EXISTS audit_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, ran_at TEXT NOT NULL, result_json TEXT NOT NULL)")
    return conn


def _finding(check: str, key: str, severity: str, source: str, title: str, detail: str, **extra) -> dict:
    return {"id": f"{check}:{key}", "check": check, "severity": severity, "source": source, "title": title, "detail": detail, **extra}


def _deviation_pct(claimed: float, live: float) -> float:
    """How far the live figure is from the written one, as a percentage of the written one."""
    if claimed == 0:
        return 0.0 if live == 0 else float("inf")
    return abs(live - claimed) / abs(claimed) * 100


def _n(x: float) -> str:
    return f"{x:,.0f}" if abs(x) >= 100 or float(x).is_integer() else f"{x:,.2f}"


def _when(d: datetime.datetime | None) -> str | None:
    return d.isoformat(timespec="seconds") if d else None


# ---------------------------------------------------------------------------
# Sources and staleness
# ---------------------------------------------------------------------------
def _source(key: str, label: str, when: datetime.datetime | None, now: datetime.datetime, missing_detail: str, **meta) -> dict:
    if when is None:
        return {"key": key, "label": label, "status": "missing", "last_sync": None, "age_days": None, "detail": missing_detail, **meta}
    age = now - when
    stale = age >= datetime.timedelta(days=STALE_DAYS)
    days = age.total_seconds() / 86400
    return {"key": key, "label": label, "status": "stale" if stale else "current", "last_sync": _when(when), "age_days": round(days, 1),
            "detail": (f"{int(days)} days old: older than {STALE_DAYS} days." if stale else "Within the last 7 days."), **meta}


def freshness_sources(now: datetime.datetime) -> list[dict]:
    status = gsc._status()
    sync = status.get("last_sync")
    gsc_src = _source(
        "gsc", "Search Console", _parse(sync["synced_at"]) if sync else None, now,
        "No Search Console data has been synced yet, so the dashboard is showing sample data." if not status.get("connected") else "Connected, but no sync has been run yet.",
        site_url=sync["site_url"] if sync else None, window=f"{sync['start_date']} to {sync['end_date']}" if sync else None,
    )
    crawl_src = _source("crawl", "Crawler check", _parse(alerting._kv_get("last_check")), now, "No automated crawl/alert check has run yet.")
    ga4 = {
        "key": "ga4", "label": "Google Analytics 4", "status": "missing", "last_sync": None, "age_days": None, "collected": False,
        "detail": ("A GA4 property is selected, but this dashboard stores no GA4 metrics, so there is nothing to date." if status.get("ga4_property")
                   else "GA4 is not connected, and this dashboard stores no GA4 metrics."),
    }
    return [gsc_src, crawl_src, ga4]


def check_stale_data(now: datetime.datetime, sources: list[dict]) -> list[dict]:
    out = []
    for s in sources:
        if s["status"] != "stale":
            continue
        sev = "error" if s["age_days"] >= ERROR_STALE_DAYS else "warning"
        extra = f" ({s['site_url']}, data {s['window']})" if s.get("site_url") else ""
        out.append(_finding("stale_data", s["key"], sev, s["key"], f"{s['label']} is {int(s['age_days'])} days old",
                            f"Last updated {s['last_sync']}{extra}. Anything built on it is older than {STALE_DAYS} days.", age_days=s["age_days"]))
    return out


# ---------------------------------------------------------------------------
# Text-to-data consistency: figures written into open alerts vs the current snapshot
# ---------------------------------------------------------------------------
def _compare(findings: list[dict], alert: dict, label: str, claimed: float, live: float, fmt=_n, hint: str = "") -> None:
    dev = _deviation_pct(claimed, live)
    if dev <= DISCREPANCY_PCT:
        return
    shown = "no longer comparable" if dev == float("inf") else f"{dev:.0f}%"
    findings.append(_finding(
        "text_consistency", f"{alert['id']}:{label}", "error" if dev >= ERROR_DISCREPANCY_PCT else "warning", "alerts",
        f"Alert text is out of step with the data: {alert['title']}",
        f"The alert says {label} was {fmt(claimed)}; the current Search Console data gives {fmt(live)} ({shown} apart, limit {DISCREPANCY_PCT:g}%).{hint} Re-run the alert check to rewrite it.",
        alert_id=alert["id"], claimed=claimed, live=live, deviation_pct=None if dev == float("inf") else round(dev, 1),
    ))


def check_text_consistency(cur: list[tuple], prev: list[tuple], t) -> list[dict]:
    with closing(alerting._db()) as db:
        rows = db.execute("SELECT id, fingerprint, title, data_json FROM alerts WHERE status = 'open' AND kind IN ('volatility', 'cannibalization')").fetchall()
    alerts = [{"id": r[0], "fp": r[1], "title": r[2], "data": json.loads(r[3]) if r[3] else {}} for r in rows]
    if not alerts:
        return []
    findings: list[dict] = []
    if not cur:
        return [_finding("text_consistency", "no-data", "warning", "alerts", f"{len(alerts)} open alert{'s' if len(alerts) != 1 else ''} describe data that is no longer stored",
                         "There is no Search Console snapshot to compare the alert text with (it was disconnected or cleared).")]

    c_clicks, p_clicks = sum(r[2] for r in cur), sum(r[2] for r in prev)
    c_imps, p_imps = sum(r[3] for r in cur), sum(r[3] for r in prev)
    cq, pq = alerting._query_agg(cur), alerting._query_agg(prev) if prev else {}
    c_pages: dict[str, int] = {}
    p_pages: dict[str, int] = {}
    for _q, page, clicks, _i, _c, _p in cur:
        c_pages[page] = c_pages.get(page, 0) + clicks
    for _q, page, clicks, _i, _c, _p in prev:
        p_pages[page] = p_pages.get(page, 0) + clicks
    split = alerting._split_map(cur, t.cannibalization_min_impressions)

    for a in alerts:
        fp, d = a["fp"], a["data"]
        if fp == "traffic:overall" and prev:
            _compare(findings, a, "clicks in the previous period", d["previous"], p_clicks)
            _compare(findings, a, "clicks in the current period", d["current"], c_clicks)
        elif fp == "impressions:overall" and prev:
            _compare(findings, a, "impressions in the previous period", d["previous"], p_imps)
            _compare(findings, a, "impressions in the current period", d["current"], c_imps)
        elif fp == "ctr:overall" and prev and p_imps and c_imps:
            pct = lambda x: f"{x * 100:.2f}%"  # noqa: E731
            _compare(findings, a, "click-through rate in the previous period", d["previous_ctr"], p_clicks / p_imps, pct)
            _compare(findings, a, "click-through rate in the current period", d["current_ctr"], c_clicks / c_imps, pct)
        elif fp.startswith("pos:") and d.get("query"):
            key = d["query"].lower()
            if key in cq and key in pq:
                _compare(findings, a, "the current average position", d["current_position"], cq[key]["pos"], lambda x: f"{x:.1f}")
                _compare(findings, a, "the previous average position", d["previous_position"], pq[key]["pos"], lambda x: f"{x:.1f}")
            else:
                findings.append(_finding("text_consistency", f"{a['id']}:gone", "warning", "alerts", f"Alert refers to a query that is no longer in the data: {a['title']}",
                                         f"“{d['query']}” is missing from the current snapshot, so its position change cannot be confirmed.", alert_id=a["id"]))
        elif fp.startswith("page:") and d.get("url") and prev:
            url = d["url"]
            live_lost = p_pages.get(url, 0) - c_pages.get(url, 0)
            _compare(findings, a, "the clicks the page lost", d["clicks_lost"], live_lost)
        elif fp.startswith("cannib:") and fp != "cannib:summary" and d.get("query"):
            claimed = sum(u["impressions"] for u in d.get("urls", []))
            v = split.get(d["query"].lower())
            if not v:
                findings.append(_finding("text_consistency", f"{a['id']}:resolved", "warning", "alerts", f"Alert says a query splits across URLs, but the data no longer shows it: {a['title']}",
                                         f"“{d['query']}” no longer has two URLs above the {t.cannibalization_min_impressions}-impression floor in the current snapshot.", alert_id=a["id"]))
            else:
                _compare(findings, a, "the impressions shared across URLs", claimed, sum(u["imps"] for u in v["urls"].values()))
    return findings


# ---------------------------------------------------------------------------
# Integrity: the synced snapshot and the locked baselines
# ---------------------------------------------------------------------------
def check_snapshot_integrity() -> list[dict]:
    out: list[dict] = []
    status = gsc._status()
    sync = status.get("last_sync")
    with closing(gsc._db()) as db:
        counts = dict(db.execute("SELECT period, COUNT(*) FROM gsc_rows GROUP BY period").fetchall())
        bad_query = db.execute("SELECT period, query, page FROM gsc_rows WHERE TRIM(COALESCE(query, '')) = '' OR TRIM(COALESCE(page, '')) = ''").fetchall()
        bad_pos = db.execute(f"SELECT period, query, page, position FROM gsc_rows WHERE position IS NULL OR position < 1 OR position > {POSITION_MAX}").fetchall()
        bad_num = db.execute("SELECT period, query FROM gsc_rows WHERE impressions < 0 OR clicks < 0 OR clicks > impressions").fetchall()
    stored_cur, stored_prev = counts.get("current", 0), counts.get("previous", 0)

    if not sync:
        if stored_cur or stored_prev:
            out.append(_finding("integrity", "rows-without-meta", "error", "gsc", "Search Console rows exist with no sync record",
                                f"{stored_cur + stored_prev:,} stored rows have no matching sync record, so their date range and age are unknown."))
        return out

    if sync["rows_current"] != stored_cur:
        out.append(_finding("integrity", "count-current", "error", "gsc", "Stored rows do not match the sync record",
                            f"The sync recorded {sync['rows_current']:,} current-period rows but {stored_cur:,} are stored.", recorded=sync["rows_current"], stored=stored_cur))
    if sync["rows_previous"] != stored_prev:
        out.append(_finding("integrity", "count-previous", "error", "gsc", "Stored previous-period rows do not match the sync record",
                            f"The sync recorded {sync['rows_previous']:,} previous-period rows but {stored_prev:,} are stored.", recorded=sync["rows_previous"], stored=stored_prev))
    if stored_cur == 0:
        out.append(_finding("integrity", "empty-current", "error", "gsc", "The Search Console snapshot is empty", "A sync is recorded but no current-period rows are stored."))
    if sync.get("previous_start") and stored_prev == 0:
        out.append(_finding("integrity", "empty-previous", "warning", "gsc", "The comparison period is empty",
                            f"The sync asked for {sync['previous_start']} to {sync['previous_end']} but no rows came back, so period-over-period alerts cannot run."))
    if sync["end_date"] < sync["start_date"]:
        out.append(_finding("integrity", "dates", "error", "gsc", "The sync date range is backwards", f"It ends ({sync['end_date']}) before it starts ({sync['start_date']})."))
    if bad_query:
        ex = ", ".join(f"“{q or '(blank)'}” on {p or '(blank)'}" for _per, q, p in bad_query[:3])
        out.append(_finding("integrity", "missing-query", "error", "gsc", f"{len(bad_query):,} stored row{'s' if len(bad_query) != 1 else ''} missing a query or page", f"For example {ex}. Query-level checks skip or mis-group these."))
    if bad_pos:
        ex = ", ".join(f"“{q}” ({'none' if pos is None else pos})" for _per, q, _p, pos in bad_pos[:3])
        out.append(_finding("integrity", "bad-position", "error", "gsc", f"{len(bad_pos):,} stored row{'s' if len(bad_pos) != 1 else ''} with a missing or impossible position", f"Positions must be between 1 and {POSITION_MAX}. For example {ex}."))
    if bad_num:
        out.append(_finding("integrity", "bad-numbers", "error", "gsc", f"{len(bad_num):,} stored row{'s' if len(bad_num) != 1 else ''} with impossible numbers", "Negative values, or more clicks than impressions."))
    if sync.get("truncated"):
        out.append(_finding("integrity", "truncated", "info", "gsc", "The snapshot is capped", f"Search Console returns at most {gsc.ROW_LIMIT:,} rows per request, so the long tail of queries is not included."))
    return out


def check_baseline_integrity() -> list[dict]:
    out: list[dict] = []
    with closing(gov._connect()) as conn:
        rows = conn.execute("SELECT opportunity_id, status, baseline_json, baseline_locked_at FROM governance_state WHERE status IN ('Measuring', 'Completed') AND baseline_locked_at IS NOT NULL").fetchall()
    for op_id, status, raw, locked_at in rows:
        key = f"baseline-{op_id}"
        try:
            b = json.loads(raw) if raw else None
        except ValueError:
            b = None
        if not isinstance(b, dict):
            out.append(_finding("integrity", key, "error", "baselines", f"Baseline for opportunity {op_id} is missing or unreadable", f"It is {status} but its measurement baseline cannot be read, so results cannot be compared with it.", opportunity_id=op_id))
            continue
        missing = [k for k in ("keyword", "score", "impressions") if b.get(k) in (None, "")]
        if not b.get("factors"):
            missing.append("factors")
        if missing:
            out.append(_finding("integrity", f"{key}-fields", "error", "baselines", f"Baseline for “{b.get('keyword') or op_id}” is incomplete", f"Missing: {', '.join(missing)}.", opportunity_id=op_id))
        sc = b.get("search_console")
        if sc is None:
            out.append(_finding("integrity", f"{key}-no-gsc", "info", "baselines", f"Baseline for “{b.get('keyword') or op_id}” has no Search Console numbers",
                                "No synced data matched this keyword when the baseline was locked, so improvement can only be judged against the reviewer's ratings, not measured traffic.", opportunity_id=op_id))
        else:
            pos, imps = sc.get("position"), sc.get("impressions")
            if imps and (pos is None or not 1 <= pos <= POSITION_MAX):
                out.append(_finding("integrity", f"{key}-position", "error", "baselines", f"Baseline for “{b.get('keyword') or op_id}” has no valid position",
                                    f"It records {imps:,} impressions but a position of {pos!r}, so rank changes cannot be measured.", opportunity_id=op_id))
            if not sc.get("period") or "None" in str(sc.get("period")):
                out.append(_finding("integrity", f"{key}-period", "warning", "baselines", f"Baseline for “{b.get('keyword') or op_id}” has no data period", "Without the date range it is unclear which weeks the numbers cover.", opportunity_id=op_id))
    return out


# ---------------------------------------------------------------------------
# Running + storing
# ---------------------------------------------------------------------------
def run_audit(now: datetime.datetime | None = None) -> dict:
    now = now or _now()
    started = time.perf_counter()
    sources = freshness_sources(now)
    t, _, _ = alerting.load_settings()
    cur, prev = gsc.load_rows("current"), gsc.load_rows("previous")
    checks, findings = {}, []
    for name, fn in (
        ("stale_data", lambda: check_stale_data(now, sources)),
        ("text_consistency", lambda: check_text_consistency(cur, prev, t)),
        ("integrity", lambda: check_snapshot_integrity() + check_baseline_integrity()),
    ):
        try:
            got = fn()
            checks[name] = {"status": "issues" if got else "ok", "findings": len(got)}
        except Exception as e:  # noqa: BLE001 - one broken check must not hide the others
            log.exception("evidence audit check %s failed", name)
            got = [_finding(name, "check-failed", "error", "audit", f"The {name.replace('_', ' ')} check could not run", f"{type(e).__name__}: {e}"[:300])]
            checks[name] = {"status": "failed", "findings": 1}
        findings += got
    findings.sort(key=lambda f: -SEV_RANK[f["severity"]])
    counts = {s: sum(f["severity"] == s for f in findings) for s in SEV_RANK}
    result = {
        "ran_at": now.isoformat(timespec="seconds"),
        "duration_ms": round((time.perf_counter() - started) * 1000, 1),
        "status": "errors" if counts["error"] else "issues" if findings else "ok",
        "counts": {**counts, "total": len(findings)},
        "error_count": counts["error"],
        "sources": sources,
        "checks": checks,
        "findings": findings,
        "thresholds": {"stale_days": STALE_DAYS, "discrepancy_pct": DISCREPANCY_PCT},
    }
    with closing(_db()) as db, db:
        db.execute("INSERT INTO audit_runs (ran_at, result_json) VALUES (?, ?)", (result["ran_at"], json.dumps(result)))
        db.execute("DELETE FROM audit_runs WHERE id NOT IN (SELECT id FROM audit_runs ORDER BY id DESC LIMIT ?)", (KEEP_RUNS,))
    return result


def latest_result() -> dict | None:
    with closing(_db()) as db:
        row = db.execute("SELECT result_json FROM audit_runs ORDER BY id DESC LIMIT 1").fetchone()
    return json.loads(row[0]) if row else None


def _evidence_changed_since(ran_at: datetime.datetime) -> bool:
    stamps = [_parse((gsc._status().get("last_sync") or {}).get("synced_at")), _parse(alerting._kv_get("last_check"))]
    with closing(gov._connect()) as conn:
        stamps += [_parse(r[0]) for r in conn.execute("SELECT baseline_locked_at FROM governance_state WHERE baseline_locked_at IS NOT NULL")]
    return any(s and s > ran_at for s in stamps)


def current_result(now: datetime.datetime | None = None) -> dict:
    """The stored audit, re-run first when it would be out of date (never run, new evidence since, or over an hour old)."""
    now = now or _now()
    last = latest_result()
    ran = _parse(last["ran_at"]) if last else None
    if last is None or ran is None or now - ran > datetime.timedelta(minutes=MAX_AGE_MINUTES) or _evidence_changed_since(ran):
        return run_audit(now)
    # the source ages move with the clock even when nothing was re-run, so refresh them cheaply
    last["sources"] = freshness_sources(now)
    return last


@router.get("/status")
async def audit_status():
    """Latest audit: findings, error count, per-source freshness and when it last ran."""
    return await asyncio.to_thread(current_result)


@router.post("/run")
async def audit_run():
    """Run the audit now."""
    return await asyncio.to_thread(run_audit)


# ---------------------------------------------------------------------------
# Background runner (wired in as the app's lifespan)
# ---------------------------------------------------------------------------
def interval_minutes() -> int:
    try:
        return max(0, int(os.getenv("EVIDENCE_AUDIT_MINUTES", "60") or 60))
    except ValueError:
        return 60


async def _loop(minutes: int) -> None:
    while True:
        try:
            await asyncio.to_thread(run_audit)
        except Exception:  # noqa: BLE001 - keep the loop alive
            log.exception("scheduled evidence audit failed")
        await asyncio.sleep(minutes * 60)


@asynccontextmanager
async def audit_lifespan(_app):
    minutes = interval_minutes()
    task = asyncio.create_task(_loop(minutes)) if minutes > 0 else None
    try:
        yield
    finally:
        if task:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

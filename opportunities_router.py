"""Opportunities with a human review gate ('AI drafts, humans decide').

The server is the single registry of opportunities: the built-in sample set and the user's custom priorities share one id space
(custom ids are offset by CUSTOM_ID_OFFSET). Review state lives in governance_store; this module exposes it and enforces the gates.
"""
from contextlib import closing
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field, field_validator

import governance_store as gov
from priorities_router import _COLS as PRIORITY_COLS
from priorities_router import _db as priorities_db
from priorities_router import _item as priority_item
from scoring_router import HIGH_PRIORITY_THRESHOLD, FactorRatings, score_opportunity

router = APIRouter(prefix="/opportunities", tags=["Opportunities & Governance"])  # app.py mounts it under /api/v1

CUSTOM_ID_OFFSET = 1_000_000

# Built-in sample opportunities: (id, topic, keyword, monthly impressions, cannibalized, business, first-party, ranking, query-to-URL)
_SAMPLES = [
    (1, "Demand generation pillar", "B2B SaaS demand generation", 48200, False, 5, 5, 4, 4),
    (2, "Cloud migration services", "enterprise cloud migration", 31800, True, 5, 4, 4, 4),
    (3, "HubSpot partnership", "hubspot CRM integration", 27400, False, 4, 4, 4, 4),
    (4, "ABM program", "account based marketing platform", 22100, True, 4, 3, 4, 4),
    (5, "Sales enablement content", "sales enablement software", 18600, False, 3, 3, 4, 3),
    (6, "Lead scoring education", "lead scoring model examples", 12900, False, 3, 3, 3, 2),
    (7, "Pricing page visibility", "b2b saas pricing models", 9400, False, 3, 2, 3, 2),
    (8, "Glossary expansion", "what is mql vs sql", 6700, False, 2, 1, 2, 2),
]


def _sample_item(row: tuple) -> dict:
    op_id, topic, keyword, impressions, cannibalized, b, f, r, q = row
    scored = score_opportunity(FactorRatings(business_priority=b, first_party_evidence=f, ranking_opportunity=r, query_url_evidence=q))
    return {"id": op_id, "priority": topic, "keyword": keyword, "impressions": impressions, "cannibalized": cannibalized, "custom": False,
            "db_id": None, "level": None, "rated": True, **scored}


def _custom_item(p: dict) -> dict:
    return {"id": CUSTOM_ID_OFFSET + p["id"], "priority": p["name"], "keyword": p["keyword"], "impressions": p["impressions"], "cannibalized": False,
            "custom": True, "db_id": p["id"], "level": p["level"], "rated": p["rated"], "score": p["score"], "high_priority": p["high_priority"],
            "threshold": p["threshold"], "factors": p["factors"]}


def all_opportunities() -> list[dict]:
    with closing(priorities_db()) as conn:
        rows = conn.execute(f"SELECT {PRIORITY_COLS} FROM priorities ORDER BY id DESC").fetchall()
    return [_custom_item(priority_item(r)) for r in rows] + [_sample_item(r) for r in _SAMPLES]


def resolve(op_id: int) -> dict | None:
    if op_id >= CUSTOM_ID_OFFSET:
        with closing(priorities_db()) as conn:
            row = conn.execute(f"SELECT {PRIORITY_COLS} FROM priorities WHERE id = ?", (op_id - CUSTOM_ID_OFFSET,)).fetchone()
        return _custom_item(priority_item(row)) if row else None
    row = next((r for r in _SAMPLES if r[0] == op_id), None)
    return _sample_item(row) if row else None


def _with_state(item: dict, state: dict) -> dict:
    return {**item, "governance": _public_state(state)}


def _public_state(st: dict) -> dict:
    return {k: st[k] for k in ("status", "reviewer", "verdict", "comment", "decided_at", "baseline_locked_at", "completed_at", "updated_at")} | {"approved": st["status"] in gov.APPROVED_LINEAGE}


def _http(e: gov.GovernanceError) -> HTTPException:
    return HTTPException(status_code=e.status_code, detail=e.detail)


def _require_opportunity(op_id: int) -> dict:
    item = resolve(op_id)
    if not item:
        raise HTTPException(status_code=404, detail="That opportunity does not exist.")
    return item


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------
class DecisionIn(BaseModel):
    reviewer_name: str = Field(max_length=200)
    verdict: Literal["Approved", "Needs changes", "Reject"]
    comment: str = Field(max_length=5000)

    @field_validator("reviewer_name")
    @classmethod
    def _name(cls, v: str) -> str:
        return gov.clean_reviewer_name(v)

    @field_validator("comment")
    @classmethod
    def _comment(cls, v: str) -> str:
        return gov.clean_comment(v)


class ActionIn(BaseModel):
    reviewer_name: str = Field(max_length=200)
    note: str = Field(default="", max_length=5000)

    @field_validator("reviewer_name")
    @classmethod
    def _name(cls, v: str) -> str:
        return gov.clean_reviewer_name(v)

    @field_validator("note")
    @classmethod
    def _note(cls, v: str) -> str:
        return gov.clean_comment(v, required=False)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@router.get("")
async def list_opportunities():
    """Every opportunity, scored, with its review state."""
    states = gov.all_states()
    items = [_with_state(i, states.get(i["id"]) or gov.default_state(i["id"])) for i in all_opportunities()]
    counts = {s: sum(1 for i in items if i["governance"]["status"] == s) for s in gov.STATUSES}
    return {"status": "success", "threshold": HIGH_PRIORITY_THRESHOLD, "counts": counts, "items": items}


@router.get("/audit-log/verify")
async def verify_audit_log():
    """Recompute the history's hash chain: ok=false means a row was edited or removed."""
    return gov.verify_chain()


@router.get("/{opportunity_id}")
async def get_opportunity(opportunity_id: int):
    item = _require_opportunity(opportunity_id)
    return _with_state(item, gov.get_state(opportunity_id))


@router.get("/{opportunity_id}/history")
async def get_history(opportunity_id: int, limit: int = Query(100, ge=1, le=500)):
    """The audit trail for one opportunity, newest first."""
    return {"opportunity_id": opportunity_id, "items": gov.history(opportunity_id, limit), "integrity": gov.verify_chain()}


@router.post("/{opportunity_id}/decision")
async def submit_decision(opportunity_id: int, data: DecisionIn):
    """A named human reviewer signs off (or does not). Recorded in the history with a server-side timestamp."""
    item = _require_opportunity(opportunity_id)
    try:
        state, entry = gov.decide(opportunity_id, data.reviewer_name, data.verdict, data.comment)
    except gov.GovernanceError as e:
        raise _http(e)
    return {"status": "success", "opportunity": _with_state(item, state), "entry": entry}


def _gsc_snapshot(keyword: str) -> dict | None:
    """Real Search Console numbers for the keyword, if a sync exists (so the baseline is something to measure against)."""
    try:
        from gsc_connector_router import _status, load_rows

        rows = [r for r in load_rows("current") if r[0].lower() == keyword.lower()]
        if not rows:
            return None
        imps = sum(r[3] for r in rows)
        sync = _status().get("last_sync") or {}
        return {"clicks": sum(r[2] for r in rows), "impressions": imps, "position": round(sum(r[5] * r[3] for r in rows) / imps, 2) if imps else None,
                "pages": len({r[1] for r in rows}), "period": f"{sync.get('start_date')} to {sync.get('end_date')}"}
    except Exception:
        return None


@router.post("/{opportunity_id}/baseline")
async def lock_measurement_baseline(opportunity_id: int, data: ActionIn):
    """Freeze the numbers to measure against. Only an approved opportunity can have one."""
    item = _require_opportunity(opportunity_id)
    baseline = {
        "keyword": item["keyword"], "score": item["score"], "high_priority": item["high_priority"], "impressions": item["impressions"],
        "factors": [{"label": f["label"], "rating": f["rating"]} for f in item["factors"]], "search_console": _gsc_snapshot(item["keyword"]),
    }
    try:
        state, entry = gov.lock_baseline(opportunity_id, data.reviewer_name, data.note, baseline)
    except gov.GovernanceError as e:
        raise _http(e)
    return {"status": "success", "opportunity": _with_state(item, state), "entry": entry}


@router.post("/{opportunity_id}/complete")
async def mark_completed(opportunity_id: int, data: ActionIn):
    item = _require_opportunity(opportunity_id)
    try:
        state, entry = gov.complete(opportunity_id, data.reviewer_name, data.note)
    except gov.GovernanceError as e:
        raise _http(e)
    return {"status": "success", "opportunity": _with_state(item, state), "entry": entry}

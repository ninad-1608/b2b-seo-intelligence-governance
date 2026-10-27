"""Custom Business Priorities: persisted in a local SQLite file and scored with the 4-factor opportunity formula.

The chosen priority level sets the Business Priority factor (High 5, Medium 3, Low 1). The other three factors cannot be known from
the form, so they default to a neutral 3 unless the user rates them explicitly.
"""
import datetime
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field, field_validator

from scoring_router import FactorRatings, score_opportunity

router = APIRouter(prefix="/api/v1/priorities", tags=["Business Priorities"])

DB_PATH = Path(__file__).resolve().parent / "priorities.db"
LEVEL_RATING = {"High": 5, "Medium": 3, "Low": 1}
DEFAULT_RATING = 3
MAX_PRIORITIES = 200
CUSTOM_ID_OFFSET = 1_000_000  # shared with opportunities_router: custom priorities share the opportunity id space


class PriorityIn(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    keyword: str = Field(min_length=2, max_length=150)
    impressions: int = Field(default=0, ge=0, le=1_000_000_000)
    level: Literal["High", "Medium", "Low"]
    # optional explicit ratings for the three factors the form cannot infer
    first_party_evidence: int | None = Field(default=None, ge=1, le=5)
    ranking_opportunity: int | None = Field(default=None, ge=1, le=5)
    query_url_evidence: int | None = Field(default=None, ge=1, le=5)

    @field_validator("name", "keyword")
    @classmethod
    def _clean(cls, v: str) -> str:
        v = " ".join(v.split())
        if len(v) < 2:
            raise ValueError("must be at least 2 characters")
        return v


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS priorities (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL, keyword TEXT NOT NULL, impressions INTEGER NOT NULL DEFAULT 0, level TEXT NOT NULL,
            first_party_evidence INTEGER, ranking_opportunity INTEGER, query_url_evidence INTEGER,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        )
        """
    )
    return conn


_COLS = "id, name, keyword, impressions, level, first_party_evidence, ranking_opportunity, query_url_evidence, created_at, updated_at"


def _item(r: tuple) -> dict:
    fpe, ro, qu = (x if x is not None else DEFAULT_RATING for x in r[5:8])
    scored = score_opportunity(
        FactorRatings(business_priority=LEVEL_RATING[r[4]], first_party_evidence=fpe, ranking_opportunity=ro, query_url_evidence=qu)
    )
    return {
        "id": r[0], "name": r[1], "keyword": r[2], "impressions": r[3], "level": r[4],
        "rated": any(x is not None for x in r[5:8]),  # False: three of the four factors are neutral defaults
        "created_at": r[8], "updated_at": r[9],
        **scored,
    }


def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def _check_duplicate(conn: sqlite3.Connection, keyword: str, exclude_id: int | None) -> None:
    row = conn.execute("SELECT id FROM priorities WHERE lower(keyword) = lower(?) AND id != ?", (keyword, exclude_id or -1)).fetchone()
    if row:
        raise HTTPException(status_code=409, detail="A business priority for this keyword already exists.")


@router.get("")
async def list_priorities():
    with closing(_db()) as conn:
        rows = conn.execute(f"SELECT {_COLS} FROM priorities ORDER BY id DESC").fetchall()
    return {"status": "success", "items": [_item(r) for r in rows]}


@router.post("", status_code=201)
async def create_priority(data: PriorityIn):
    with closing(_db()) as conn, conn:
        if conn.execute("SELECT COUNT(*) FROM priorities").fetchone()[0] >= MAX_PRIORITIES:
            raise HTTPException(status_code=409, detail=f"You can keep at most {MAX_PRIORITIES} custom priorities. Delete some first.")
        _check_duplicate(conn, data.keyword, None)
        now = _now()
        cur = conn.execute(
            "INSERT INTO priorities (name, keyword, impressions, level, first_party_evidence, ranking_opportunity, query_url_evidence, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (data.name, data.keyword, data.impressions, data.level, data.first_party_evidence, data.ranking_opportunity, data.query_url_evidence, now, now),
        )
        row = conn.execute(f"SELECT {_COLS} FROM priorities WHERE id = ?", (cur.lastrowid,)).fetchone()
    return _item(row)


@router.put("/{priority_id}")
async def update_priority(priority_id: int, data: PriorityIn):
    import governance_store as gov  # local import: governance depends on nothing here, but keep module load order simple

    with closing(_db()) as conn, conn:
        if not conn.execute("SELECT 1 FROM priorities WHERE id = ?", (priority_id,)).fetchone():
            raise HTTPException(status_code=404, detail="That priority no longer exists.")
        _check_duplicate(conn, data.keyword, priority_id)
        try:
            gov.reset_for_edit(CUSTOM_ID_OFFSET + priority_id)  # an old verdict must not cover changed content (frozen once measuring)
        except gov.GovernanceError as e:
            raise HTTPException(status_code=e.status_code, detail=e.detail)
        conn.execute(
            "UPDATE priorities SET name=?, keyword=?, impressions=?, level=?, first_party_evidence=?, ranking_opportunity=?, query_url_evidence=?, updated_at=? WHERE id=?",
            (data.name, data.keyword, data.impressions, data.level, data.first_party_evidence, data.ranking_opportunity, data.query_url_evidence, _now(), priority_id),
        )
        row = conn.execute(f"SELECT {_COLS} FROM priorities WHERE id = ?", (priority_id,)).fetchone()
    return _item(row)


@router.delete("/{priority_id}", status_code=204)
async def delete_priority(priority_id: int):
    import governance_store as gov

    with closing(_db()) as conn, conn:
        row = conn.execute("SELECT name, keyword FROM priorities WHERE id = ?", (priority_id,)).fetchone()
        if conn.execute("DELETE FROM priorities WHERE id = ?", (priority_id,)).rowcount == 0:
            raise HTTPException(status_code=404, detail="That priority no longer exists.")
    if gov.get_state(CUSTOM_ID_OFFSET + priority_id)["status"] != "Proposed":  # only reviewed items have a trail worth closing
        gov.log_event(CUSTOM_ID_OFFSET + priority_id, "deleted", "system", "The opportunity was deleted. Its history is kept.", {"name": row[0], "keyword": row[1]})
    return Response(status_code=204)

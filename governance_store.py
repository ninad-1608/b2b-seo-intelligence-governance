"""'AI drafts, humans decide': the review state machine and its append-only audit trail.

States:  Proposed -> (human verdict) -> Approved | Needs changes | Rejected
         Approved  -> baseline locked -> Measuring -> Completed        (Approved -> Completed is also allowed)
A verdict can be changed (re-review) until measurement starts. Measuring and Completed can only ever be reached from Approved, so
"has an approval" = status in {Approved, Measuring, Completed}; that is the gate for every downstream action.

The history table is append-only (SQL triggers refuse UPDATE and DELETE) and hash-chained: each row's hash covers the previous row's
hash, so editing or removing a row in the middle of the log is detectable with verify_chain(). The reviewer name is self-declared:
this app has no accounts, so the log records who SAID they decided, not an authenticated identity.
"""
import datetime
import hashlib
import json
import re
import sqlite3
from contextlib import closing, contextmanager
from pathlib import Path

from paths import DATA_DIR

DB_PATH = DATA_DIR / "governance.db"  # never commit this file

STATUSES = ("Proposed", "Approved", "Needs changes", "Rejected", "Measuring", "Completed")
APPROVED_LINEAGE = {"Approved", "Measuring", "Completed"}
REVIEW_CLOSED = {"Measuring", "Completed"}  # measurement has started: the verdict is frozen
VERDICT_STATUS = {"Approved": "Approved", "Needs changes": "Needs changes", "Reject": "Rejected"}
GENESIS = "GENESIS"
COMMENT_MIN, COMMENT_MAX = 8, 2000
RESERVED_NAMES = {"system", "ai", "bot", "assistant", "claude", "chatgpt", "gpt", "automation", "auto", "n/a", "na", "none", "unknown", "anonymous"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS governance_state (
    opportunity_id INTEGER PRIMARY KEY, status TEXT NOT NULL, reviewer TEXT, verdict TEXT, comment TEXT, decided_at TEXT,
    baseline_json TEXT, baseline_locked_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS governance_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, opportunity_id INTEGER NOT NULL, event TEXT NOT NULL, actor TEXT NOT NULL,
    from_status TEXT, to_status TEXT, verdict TEXT, comment TEXT, details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gov_history_opp ON governance_history(opportunity_id, id);
CREATE TRIGGER IF NOT EXISTS governance_history_no_update BEFORE UPDATE ON governance_history
BEGIN SELECT RAISE(ABORT, 'the governance history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS governance_history_no_delete BEFORE DELETE ON governance_history
BEGIN SELECT RAISE(ABORT, 'the governance history is append-only'); END;
"""


class GovernanceError(Exception):
    """A rule was broken; carries the HTTP status the API should answer with."""

    def __init__(self, status_code: int, detail: str, code: str = "governance") -> None:
        super().__init__(detail)
        self.status_code, self.detail, self.code = status_code, detail, code


def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, isolation_level=None)  # autocommit; transactions are explicit below
    conn.executescript(SCHEMA)
    return conn


@contextmanager
def _tx():
    conn = _connect()
    try:
        conn.execute("BEGIN IMMEDIATE")  # takes the write lock first: the hash chain must be appended atomically
        yield conn
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Validation helpers (used by the API models)
# ---------------------------------------------------------------------------
def clean_reviewer_name(name: str) -> str:
    name = " ".join(re.sub(r"[\x00-\x1f\x7f]", " ", name).split())
    if len(name) < 2 or len(name) > 80:
        raise ValueError("Enter the reviewer's name (2 to 80 characters).")
    if sum(ch.isalpha() for ch in name) < 2:
        raise ValueError("The reviewer name must contain letters.")
    if name.lower() in RESERVED_NAMES:
        raise ValueError("Enter a real person's name: decisions must be signed by a named human, not by a system or placeholder.")
    return name


def clean_comment(text: str, required: bool = True) -> str:
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text).strip()
    if required and len(text) < COMMENT_MIN:
        raise ValueError(f"A reviewer comment is required (at least {COMMENT_MIN} characters) so the decision can be understood later.")
    if len(text) > COMMENT_MAX:
        raise ValueError(f"Keep the comment under {COMMENT_MAX} characters.")
    return text


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------
def _state_row(row: tuple | None, op_id: int) -> dict:
    if not row:
        return {"opportunity_id": op_id, "status": "Proposed", "reviewer": None, "verdict": None, "comment": None, "decided_at": None,
                "baseline": None, "baseline_locked_at": None, "completed_at": None, "updated_at": None}
    return {"opportunity_id": row[0], "status": row[1], "reviewer": row[2], "verdict": row[3], "comment": row[4], "decided_at": row[5],
            "baseline": json.loads(row[6]) if row[6] else None, "baseline_locked_at": row[7], "completed_at": row[8], "updated_at": row[9]}


_STATE_COLS = "opportunity_id, status, reviewer, verdict, comment, decided_at, baseline_json, baseline_locked_at, completed_at, updated_at"


def default_state(op_id: int) -> dict:
    return _state_row(None, op_id)


def get_state(op_id: int) -> dict:
    with closing(_connect()) as conn:
        return _state_row(conn.execute(f"SELECT {_STATE_COLS} FROM governance_state WHERE opportunity_id = ?", (op_id,)).fetchone(), op_id)


def all_states() -> dict[int, dict]:
    with closing(_connect()) as conn:
        return {r[0]: _state_row(r, r[0]) for r in conn.execute(f"SELECT {_STATE_COLS} FROM governance_state")}


def require_lineage(op_id: int) -> dict:
    """Gate for downstream work (briefs, measurement): there must be a standing human approval."""
    st = get_state(op_id)
    if st["status"] not in APPROVED_LINEAGE:
        hint = {
            "Proposed": "No reviewer has signed it off yet.",
            "Needs changes": "A reviewer asked for changes; it needs a new review.",
            "Rejected": "A reviewer rejected it.",
        }.get(st["status"], "")
        raise GovernanceError(403, f"Locked: this opportunity is '{st['status']}'. {hint} A named reviewer must approve it first.".replace("  ", " "), "locked")
    return st


# ---------------------------------------------------------------------------
# Writing (every change appends to the history in the same transaction)
# ---------------------------------------------------------------------------
def _canonical(row: dict) -> str:
    return json.dumps(row, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _hash_payload(opportunity_id, event, actor, from_status, to_status, verdict, comment, details, created_at) -> dict:
    return {"opportunity_id": opportunity_id, "event": event, "actor": actor, "from_status": from_status, "to_status": to_status,
            "verdict": verdict, "comment": comment, "details": details, "created_at": created_at}


def _append(conn: sqlite3.Connection, op_id: int, event: str, actor: str, from_status: str | None, to_status: str | None,
            verdict: str | None = None, comment: str | None = None, details: dict | None = None) -> dict:
    details = details or {}
    last = conn.execute("SELECT hash FROM governance_history ORDER BY id DESC LIMIT 1").fetchone()
    prev = last[0] if last else GENESIS
    created = _now()
    digest = hashlib.sha256((prev + _canonical(_hash_payload(op_id, event, actor, from_status, to_status, verdict, comment, details, created))).encode()).hexdigest()
    cur = conn.execute(
        "INSERT INTO governance_history (opportunity_id, event, actor, from_status, to_status, verdict, comment, details_json, created_at, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (op_id, event, actor, from_status, to_status, verdict, comment, json.dumps(details, sort_keys=True), created, prev, digest),
    )
    return {"id": cur.lastrowid, "opportunity_id": op_id, "event": event, "actor": actor, "from_status": from_status, "to_status": to_status,
            "verdict": verdict, "comment": comment, "details": details, "created_at": created, "hash": digest}


def _upsert(conn: sqlite3.Connection, op_id: int, **fields) -> None:
    cur = conn.execute("SELECT 1 FROM governance_state WHERE opportunity_id = ?", (op_id,)).fetchone()
    fields["updated_at"] = _now()
    if cur:
        conn.execute(f"UPDATE governance_state SET {', '.join(f'{k} = ?' for k in fields)} WHERE opportunity_id = ?", (*fields.values(), op_id))
    else:
        fields.setdefault("status", "Proposed")
        cols = ["opportunity_id", *fields]
        conn.execute(f"INSERT INTO governance_state ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})", (op_id, *fields.values()))


def _current(conn: sqlite3.Connection, op_id: int) -> dict:
    return _state_row(conn.execute(f"SELECT {_STATE_COLS} FROM governance_state WHERE opportunity_id = ?", (op_id,)).fetchone(), op_id)


def decide(op_id: int, reviewer: str, verdict: str, comment: str) -> tuple[dict, dict]:
    """Record a human verdict. The timestamp is set here, never by the client."""
    if verdict not in VERDICT_STATUS:
        raise GovernanceError(422, "Verdict must be Approved, Needs changes or Reject.", "bad_verdict")
    reviewer, comment = clean_reviewer_name(reviewer), clean_comment(comment)
    with _tx() as conn:
        cur = _current(conn, op_id)
        if cur["status"] in REVIEW_CLOSED:
            raise GovernanceError(409, f"Review is closed: measurement has already started ('{cur['status']}'). The verdict can no longer be changed.", "closed")
        new = VERDICT_STATUS[verdict]
        now = _now()
        _upsert(conn, op_id, status=new, reviewer=reviewer, verdict=verdict, comment=comment, decided_at=now)
        entry = _append(conn, op_id, "decision", reviewer, cur["status"], new, verdict, comment, {"re_review": cur["status"] != "Proposed"})
        return _current(conn, op_id), entry


def lock_baseline(op_id: int, reviewer: str, note: str, baseline: dict) -> tuple[dict, dict]:
    reviewer, note = clean_reviewer_name(reviewer), clean_comment(note, required=False)
    with _tx() as conn:
        cur = _current(conn, op_id)
        if cur["status"] == "Measuring":
            raise GovernanceError(409, "The measurement baseline is already locked.", "already_locked")
        if cur["status"] == "Completed":
            raise GovernanceError(409, "This opportunity is already completed, so a baseline can no longer be locked.", "already_completed")
        if cur["status"] != "Approved":
            raise GovernanceError(403, f"Locked: a baseline can only be locked once a named reviewer has approved the opportunity (it is '{cur['status']}').", "locked")
        now = _now()
        _upsert(conn, op_id, status="Measuring", baseline_json=json.dumps(baseline, sort_keys=True), baseline_locked_at=now)
        entry = _append(conn, op_id, "baseline_locked", reviewer, "Approved", "Measuring", None, note or None, {"baseline": baseline})
        return _current(conn, op_id), entry


def complete(op_id: int, reviewer: str, note: str) -> tuple[dict, dict]:
    reviewer, note = clean_reviewer_name(reviewer), clean_comment(note, required=False)
    with _tx() as conn:
        cur = _current(conn, op_id)
        if cur["status"] == "Completed":
            raise GovernanceError(409, "This opportunity is already completed.", "already_completed")
        if cur["status"] not in ("Approved", "Measuring"):
            raise GovernanceError(403, f"Locked: only an approved opportunity can be marked completed (it is '{cur['status']}').", "locked")
        now = _now()
        _upsert(conn, op_id, status="Completed", completed_at=now)
        entry = _append(conn, op_id, "completed", reviewer, cur["status"], "Completed", None, note or None, {"baseline_was_locked": cur["status"] == "Measuring"})
        return _current(conn, op_id), entry


def reset_for_edit(op_id: int) -> bool:
    """The opportunity's content changed after review: an old verdict no longer covers what is being proposed."""
    with _tx() as conn:
        cur = _current(conn, op_id)
        if cur["status"] in REVIEW_CLOSED:
            raise GovernanceError(409, f"This opportunity is '{cur['status']}': its content is frozen so the measurement baseline stays valid.", "frozen")
        if cur["status"] == "Proposed":
            return False
        _upsert(conn, op_id, status="Proposed", reviewer=None, verdict=None, comment=None, decided_at=None)
        _append(conn, op_id, "reset", "system", cur["status"], "Proposed", None,
                "The opportunity was edited after review, so the earlier verdict no longer applies. It needs a new review.",
                {"previous_reviewer": cur["reviewer"], "previous_verdict": cur["verdict"]})
        return True


def log_event(op_id: int, event: str, actor: str, comment: str | None = None, details: dict | None = None) -> dict:
    """Record something that happened that does not change the status (an AI draft was produced, the opportunity was deleted)."""
    with _tx() as conn:
        cur = _current(conn, op_id)
        return _append(conn, op_id, event, actor, cur["status"], cur["status"], None, comment, details)


# ---------------------------------------------------------------------------
# History + integrity
# ---------------------------------------------------------------------------
def history(op_id: int, limit: int = 200) -> list[dict]:
    with closing(_connect()) as conn:
        rows = conn.execute(
            "SELECT id, opportunity_id, event, actor, from_status, to_status, verdict, comment, details_json, created_at, hash FROM governance_history WHERE opportunity_id = ? ORDER BY id DESC LIMIT ?",
            (op_id, limit),
        ).fetchall()
    return [{"id": r[0], "opportunity_id": r[1], "event": r[2], "actor": r[3], "from_status": r[4], "to_status": r[5], "verdict": r[6],
             "comment": r[7], "details": json.loads(r[8]), "created_at": r[9], "hash": r[10]} for r in rows]


def verify_chain() -> dict:
    """Recompute every hash in order. Detects an edited or removed row in the middle of the log."""
    with closing(_connect()) as conn:
        rows = conn.execute(
            "SELECT id, opportunity_id, event, actor, from_status, to_status, verdict, comment, details_json, created_at, prev_hash, hash FROM governance_history ORDER BY id"
        ).fetchall()
    prev = GENESIS
    for r in rows:
        payload = _hash_payload(r[1], r[2], r[3], r[4], r[5], r[6], r[7], json.loads(r[8]), r[9])
        expected = hashlib.sha256((prev + _canonical(payload)).encode()).hexdigest()
        if r[10] != prev or r[11] != expected:
            return {"ok": False, "entries": len(rows), "first_bad_id": r[0]}
        prev = r[11]
    return {"ok": True, "entries": len(rows), "first_bad_id": None}

"""On-demand Live Google Search Console & GA4 connector.

OAuth 2.0 authorization-code flow with PKCE and a single-use `state`. The refresh token is encrypted with Fernet before it
is written to a local SQLite file, and no endpoint ever returns a token. Synced Search Console rows are stored locally so the
existing dashboard analyses (cannibalization, content decay) can run on real data.

Single-user design: this app has no login, so the connection is global to the server. Do not expose this API to untrusted
networks without adding authentication in front of it.

Setup (Google Cloud Console): create an OAuth client of type "Web application", add GOOGLE_REDIRECT_URI as an authorised
redirect URI, enable the "Search Console API" and "Google Analytics Admin API", then set in .env:
    GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI (default http://localhost:3000/gsc/callback)
Optional: GSC_TOKEN_ENCRYPTION_KEY (a Fernet key). If unset, a key file is generated next to this module.
"""
import asyncio
import base64
import datetime
import hashlib
import json
import os
import secrets
import sqlite3
import threading
import time
from contextlib import closing
from pathlib import Path
from urllib.parse import quote, urlencode

import requests
from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field, field_validator

from decay_router import DecayRequest, MetricRow, _run_decay

router = APIRouter(prefix="/api/v1/gsc", tags=["Google Connector"])

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "gsc_connector.db"  # never commit this file
KEY_PATH = BASE_DIR / "gsc_connector.key"  # never commit this file

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
REVOKE_URL = "https://oauth2.googleapis.com/revoke"
GSC_SITES_URL = "https://www.googleapis.com/webmasters/v3/sites"
GA4_SUMMARIES_URL = "https://analyticsadmin.googleapis.com/v1beta/accountSummaries"

SCOPE_GSC = "https://www.googleapis.com/auth/webmasters.readonly"
SCOPE_GA4 = "https://www.googleapis.com/auth/analytics.readonly"
SCOPES = [SCOPE_GSC, SCOPE_GA4]

DEFAULT_REDIRECT = "http://localhost:3000/gsc/callback"
STATE_TTL_SECONDS = 600
MAX_PENDING_STATES = 20
HTTP_TIMEOUT = 30
ROW_LIMIT = 25_000  # Search Analytics API maximum rows per request
MAX_RANGE_DAYS = 480  # ~16 months, the GSC retention window
GSC_LAG_DAYS = 3  # recent days are incomplete; default sync ends this many days ago

_state_lock = threading.Lock()
_pending: dict[str, tuple[str, float]] = {}  # state -> (code_verifier, expires_at)
_token_lock = threading.Lock()
_access: dict = {"token": None, "expires_at": 0.0}


# ---------------------------------------------------------------------------
# Config, encryption, storage
# ---------------------------------------------------------------------------
def _config() -> dict:
    return {
        "client_id": os.getenv("GOOGLE_CLIENT_ID", "").strip(),
        "client_secret": os.getenv("GOOGLE_CLIENT_SECRET", "").strip(),
        "redirect_uri": os.getenv("GOOGLE_REDIRECT_URI", DEFAULT_REDIRECT).strip() or DEFAULT_REDIRECT,
    }


def _require_config() -> dict:
    cfg = _config()
    if not cfg["client_id"] or not cfg["client_secret"]:
        raise HTTPException(
            status_code=503,
            detail="Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the backend .env file.",
        )
    return cfg


_fernet_cache: Fernet | None = None


def _fernet() -> Fernet:
    global _fernet_cache
    if _fernet_cache is not None:
        return _fernet_cache
    key = os.getenv("GSC_TOKEN_ENCRYPTION_KEY", "").strip().encode()
    if not key:
        if KEY_PATH.exists():
            key = KEY_PATH.read_bytes().strip()
        else:
            key = Fernet.generate_key()
            fd = os.open(KEY_PATH, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as f:
                f.write(key)
    try:
        _fernet_cache = Fernet(key)
    except (ValueError, TypeError):
        raise HTTPException(status_code=500, detail="The token encryption key is invalid (it must be a Fernet key).")
    return _fernet_cache


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS connection (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            refresh_token_enc BLOB NOT NULL,
            scopes TEXT NOT NULL,
            connected_at TEXT NOT NULL,
            site_url TEXT,
            ga4_property TEXT,
            ga4_name TEXT
        );
        CREATE TABLE IF NOT EXISTS sync_meta (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            site_url TEXT, start_date TEXT, end_date TEXT, prev_start TEXT, prev_end TEXT,
            rows_current INTEGER, rows_previous INTEGER, truncated INTEGER, synced_at TEXT
        );
        CREATE TABLE IF NOT EXISTS gsc_rows (
            period TEXT NOT NULL, query TEXT NOT NULL, page TEXT NOT NULL,
            clicks INTEGER NOT NULL, impressions INTEGER NOT NULL, ctr REAL NOT NULL, position REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_gsc_rows_period ON gsc_rows(period);
        CREATE TABLE IF NOT EXISTS health (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        """
    )
    return conn


def set_health(key: str, payload: dict | None) -> None:
    """Remember (or clear, with None) the last auth/sync failure so the dashboard can say so even after a restart."""
    with closing(_db()) as db, db:
        if payload is None:
            db.execute("DELETE FROM health WHERE key = ?", (key,))
        else:
            db.execute(
                "INSERT INTO health VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, json.dumps({"at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"), **payload})),
            )


def get_health(key: str) -> dict | None:
    with closing(_db()) as db:
        row = db.execute("SELECT value FROM health WHERE key = ?", (key,)).fetchone()
    return json.loads(row[0]) if row else None


def _get_connection() -> dict | None:
    with closing(_db()) as conn:
        row = conn.execute("SELECT refresh_token_enc, scopes, connected_at, site_url, ga4_property, ga4_name FROM connection WHERE id = 1").fetchone()
    if not row:
        return None
    return {"refresh_token_enc": row[0], "scopes": row[1].split(), "connected_at": row[2], "site_url": row[3], "ga4_property": row[4], "ga4_name": row[5]}


def _refresh_token() -> str:
    conn = _get_connection()
    if not conn:
        raise HTTPException(status_code=401, detail="Not connected to Google. Connect your account first.")
    try:
        return _fernet().decrypt(conn["refresh_token_enc"]).decode()
    except InvalidToken:
        set_health("auth_error", {"reason": "undecryptable"})
        _clear_connection()
        raise HTTPException(status_code=401, detail="The stored credentials could not be decrypted (the encryption key changed). Please reconnect.")


def _clear_connection(keep_rows: bool = False) -> None:
    with closing(_db()) as conn, conn:
        conn.execute("DELETE FROM connection")
        if not keep_rows:
            conn.execute("DELETE FROM gsc_rows")
            conn.execute("DELETE FROM sync_meta")
    with _token_lock:
        _access.update(token=None, expires_at=0.0)


def load_rows(period: str) -> list[tuple[str, str, int, int, float, float]]:
    """(query, page, clicks, impressions, ctr, position) for 'current' or 'previous'."""
    with closing(_db()) as conn:
        return conn.execute("SELECT query, page, clicks, impressions, ctr, position FROM gsc_rows WHERE period = ?", (period,)).fetchall()


# ---------------------------------------------------------------------------
# Google HTTP helpers
# ---------------------------------------------------------------------------
def _google_error(resp: requests.Response, what: str) -> HTTPException:
    try:
        msg = (resp.json().get("error") or {}).get("message", "")
        if not isinstance(msg, str):
            msg = ""
    except ValueError:
        msg = ""
    msg = " ".join(msg.split())[:300]
    if resp.status_code == 401:
        _clear_connection(keep_rows=True)
        return HTTPException(status_code=401, detail="Google rejected the credentials. Please reconnect your account.")
    if resp.status_code == 403:
        return HTTPException(status_code=403, detail=f"Google denied access to {what}. {msg}".strip())
    if resp.status_code == 429:
        return HTTPException(status_code=429, detail="Google API quota exceeded. Try again later.")
    return HTTPException(status_code=502, detail=f"Google returned HTTP {resp.status_code} for {what}. {msg}".strip())


def _access_token() -> str:
    with _token_lock:
        if _access["token"] and _access["expires_at"] - time.time() > 60:
            return _access["token"]
    cfg = _require_config()
    refresh = _refresh_token()
    try:
        resp = requests.post(
            TOKEN_URL,
            data={"client_id": cfg["client_id"], "client_secret": cfg["client_secret"], "refresh_token": refresh, "grant_type": "refresh_token"},
            timeout=HTTP_TIMEOUT,
        )
    except requests.RequestException:
        raise HTTPException(status_code=502, detail="Could not reach Google to refresh access.")
    if resp.status_code != 200:
        err = ""
        try:
            err = resp.json().get("error", "")
        except ValueError:
            pass
        if err == "invalid_grant":  # revoked, expired or password-changed
            set_health("auth_error", {"reason": "invalid_grant"})
            _clear_connection(keep_rows=True)
            raise HTTPException(status_code=401, detail="Google access was revoked or has expired. Please reconnect your account.")
        raise HTTPException(status_code=502, detail=f"Google refused to refresh access (HTTP {resp.status_code}).")
    data = resp.json()
    if get_health("auth_error"):
        set_health("auth_error", None)
    with _token_lock:
        _access.update(token=data["access_token"], expires_at=time.time() + int(data.get("expires_in", 3600)))
        return _access["token"]


def _gget(url: str, what: str, params: dict | None = None) -> dict:
    try:
        resp = requests.get(url, headers={"Authorization": f"Bearer {_access_token()}"}, params=params, timeout=HTTP_TIMEOUT)
    except requests.RequestException:
        raise HTTPException(status_code=502, detail=f"Could not reach Google for {what}.")
    if resp.status_code != 200:
        raise _google_error(resp, what)
    return resp.json()


def _gpost(url: str, what: str, body: dict) -> dict:
    try:
        resp = requests.post(url, headers={"Authorization": f"Bearer {_access_token()}"}, json=body, timeout=HTTP_TIMEOUT)
    except requests.RequestException:
        raise HTTPException(status_code=502, detail=f"Could not reach Google for {what}.")
    if resp.status_code != 200:
        raise _google_error(resp, what)
    return resp.json()


def _require_scope(scope: str, label: str) -> None:
    conn = _get_connection()
    if not conn or scope not in conn["scopes"]:
        raise HTTPException(status_code=403, detail=f"{label} access was not granted. Reconnect and tick the {label} permission on Google's consent screen.")


# ---------------------------------------------------------------------------
# Status / OAuth
# ---------------------------------------------------------------------------
def _status() -> dict:
    cfg = _config()
    conn = _get_connection()
    with closing(_db()) as db:
        sync = db.execute("SELECT site_url, start_date, end_date, prev_start, prev_end, rows_current, rows_previous, truncated, synced_at FROM sync_meta WHERE id = 1").fetchone()
    return {
        "configured": bool(cfg["client_id"] and cfg["client_secret"]),
        "redirect_uri": cfg["redirect_uri"],
        "connected": conn is not None,
        "scopes": {"gsc": bool(conn and SCOPE_GSC in conn["scopes"]), "ga4": bool(conn and SCOPE_GA4 in conn["scopes"])},
        "connected_at": conn["connected_at"] if conn else None,
        "site_url": conn["site_url"] if conn else None,
        "ga4_property": conn["ga4_property"] if conn else None,
        "ga4_name": conn["ga4_name"] if conn else None,
        "last_sync": None if not sync else {
            "site_url": sync[0], "start_date": sync[1], "end_date": sync[2], "previous_start": sync[3], "previous_end": sync[4],
            "rows_current": sync[5], "rows_previous": sync[6], "truncated": bool(sync[7]), "synced_at": sync[8],
        },
    }


@router.get("/status")
async def gsc_status():
    """Connection state for the UI. Never includes credentials."""
    return _status()


@router.get("/auth-url")
async def gsc_auth_url():
    """Google consent URL for Search Console + GA4 (read-only), with PKCE and a single-use state."""
    cfg = _require_config()
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(32)
    now = time.time()
    with _state_lock:
        for s in [s for s, (_, exp) in _pending.items() if exp < now]:
            del _pending[s]
        if len(_pending) >= MAX_PENDING_STATES:
            del _pending[min(_pending, key=lambda s: _pending[s][1])]
        _pending[state] = (verifier, now + STATE_TTL_SECONDS)
    params = {
        "client_id": cfg["client_id"],
        "redirect_uri": cfg["redirect_uri"],
        "response_type": "code",
        "scope": " ".join(SCOPES),
        "access_type": "offline",  # request a refresh token
        "prompt": "consent",  # make Google return the refresh token every time
        "include_granted_scopes": "true",
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    return {"auth_url": f"{AUTH_URL}?{urlencode(params)}", "redirect_uri": cfg["redirect_uri"], "scopes": SCOPES}


class CallbackRequest(BaseModel):
    code: str = Field(min_length=4, max_length=2048)
    state: str = Field(min_length=8, max_length=256)


@router.post("/callback")
async def gsc_callback(data: CallbackRequest):
    """Exchange the authorization code for tokens; store the refresh token encrypted."""
    cfg = _require_config()
    with _state_lock:
        entry = _pending.pop(data.state, None)  # single use: a replayed state is rejected
    if not entry or entry[1] < time.time():
        raise HTTPException(status_code=400, detail="This sign-in attempt is invalid or has expired. Start the connection again.")
    try:
        resp = requests.post(
            TOKEN_URL,
            data={
                "client_id": cfg["client_id"], "client_secret": cfg["client_secret"], "code": data.code,
                "code_verifier": entry[0], "grant_type": "authorization_code", "redirect_uri": cfg["redirect_uri"],
            },
            timeout=HTTP_TIMEOUT,
        )
    except requests.RequestException:
        raise HTTPException(status_code=502, detail="Could not reach Google to complete sign-in.")
    if resp.status_code != 200:
        desc = ""
        try:
            body = resp.json()
            desc = " ".join(str(body.get("error_description") or body.get("error") or "").split())[:200]
        except ValueError:
            pass
        raise HTTPException(status_code=400, detail=f"Google rejected the sign-in code. {desc}".strip())

    tok = resp.json()
    refresh = tok.get("refresh_token")
    scopes = str(tok.get("scope", "")).split()
    if not refresh:
        raise HTTPException(
            status_code=400,
            detail="Google did not return a refresh token. Remove this app at myaccount.google.com/permissions and connect again.",
        )
    if SCOPE_GSC not in scopes and SCOPE_GA4 not in scopes:
        raise HTTPException(status_code=400, detail="No Search Console or Analytics permission was granted.")

    encrypted = _fernet().encrypt(refresh.encode())
    with closing(_db()) as db, db:
        db.execute("DELETE FROM connection")
        db.execute(
            "INSERT INTO connection (id, refresh_token_enc, scopes, connected_at) VALUES (1, ?, ?, ?)",
            (encrypted, " ".join(scopes), datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")),
        )
    with _token_lock:
        _access.update(token=tok.get("access_token"), expires_at=time.time() + int(tok.get("expires_in", 3600)))
    set_health("auth_error", None)
    return _status()


@router.post("/disconnect")
async def gsc_disconnect():
    """Revoke the grant at Google (best effort) and delete the stored credentials and synced data."""
    conn = _get_connection()
    if conn:
        try:
            token = _fernet().decrypt(conn["refresh_token_enc"]).decode()
            requests.post(REVOKE_URL, data={"token": token}, timeout=HTTP_TIMEOUT)
        except (InvalidToken, requests.RequestException):
            pass  # still delete locally
    _clear_connection()
    set_health("auth_error", None)  # a deliberate disconnect is not a problem to report
    set_health("sync_error", None)
    return _status()


# ---------------------------------------------------------------------------
# Properties
# ---------------------------------------------------------------------------
@router.get("/properties")
async def gsc_properties():
    """Verified Search Console sites and GA4 properties for the connected account."""
    conn = _get_connection()
    if not conn:
        raise HTTPException(status_code=401, detail="Not connected to Google. Connect your account first.")
    out: dict = {"gsc": {"sites": [], "error": None}, "ga4": {"properties": [], "error": None}}

    def run_gsc() -> None:
        _require_scope(SCOPE_GSC, "Search Console")
        data = _gget(GSC_SITES_URL, "the Search Console site list")
        for s in data.get("siteEntry", []):
            if s.get("permissionLevel") == "siteUnverifiedUser":
                continue  # only verified sites can be queried
            url = s.get("siteUrl", "")
            out["gsc"]["sites"].append({"site_url": url, "permission": s.get("permissionLevel"), "type": "domain" if url.startswith("sc-domain:") else "url-prefix"})
        out["gsc"]["sites"].sort(key=lambda s: s["site_url"])

    def run_ga4() -> None:
        _require_scope(SCOPE_GA4, "Google Analytics")
        token = None
        for _ in range(5):
            data = _gget(GA4_SUMMARIES_URL, "the GA4 property list", {"pageSize": 200, **({"pageToken": token} if token else {})})
            for acct in data.get("accountSummaries", []):
                for p in acct.get("propertySummaries", []):
                    out["ga4"]["properties"].append({
                        "property_id": str(p.get("property", "")).removeprefix("properties/"),
                        "name": p.get("displayName", ""),
                        "account": acct.get("displayName", ""),
                    })
            token = data.get("nextPageToken")
            if not token:
                break

    for key, fn in (("gsc", run_gsc), ("ga4", run_ga4)):
        try:
            await asyncio.to_thread(fn)
        except HTTPException as e:
            if e.status_code == 401:
                raise  # credentials are gone: surface it
            out[key]["error"] = e.detail
    out["selected"] = {"site_url": conn["site_url"], "ga4_property": conn["ga4_property"], "ga4_name": conn["ga4_name"]}
    return out


class SelectRequest(BaseModel):
    site_url: str | None = Field(default=None, max_length=500)
    ga4_property: str | None = Field(default=None, max_length=40)
    ga4_name: str | None = Field(default=None, max_length=200)

    @field_validator("ga4_property")
    @classmethod
    def _digits(cls, v: str | None) -> str | None:
        if v is not None and not v.isdigit():
            raise ValueError("GA4 property id must be numeric")
        return v


@router.post("/select")
async def gsc_select(data: SelectRequest):
    """Remember the active Search Console site and/or GA4 property for display."""
    if not _get_connection():
        raise HTTPException(status_code=401, detail="Not connected to Google. Connect your account first.")
    with closing(_db()) as db, db:
        if data.site_url is not None:
            db.execute("UPDATE connection SET site_url = ? WHERE id = 1", (data.site_url,))
        if data.ga4_property is not None:
            db.execute("UPDATE connection SET ga4_property = ?, ga4_name = ? WHERE id = 1", (data.ga4_property, data.ga4_name))
    return _status()


# ---------------------------------------------------------------------------
# Sync
# ---------------------------------------------------------------------------
class SyncRequest(BaseModel):
    site_url: str = Field(min_length=4, max_length=500)
    start_date: datetime.date
    end_date: datetime.date
    compare_previous: bool = True  # also fetch the preceding period of equal length (feeds the Content Decay analysis)


def _search_analytics(site_url: str, start: datetime.date, end: datetime.date) -> tuple[list[tuple], bool]:
    url = f"https://www.googleapis.com/webmasters/v3/sites/{quote(site_url, safe='')}/searchAnalytics/query"
    body = {"startDate": start.isoformat(), "endDate": end.isoformat(), "dimensions": ["query", "page"], "rowLimit": ROW_LIMIT, "startRow": 0, "dataState": "final"}
    data = _gpost(url, "Search Console performance data", body)
    rows = []
    for r in data.get("rows", []):
        keys = r.get("keys", [])
        if len(keys) < 2:
            continue
        rows.append((str(keys[0]), str(keys[1]), int(r.get("clicks", 0)), int(r.get("impressions", 0)), float(r.get("ctr", 0.0)), float(r.get("position", 0.0))))
    return rows, len(rows) >= ROW_LIMIT


def _totals(rows: list[tuple]) -> dict:
    clicks, imps = sum(r[2] for r in rows), sum(r[3] for r in rows)
    pos = sum(r[5] * r[3] for r in rows) / imps if imps else 0.0
    return {"clicks": clicks, "impressions": imps, "ctr": round(clicks / imps, 4) if imps else 0.0, "position": round(pos, 2)}


@router.post("/sync")
async def gsc_sync(data: SyncRequest):
    """Fetch real Search Console performance data for the date range and make it the active dashboard dataset."""
    today = datetime.date.today()
    if data.end_date < data.start_date:
        raise HTTPException(status_code=422, detail="The end date must be on or after the start date.")
    if data.end_date > today:
        raise HTTPException(status_code=422, detail="The end date cannot be in the future.")
    days = (data.end_date - data.start_date).days + 1
    if days > MAX_RANGE_DAYS:
        raise HTTPException(status_code=422, detail=f"Choose a range of at most {MAX_RANGE_DAYS} days (Search Console keeps about 16 months).")
    _require_scope(SCOPE_GSC, "Search Console")

    prev_end = data.start_date - datetime.timedelta(days=1)
    prev_start = prev_end - datetime.timedelta(days=days - 1)

    def work() -> dict:
        cur, cur_trunc = _search_analytics(data.site_url, data.start_date, data.end_date)
        prev, prev_trunc = ([], False)
        if data.compare_previous:
            prev, prev_trunc = _search_analytics(data.site_url, prev_start, prev_end)
        synced_at = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
        with closing(_db()) as db, db:
            db.execute("DELETE FROM gsc_rows")
            db.executemany("INSERT INTO gsc_rows VALUES ('current', ?, ?, ?, ?, ?, ?)", cur)
            db.executemany("INSERT INTO gsc_rows VALUES ('previous', ?, ?, ?, ?, ?, ?)", prev)
            db.execute("DELETE FROM sync_meta")
            db.execute(
                "INSERT INTO sync_meta VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (data.site_url, data.start_date.isoformat(), data.end_date.isoformat(),
                 prev_start.isoformat() if data.compare_previous else None, prev_end.isoformat() if data.compare_previous else None,
                 len(cur), len(prev), int(cur_trunc or prev_trunc), synced_at),
            )
            db.execute("UPDATE connection SET site_url = ? WHERE id = 1", (data.site_url,))
        return {
            "rows_current": len(cur), "rows_previous": len(prev), "truncated": cur_trunc or prev_trunc,
            "totals_current": _totals(cur), "totals_previous": _totals(prev) if prev else None, "synced_at": synced_at,
        }

    try:
        result = await asyncio.to_thread(work)
    except HTTPException as e:
        set_health("sync_error", {"message": str(e.detail), "status": e.status_code, "site_url": data.site_url})
        if e.status_code == 401:
            set_health("auth_error", {"reason": "rejected"})
        raise
    except Exception as e:  # noqa: BLE001 - recorded, then re-raised unchanged
        set_health("sync_error", {"message": f"{type(e).__name__}: {e}"[:300], "site_url": data.site_url})
        raise
    set_health("sync_error", None)
    try:  # evidence gathered for the old rows no longer describes the new ones
        from cannibalization_validation import clear_evidence

        clear_evidence()
    except Exception:  # noqa: BLE001 - never fail a successful sync over this
        pass
    return {
        "status": "success",
        "site_url": data.site_url,
        "range": {"start": data.start_date.isoformat(), "end": data.end_date.isoformat(), "days": days},
        "previous_range": {"start": prev_start.isoformat(), "end": prev_end.isoformat()} if data.compare_previous else None,
        "row_limit": ROW_LIMIT,
        **result,
        "note": (
            f"Search Console returns up to {ROW_LIMIT:,} query+page rows per request, ordered by clicks"
            + (", so this dataset was truncated to the top rows." if result["truncated"] else ".")
            + " Rows exclude anonymized queries, so totals can be lower than the Search Console UI."
        ),
    }


# ---------------------------------------------------------------------------
# Analyses on the synced dataset
# ---------------------------------------------------------------------------
@router.get("/decay")
async def gsc_decay(min_prior_impressions: int = Query(500, ge=0), drop_threshold_pct: float = Query(20.0, ge=0, le=100)):
    """Content-decay analysis on the synced current vs previous period."""
    cur, prev = load_rows("current"), load_rows("previous")
    if not cur:
        raise HTTPException(status_code=404, detail="No synced Search Console data yet. Run a sync first.")
    if not prev:
        raise HTTPException(status_code=404, detail="The last sync did not include the previous period. Sync again with 'compare to previous period' enabled.")

    def to_rows(rows: list[tuple]) -> list[MetricRow]:
        return [MetricRow(url=r[1], query=r[0], impressions=r[3], clicks=r[2], average_position=max(0.0, r[5])) for r in rows]

    req = DecayRequest(previous=to_rows(prev), current=to_rows(cur), min_prior_impressions=min_prior_impressions, drop_threshold_pct=drop_threshold_pct)
    result = await asyncio.to_thread(_run_decay, req)
    status = _status()["last_sync"]
    result["source"] = {"previous": {"filename": f"{status['previous_start']} to {status['previous_end']}", "rows": len(prev), "skipped": 0},
                        "current": {"filename": f"{status['start_date']} to {status['end_date']}", "rows": len(cur), "skipped": 0}}
    return result

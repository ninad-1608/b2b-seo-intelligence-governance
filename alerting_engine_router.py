"""Volatility & automated alerting engine.

Checks (all evaluated against the data already in the app, never a live API call to Google):
  * volatility      synced Search Console period vs the previous period: clicks / impressions / CTR / query positions / page clicks
  * cannibalization queries newly split across several URLs
  * bot access      LLM crawler user-agents (HTTP status) and robots.txt rules, compared with the last known state
  * data            the Search Console snapshot itself getting stale

Every alert has a stable fingerprint. A condition that keeps firing updates the existing open alert in place (no repeat
notification); it notifies again only when new or escalated, and it is resolved automatically once it stops firing.
Webhook URLs are secrets: allowlisted to real Slack / Teams hosts, SSRF-checked, encrypted at rest and only ever returned masked.
"""
import asyncio
import datetime
import json
import re
import sqlite3
import threading
from contextlib import closing
from pathlib import Path

from paths import DATA_DIR
from typing import Literal
from urllib.parse import urlparse

import requests
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field, field_validator

from crawler_simulator_router import BOTS, BROWSER_UA, GATING_ROLES, ROBOTS_MAX_BYTES, evaluate_robots, fetch_as, parse_robots
from geo_router import FetchError, _assert_public_url
from cannibalization_validation import validate_split_map
from gsc_connector_router import _fernet, _get_connection, _status, load_rows

router = APIRouter(prefix="/alerts", tags=["Alerting"])  # app.py mounts it under /api/v1

DB_PATH = DATA_DIR / "alerts.db"  # never commit this file (holds encrypted webhook URLs)
SEVERITY_RANK = {"info": 1, "warning": 2, "critical": 3}
MAX_PER_KIND = 10  # individual alerts per check family; the rest are summarised
MIN_BASELINE_CLICKS = 30  # ignore percentage swings on tiny numbers
MIN_BASELINE_IMPRESSIONS_FOR_CTR = 1000
STALE_DATA_DAYS = 2
KEEP_ALERTS = 1000
WEBHOOK_TIMEOUT = 10
_check_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------
class Thresholds(BaseModel):
    position_drop: float = Field(default=5.0, ge=1, le=50)  # places worse, per query
    traffic_drop_pct: float = Field(default=20.0, ge=1, le=100)
    ctr_drop_pct: float = Field(default=15.0, ge=1, le=100)  # relative decrease of overall CTR
    min_query_impressions: int = Field(default=100, ge=0, le=10_000_000)  # ignore queries below this in the previous period
    cannibalization_min_impressions: int = Field(default=50, ge=1, le=10_000_000)  # a URL needs this many impressions to count as competing
    check_volatility: bool = True
    check_cannibalization: bool = True
    check_bot_access: bool = True
    monitor_url: str = Field(default="", max_length=2000)  # page used for the bot-access check; blank derives it from the synced site
    notify_min_severity: Literal["critical", "warning", "info"] = "warning"
    auto_check_minutes: int = Field(default=0, ge=0, le=1440)  # 0 = only when you click "Run check now"

    @field_validator("monitor_url")
    @classmethod
    def _url(cls, v: str) -> str:
        v = v.strip()
        if not v:
            return ""
        if re.match(r"^[a-z][a-z0-9+.-]*://", v, re.I):
            if not re.match(r"^https?://", v, re.I):
                raise ValueError("Monitor URL must be http(s)")
            return v
        return "https://" + v


class SettingsIn(Thresholds):
    # None = leave unchanged, "" = remove, anything else = set (validated against the allowlist)
    slack_webhook_url: str | None = Field(default=None, max_length=700)
    teams_webhook_url: str | None = Field(default=None, max_length=700)


def validate_webhook(kind: str, url: str) -> str:
    """Only real Slack / Teams webhook endpoints are accepted: this server will POST to the URL."""
    url = url.strip()
    p = urlparse(url)
    host = (p.hostname or "").lower()
    has_credentials = bool(p.username or p.password)
    if p.scheme != "https" or not host or has_credentials:
        raise ValueError("Use the full https webhook URL provided by the app.")
    if kind == "slack" and p.query:
        raise ValueError("A Slack webhook URL has no query string.")
    if p.port not in (None, 443):
        raise ValueError("The webhook URL must use the default https port.")
    if kind == "slack":
        if host != "hooks.slack.com" or not (p.path.startswith("/services/") or p.path.startswith("/triggers/")):
            raise ValueError("That does not look like a Slack incoming webhook (https://hooks.slack.com/services/...).")
    else:
        teams_hosts = host.endswith(".webhook.office.com") or host in ("outlook.office.com", "outlook.office365.com") or host.endswith(".logic.azure.com")
        if not teams_hosts:
            raise ValueError("That does not look like a Microsoft Teams webhook (webhook.office.com or a Power Automate logic.azure.com URL).")
    try:
        _assert_public_url(url)
    except FetchError as e:
        raise ValueError(str(e))
    return url


def mask_webhook(url: str | None) -> str | None:
    if not url:
        return None
    p = urlparse(url)
    return f"{p.scheme}://{p.hostname}/…{url[-4:]}"


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS alerts (
            id INTEGER PRIMARY KEY AUTOINCREMENT, fingerprint TEXT NOT NULL, kind TEXT NOT NULL, severity TEXT NOT NULL,
            title TEXT NOT NULL, detail TEXT NOT NULL, action_json TEXT, data_json TEXT,
            status TEXT NOT NULL DEFAULT 'open', is_read INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, resolved_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_alerts_fp ON alerts(fingerprint, status);
        CREATE TABLE IF NOT EXISTS settings (
            id INTEGER PRIMARY KEY CHECK (id = 1), thresholds_json TEXT NOT NULL, slack_enc BLOB, teams_enc BLOB, updated_at TEXT
        );
        CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        """
    )
    return conn


def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def load_settings() -> tuple[Thresholds, str | None, str | None]:
    with closing(_db()) as conn:
        row = conn.execute("SELECT thresholds_json, slack_enc, teams_enc FROM settings WHERE id = 1").fetchone()
    if not row:
        return Thresholds(), None, None
    f = _fernet()
    dec = lambda b: f.decrypt(b).decode() if b else None  # noqa: E731
    return Thresholds.model_validate_json(row[0]), dec(row[1]), dec(row[2])


def _settings_view() -> dict:
    t, slack, teams = load_settings()
    return {
        **t.model_dump(),
        "slack_configured": slack is not None, "slack_webhook_masked": mask_webhook(slack),
        "teams_configured": teams is not None, "teams_webhook_masked": mask_webhook(teams),
    }


@router.get("/settings")
async def get_settings():
    """Current thresholds. Webhook URLs are never returned in full."""
    return _settings_view()


@router.post("/settings")
async def save_settings(data: SettingsIn):
    f = _fernet()
    _, cur_slack, cur_teams = load_settings()
    out: dict[str, str | None] = {}
    for kind, new, cur in (("slack", data.slack_webhook_url, cur_slack), ("teams", data.teams_webhook_url, cur_teams)):
        if new is None:
            out[kind] = cur
        elif new.strip() == "":
            out[kind] = None
        else:
            try:
                out[kind] = validate_webhook(kind, new)
            except ValueError as e:
                raise HTTPException(status_code=422, detail=f"{kind.capitalize()} webhook: {e}")
    thresholds = Thresholds.model_validate(data.model_dump(exclude={"slack_webhook_url", "teams_webhook_url"}))
    enc = lambda u: f.encrypt(u.encode()) if u else None  # noqa: E731
    with closing(_db()) as conn, conn:
        conn.execute("DELETE FROM settings")
        conn.execute("INSERT INTO settings VALUES (1, ?, ?, ?, ?)", (thresholds.model_dump_json(), enc(out["slack"]), enc(out["teams"]), _now()))
    return _settings_view()


# ---------------------------------------------------------------------------
# Webhooks
# ---------------------------------------------------------------------------
EMOJI = {"critical": "🔴", "warning": "🟠", "info": "🔵"}


def _slack_escape(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")  # blocks <!channel> / link injection from query text


def slack_payload(alerts: list[dict], header: str) -> dict:
    lines = [f"{EMOJI[a['severity']]} *{_slack_escape(a['title'])}*\n{_slack_escape(a['detail'])}" for a in alerts[:10]]
    if len(alerts) > 10:
        lines.append(f"…and {len(alerts) - 10} more")
    return {
        "text": header,
        "blocks": [{"type": "header", "text": {"type": "plain_text", "text": header[:150]}}]
        + [{"type": "section", "text": {"type": "mrkdwn", "text": ln[:2900]}} for ln in lines],
    }


def teams_payload(alerts: list[dict], header: str) -> dict:
    body: list[dict] = [{"type": "TextBlock", "text": header, "weight": "Bolder", "size": "Medium", "wrap": True}]
    for a in alerts[:10]:
        body.append({"type": "TextBlock", "text": f"{EMOJI[a['severity']]} {a['title']}", "weight": "Bolder", "wrap": True, "spacing": "Medium"})
        body.append({"type": "TextBlock", "text": a["detail"], "wrap": True, "isSubtle": True})
    if len(alerts) > 10:
        body.append({"type": "TextBlock", "text": f"…and {len(alerts) - 10} more", "wrap": True})
    return {
        "type": "message",
        "attachments": [{
            "contentType": "application/vnd.microsoft.card.adaptive", "contentUrl": None,
            "content": {"$schema": "http://adaptivecards.io/schemas/adaptive-card.json", "type": "AdaptiveCard", "version": "1.4", "body": body},
        }],
    }


def send_webhook(kind: str, url: str, alerts: list[dict], header: str) -> dict:
    payload = slack_payload(alerts, header) if kind == "slack" else teams_payload(alerts, header)
    try:
        _assert_public_url(url)  # re-checked at send time (DNS can change after the URL was saved)
        resp = requests.post(url, json=payload, timeout=WEBHOOK_TIMEOUT, allow_redirects=False)
    except FetchError as e:
        return {"ok": False, "error": str(e)}
    except requests.RequestException:
        return {"ok": False, "error": "Could not reach the webhook endpoint."}  # never echo the exception: it contains the URL
    if 200 <= resp.status_code < 300:
        return {"ok": True, "status_code": resp.status_code}
    snippet = " ".join(resp.text.split())[:100] if resp.text else ""
    return {"ok": False, "status_code": resp.status_code, "error": f"The webhook returned HTTP {resp.status_code}" + (f" ({snippet})" if snippet else ".")}


class TestWebhookRequest(BaseModel):
    target: Literal["slack", "teams"]
    url: str | None = Field(default=None, max_length=700)  # test an unsaved URL; omitted = the saved one


@router.post("/test-webhook")
async def test_webhook(data: TestWebhookRequest):
    """Send a test message to a Slack / Teams webhook."""
    if data.url and data.url.strip():
        try:
            url = validate_webhook(data.target, data.url)
        except ValueError as e:
            raise HTTPException(status_code=422, detail=str(e))
    else:
        _, slack, teams = load_settings()
        url = slack if data.target == "slack" else teams
        if not url:
            raise HTTPException(status_code=422, detail=f"No {data.target.capitalize()} webhook is saved yet. Paste a URL first.")
    test_alert = [{"severity": "info", "title": "Test message", "detail": "Your SEO dashboard can post alerts to this channel."}]
    result = await asyncio.to_thread(send_webhook, data.target, url, test_alert, "✅ SEO Dashboard: webhook test")
    return {"target": data.target, **result}


# ---------------------------------------------------------------------------
# Detection (pure functions over Search Console rows: (query, page, clicks, impressions, ctr, position))
# ---------------------------------------------------------------------------
def _draft(fp: str, kind: str, severity: str, title: str, detail: str, action: dict | None = None, data: dict | None = None) -> dict:
    return {"fingerprint": fp, "kind": kind, "severity": severity, "title": title, "detail": detail, "action": action, "data": data or {}}


def _pct_drop(prev: float, cur: float) -> float:
    return (prev - cur) / prev * 100 if prev > 0 else 0.0


def _query_agg(rows: list[tuple]) -> dict[str, dict]:
    agg: dict[str, dict] = {}
    for q, page, clicks, imps, _ctr, pos in rows:
        a = agg.setdefault(q.lower(), {"query": q, "clicks": 0, "imps": 0, "pos_w": 0.0, "pages": {}})
        a["clicks"] += clicks
        a["imps"] += imps
        a["pos_w"] += pos * imps
        a["pages"][page] = a["pages"].get(page, 0) + imps
    for a in agg.values():
        a["pos"] = a["pos_w"] / a["imps"] if a["imps"] else 0.0
    return agg


def evaluate_volatility(cur: list[tuple], prev: list[tuple], t: Thresholds) -> list[dict]:
    drafts: list[dict] = []
    c_clicks, p_clicks = sum(r[2] for r in cur), sum(r[2] for r in prev)
    c_imps, p_imps = sum(r[3] for r in cur), sum(r[3] for r in prev)

    drop = _pct_drop(p_clicks, c_clicks)
    if p_clicks >= MIN_BASELINE_CLICKS and drop > t.traffic_drop_pct:
        sev = "critical" if drop >= max(40.0, t.traffic_drop_pct * 2) else "warning"
        drafts.append(_draft("traffic:overall", "volatility", sev, f"Clicks down {drop:.0f}%",
                             f"Clicks fell from {p_clicks:,} to {c_clicks:,} versus the previous period (threshold {t.traffic_drop_pct:g}%).",
                             {"tool": "decay", "label": "Open Content Decay"}, {"previous": p_clicks, "current": c_clicks, "drop_pct": round(drop, 1)}))
    idrop = _pct_drop(p_imps, c_imps)
    if p_imps >= MIN_BASELINE_IMPRESSIONS_FOR_CTR and idrop > t.traffic_drop_pct:
        sev = "critical" if idrop >= max(40.0, t.traffic_drop_pct * 2) else "warning"
        drafts.append(_draft("impressions:overall", "volatility", sev, f"Impressions down {idrop:.0f}%",
                             f"Impressions fell from {p_imps:,} to {c_imps:,} versus the previous period.",
                             {"tool": "decay", "label": "Open Content Decay"}, {"previous": p_imps, "current": c_imps, "drop_pct": round(idrop, 1)}))
    p_ctr, c_ctr = (p_clicks / p_imps if p_imps else 0.0), (c_clicks / c_imps if c_imps else 0.0)
    cdrop = _pct_drop(p_ctr, c_ctr)
    if p_imps >= MIN_BASELINE_IMPRESSIONS_FOR_CTR and cdrop > t.ctr_drop_pct:
        drafts.append(_draft("ctr:overall", "volatility", "warning", f"Click-through rate down {cdrop:.0f}%",
                             f"CTR fell from {p_ctr * 100:.2f}% to {c_ctr * 100:.2f}% while impressions held at {c_imps:,}. Titles or snippets may need work (threshold {t.ctr_drop_pct:g}%).",
                             {"tool": "decay", "label": "Open Content Decay"}, {"previous_ctr": round(p_ctr, 4), "current_ctr": round(c_ctr, 4)}))

    # query positions
    cq, pq = _query_agg(cur), _query_agg(prev)
    cands = []
    for key, p in pq.items():
        c = cq.get(key)
        if not c or p["imps"] < t.min_query_impressions or c["imps"] == 0:
            continue
        delta = c["pos"] - p["pos"]
        if delta > t.position_drop:
            cands.append((p["imps"], delta, p, c))
    cands.sort(key=lambda x: -x[0])
    for imps, delta, p, c in cands[:MAX_PER_KIND]:
        top_page = max(c["pages"], key=c["pages"].get)
        sev = "critical" if delta >= t.position_drop * 2 and imps >= 1000 else "warning"
        drafts.append(_draft(f"pos:{p['query'].lower()}", "volatility", sev, f"“{p['query']}” fell {delta:.1f} positions",
                             f"Average position moved from {p['pos']:.1f} to {c['pos']:.1f} ({imps:,} impressions last period; threshold {t.position_drop:g}).",
                             {"tool": "refresh", "label": "Run Content Refresh", "keyword": p["query"], "url": top_page},
                             {"query": p["query"], "previous_position": round(p["pos"], 1), "current_position": round(c["pos"], 1), "url": top_page}))
    if len(cands) > MAX_PER_KIND:
        drafts.append(_draft("pos:summary", "volatility", "info", f"{len(cands) - MAX_PER_KIND} more queries dropped over {t.position_drop:g} positions",
                             "Only the highest-impression queries are listed individually.", {"tool": "decay", "label": "Open Content Decay"}))

    # page clicks
    def page_agg(rows: list[tuple]) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for q, page, clicks, imps, _c, _p in rows:
            a = out.setdefault(page, {"clicks": 0, "queries": {}})
            a["clicks"] += clicks
            a["queries"][q] = a["queries"].get(q, 0) + imps
        return out

    cp, pp = page_agg(cur), page_agg(prev)
    pages = []
    for url, p in pp.items():
        if p["clicks"] < MIN_BASELINE_CLICKS:
            continue
        lost_pct = _pct_drop(p["clicks"], cp.get(url, {"clicks": 0})["clicks"])
        if lost_pct > t.traffic_drop_pct:
            pages.append((p["clicks"] - cp.get(url, {"clicks": 0})["clicks"], lost_pct, url, p))
    pages.sort(key=lambda x: -x[0])
    for lost, lost_pct, url, p in pages[: MAX_PER_KIND // 2]:
        top_q = max(p["queries"], key=p["queries"].get)
        sev = "critical" if lost_pct >= 50 and lost >= 50 else "warning"
        drafts.append(_draft(f"page:{url}", "volatility", sev, f"Page lost {lost_pct:.0f}% of its clicks",
                             f"{url} went from {p['clicks']:,} to {p['clicks'] - lost:,} clicks (top query: “{top_q}”).",
                             {"tool": "refresh", "label": "Run Content Refresh", "keyword": top_q, "url": url}, {"url": url, "clicks_lost": lost, "drop_pct": round(lost_pct, 1)}))
    return drafts


def _split_map(rows: list[tuple], min_imps: int) -> dict[str, dict]:
    by_q: dict[str, dict] = {}
    for q, page, _c, imps, _ctr, pos in rows:
        if imps >= min_imps:
            a = by_q.setdefault(q.lower(), {"query": q, "urls": {}})
            u = a["urls"].setdefault(page, {"imps": 0, "pos_w": 0.0})
            u["imps"] += imps
            u["pos_w"] += pos * imps
    return {k: v for k, v in by_q.items() if len(v["urls"]) >= 2}


def evaluate_cannibalization(cur: list[tuple], prev: list[tuple], t: Thresholds) -> list[dict]:
    cur_split = _split_map(cur, t.cannibalization_min_impressions)
    prev_split = _split_map(prev, t.cannibalization_min_impressions) if prev else None
    verdicts = validate_split_map(cur_split, prev)  # only splits that survive the validation checks are harmful
    new = {k: v for k, v in cur_split.items() if (prev_split is None or k not in prev_split) and verdicts[k]["verdict"] == "harmful"}
    ranked = []
    for k, v in new.items():
        urls = sorted(((u, d["imps"], d["pos_w"] / d["imps"]) for u, d in v["urls"].items()), key=lambda x: -x[1])
        total = sum(x[1] for x in urls)
        ranked.append((total, v["query"], urls))
    ranked.sort(key=lambda x: -x[0])
    drafts = []
    for total, query, urls in ranked[:MAX_PER_KIND]:
        second_share = urls[1][1] / urls[0][1] if urls[0][1] else 0
        sev = "critical" if prev_split is not None and total >= 1000 and second_share >= 0.4 else "warning"
        names = ", ".join(f"{u} ({i:,})" for u, i, _p in urls[:3])
        drafts.append(_draft(f"cannib:{query.lower()}", "cannibalization", sev,
                             f"{'New split' if prev_split is not None else 'Split'}: “{query}” spans {len(urls)} URLs",
                             f"{total:,} impressions are shared by {names}." + ("" if prev_split is not None else " (No previous period to tell whether this is new.)"),
                             {"tool": "cannibalization", "label": "View Cannibalization Fix"},
                             {"query": query, "urls": [{"url": u, "impressions": i, "position": round(p, 1)} for u, i, p in urls]}))
    if len(ranked) > MAX_PER_KIND:
        drafts.append(_draft("cannib:summary", "cannibalization", "info", f"{len(ranked) - MAX_PER_KIND} more queries are split across URLs",
                             "Only the highest-impression splits are listed individually.", {"tool": "cannibalization", "label": "View Cannibalization Fix"}))
    return drafts


def derive_monitor_url(t: Thresholds) -> str | None:
    if t.monitor_url:
        return t.monitor_url
    conn = _get_connection()
    site = (conn or {}).get("site_url") or ""
    if site.startswith("sc-domain:"):
        return f"https://{site.removeprefix('sc-domain:')}/"
    return site if site.startswith(("http://", "https://")) else None


def evaluate_bot_access(url: str, previous: dict) -> tuple[list[dict], dict, dict]:
    """Request the page as each LLM crawler and read robots.txt. Returns (alerts, new_state, info)."""
    parsed = urlparse(url)
    target = (parsed.path or "/") + (f"?{parsed.query}" if parsed.query else "")
    robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"
    base = fetch_as(url, BROWSER_UA)
    robots = fetch_as(robots_url, BROWSER_UA, ROBOTS_MAX_BYTES)
    fetched = {b["id"]: fetch_as(url, b["ua"]) for b in BOTS}
    crawler_action = {"tool": "crawler", "label": "Open Crawler Simulator", "url": url}

    drafts: list[dict] = []
    if base["error"] or (base["status"] or 0) >= 400:
        why = base["error"] or f"HTTP {base['status']}"
        drafts.append(_draft("bot:page-unreachable", "bot_access", "warning", "Monitored page is not reachable",
                             f"{url} could not be fetched with a normal browser user-agent ({why}), so crawler access could not be tested.", crawler_action))
        return drafts, previous, {"url": url, "tested": False}

    rs = robots["status"]
    robots_state = "found" if rs == 200 and not robots["error"] else "missing" if rs is not None and 400 <= rs < 500 else "unverified"
    groups = parse_robots(robots["text"]) if robots_state == "found" else []
    state = dict(previous)
    if robots_state == "unverified":
        drafts.append(_draft("bot:robots-unverified", "bot_access", "info", "robots.txt could not be fetched",
                             f"{robots_url} returned {('HTTP ' + str(rs)) if rs else (robots['error'] or 'no response')}; crawler rules are unverified.", crawler_action))

    for bot in BOTS:
        f = fetched[bot["id"]]
        status = f["status"]
        if f["error"] or (status or 0) >= 400:
            why = f["error"] or f"HTTP {status}"
            drafts.append(_draft(f"bot:http:{bot['id']}", "bot_access", "critical", f"{bot['name']} crawler gets {why}",
                                 f"Requesting {url} as {bot['fetch_as']} fails ({why}) while a normal browser gets HTTP {base['status']}. A firewall, WAF or CDN rule is likely blocking it.",
                                 crawler_action, {"bot": bot["id"], "status": status}))
        if robots_state == "unverified":
            continue
        for token, role, desc in bot["tokens"]:
            allowed = evaluate_robots(groups, token, target)["allowed"]
            was = previous.get(token)  # True / False / None (never seen)
            state[token] = allowed
            if allowed:
                continue
            gating = role in GATING_ROLES
            if was is True:  # allowed last time, blocked now
                sev = "critical" if gating else "info"
                drafts.append(_draft(f"bot:robots:{token}", "bot_access", sev, f"New robots.txt block: {token}",
                                     f"{token} ({desc}) was allowed on the last check and is now disallowed by robots.txt." + ("" if gating else " It is a training crawler, so this may be deliberate."),
                                     crawler_action, {"token": token, "new": True}))
            elif gating:  # blocked, and we have no evidence it ever changed
                drafts.append(_draft(f"bot:robots:{token}", "bot_access", "warning", f"{token} is blocked by robots.txt",
                                     f"{token} ({desc}) cannot crawl {url}, so {bot['name']} cannot use this page.", crawler_action, {"token": token, "new": False}))
    return drafts, state, {"url": url, "tested": True, "robots": robots_state}


# ---------------------------------------------------------------------------
# Persistence of alerts + the check run
# ---------------------------------------------------------------------------
def _row_to_alert(r: tuple) -> dict:
    return {
        "id": r[0], "fingerprint": r[1], "kind": r[2], "severity": r[3], "title": r[4], "detail": r[5],
        "action": json.loads(r[6]) if r[6] else None, "data": json.loads(r[7]) if r[7] else {},
        "status": r[8], "read": bool(r[9]), "created_at": r[10], "last_seen_at": r[11], "resolved_at": r[12],
    }


_ALERT_COLS = "id, fingerprint, kind, severity, title, detail, action_json, data_json, status, is_read, created_at, last_seen_at, resolved_at"


def persist(drafts: list[dict], kinds_ran: set[str]) -> tuple[list[dict], int]:
    """Upsert drafts. Returns (alerts that are new or escalated, number resolved)."""
    now = _now()
    notify: list[dict] = []
    with closing(_db()) as conn, conn:
        open_rows = {r[1]: r for r in conn.execute(f"SELECT {_ALERT_COLS} FROM alerts WHERE status = 'open'")}
        seen: set[str] = set()
        for d in drafts:
            if d["fingerprint"] in seen:
                continue
            seen.add(d["fingerprint"])
            action_json, data_json = json.dumps(d["action"]) if d["action"] else None, json.dumps(d["data"])
            existing = open_rows.get(d["fingerprint"])
            if existing:
                escalated = SEVERITY_RANK[d["severity"]] > SEVERITY_RANK[existing[3]]
                conn.execute(
                    "UPDATE alerts SET severity=?, title=?, detail=?, action_json=?, data_json=?, last_seen_at=?, is_read=CASE WHEN ? THEN 0 ELSE is_read END WHERE id=?",
                    (d["severity"], d["title"], d["detail"], action_json, data_json, now, int(escalated), existing[0]),
                )
                if escalated:
                    notify.append({**d, "id": existing[0]})
            else:
                cur = conn.execute(
                    "INSERT INTO alerts (fingerprint, kind, severity, title, detail, action_json, data_json, status, is_read, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', 0, ?, ?)",
                    (d["fingerprint"], d["kind"], d["severity"], d["title"], d["detail"], action_json, data_json, now, now),
                )
                notify.append({**d, "id": cur.lastrowid})
        resolved = 0
        for fp, row in open_rows.items():
            if fp not in seen and row[2] in kinds_ran:
                conn.execute("UPDATE alerts SET status='resolved', resolved_at=? WHERE id=?", (now, row[0]))
                resolved += 1
        conn.execute("DELETE FROM alerts WHERE id NOT IN (SELECT id FROM alerts ORDER BY id DESC LIMIT ?)", (KEEP_ALERTS,))
        conn.execute("INSERT INTO kv VALUES ('last_check', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (now,))
    return notify, resolved


def _kv_get(key: str) -> str | None:
    with closing(_db()) as conn:
        row = conn.execute("SELECT value FROM kv WHERE key = ?", (key,)).fetchone()
    return row[0] if row else None


def _kv_set(key: str, value: str) -> None:
    with closing(_db()) as conn, conn:
        conn.execute("INSERT INTO kv VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, value))


def run_check(notify: bool) -> dict:
    with _check_lock:
        t, slack, teams = load_settings()
        cur, prev = load_rows("current"), load_rows("previous")
        drafts: list[dict] = []
        kinds_ran: set[str] = set()
        ran: dict[str, dict] = {}

        if not cur:
            reason = "No Search Console data has been synced yet."
            for name, enabled in (("volatility", t.check_volatility), ("cannibalization", t.check_cannibalization)):
                ran[name] = {"status": "skipped", "reason": reason if enabled else "Turned off in settings."}
        else:
            if t.check_volatility:
                if prev:
                    drafts += evaluate_volatility(cur, prev, t)
                    kinds_ran.add("volatility")
                    ran["volatility"] = {"status": "ok"}
                else:
                    ran["volatility"] = {"status": "skipped", "reason": "The last sync did not include the previous period. Sync with the comparison option on."}
            else:
                ran["volatility"] = {"status": "skipped", "reason": "Turned off in settings."}
            if t.check_cannibalization:
                drafts += evaluate_cannibalization(cur, prev, t)
                kinds_ran.add("cannibalization")
                ran["cannibalization"] = {"status": "ok", "compared_with_previous": bool(prev)}
            else:
                ran["cannibalization"] = {"status": "skipped", "reason": "Turned off in settings."}
            # the snapshot itself getting old makes every comparison above stale
            synced = (_status().get("last_sync") or {}).get("synced_at")
            if synced:
                age = (datetime.datetime.now(datetime.timezone.utc) - datetime.datetime.fromisoformat(synced)).days
                kinds_ran.add("data")
                if age >= STALE_DATA_DAYS:
                    drafts.append(_draft("data:stale", "data", "info", f"Search Console data is {age} days old",
                                         "Alerts compare the last sync. Sync again for fresh numbers.", {"tool": "sync", "label": "Open Google connection"}))

        if t.check_bot_access:
            url = derive_monitor_url(t)
            if not url:
                ran["bot_access"] = {"status": "skipped", "reason": "No monitor URL. Set one in settings or sync Search Console first."}
            else:
                try:
                    prev_state = json.loads(_kv_get("bot_state") or "{}")
                    bot_drafts, new_state, info = evaluate_bot_access(url, prev_state)
                    drafts += bot_drafts
                    if info.get("tested"):
                        _kv_set("bot_state", json.dumps(new_state))
                        kinds_ran.add("bot_access")
                    ran["bot_access"] = {"status": "ok" if info.get("tested") else "skipped", **({} if info.get("tested") else {"reason": "The monitored page was not reachable."}), "url": url}
                except FetchError as e:
                    ran["bot_access"] = {"status": "skipped", "reason": str(e), "url": url}
        else:
            ran["bot_access"] = {"status": "skipped", "reason": "Turned off in settings."}

        _kv_set("last_run", json.dumps({"at": _now(), "ran": ran}))
        new_alerts, resolved = persist(drafts, kinds_ran)
        deliveries: dict[str, dict] = {}
        to_send = [a for a in new_alerts if SEVERITY_RANK[a["severity"]] >= SEVERITY_RANK[t.notify_min_severity]]
        if notify and to_send:
            crit = sum(a["severity"] == "critical" for a in to_send)
            header = f"SEO Dashboard: {len(to_send)} new alert{'s' if len(to_send) != 1 else ''}" + (f" ({crit} critical)" if crit else "")
            to_send.sort(key=lambda a: -SEVERITY_RANK[a["severity"]])
            for kind, url in (("slack", slack), ("teams", teams)):
                deliveries[kind] = send_webhook(kind, url, to_send, header) if url else {"ok": False, "skipped": "No webhook configured."}
        elif notify:
            deliveries = {"slack": {"ok": False, "skipped": "Nothing new to send."}, "teams": {"ok": False, "skipped": "Nothing new to send."}}

        with closing(_db()) as conn:
            ids = [a["id"] for a in new_alerts]
            fresh = [_row_to_alert(r) for r in conn.execute(f"SELECT {_ALERT_COLS} FROM alerts WHERE id IN ({','.join('?' * len(ids))}) ORDER BY id DESC", ids)] if ids else []
        return {"checked_at": _kv_get("last_check"), "ran": ran, "new_alerts": fresh, "resolved": resolved, "notifications": deliveries, "summary": summary()}


class CheckRequest(BaseModel):
    notify: bool = True  # post new alerts to the configured webhooks


@router.post("/check")
async def check_alerts(data: CheckRequest | None = None):
    """Evaluate the current data against the thresholds, store new alerts and notify the webhooks."""
    return await asyncio.to_thread(run_check, True if data is None else data.notify)


# ---------------------------------------------------------------------------
# History / summary / read state
# ---------------------------------------------------------------------------
def summary() -> dict:
    t, _, _ = load_settings()
    with closing(_db()) as conn:
        crit = conn.execute("SELECT COUNT(*) FROM alerts WHERE status='open' AND is_read=0 AND severity='critical'").fetchone()[0]
        unread = conn.execute("SELECT COUNT(*) FROM alerts WHERE status='open' AND is_read=0").fetchone()[0]
        open_total = conn.execute("SELECT COUNT(*) FROM alerts WHERE status='open'").fetchone()[0]
    last = _kv_get("last_check")
    due = False
    if t.auto_check_minutes > 0:
        due = last is None or (datetime.datetime.now(datetime.timezone.utc) - datetime.datetime.fromisoformat(last)).total_seconds() >= t.auto_check_minutes * 60
    return {"unread_critical": crit, "unread_total": unread, "open_total": open_total, "last_check": last, "auto_check_minutes": t.auto_check_minutes, "due": due}


@router.get("/summary")
async def get_summary():
    """Counts for the header bell. `due` tells the dashboard that an automatic check is overdue."""
    return summary()


@router.get("/history")
async def get_history(
    status: Literal["all", "open", "resolved"] = "all",
    severity: Literal["all", "critical", "warning", "info"] = "all",
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    where, params = [], []
    if status != "all":
        where.append("status = ?")
        params.append(status)
    if severity != "all":
        where.append("severity = ?")
        params.append(severity)
    clause = f"WHERE {' AND '.join(where)}" if where else ""
    with closing(_db()) as conn:
        total = conn.execute(f"SELECT COUNT(*) FROM alerts {clause}", params).fetchone()[0]
        rows = conn.execute(f"SELECT {_ALERT_COLS} FROM alerts {clause} ORDER BY id DESC LIMIT ? OFFSET ?", [*params, limit, offset]).fetchall()
    return {"total": total, "items": [_row_to_alert(r) for r in rows], "summary": summary()}


class ReadRequest(BaseModel):
    ids: list[int] = Field(default_factory=list, max_length=500)
    all: bool = False


@router.post("/read")
async def mark_read(data: ReadRequest):
    with closing(_db()) as conn, conn:
        if data.all:
            conn.execute("UPDATE alerts SET is_read = 1")
        elif data.ids:
            conn.execute(f"UPDATE alerts SET is_read = 1 WHERE id IN ({','.join('?' * len(data.ids))})", data.ids)
    return summary()

"""
"Needs your attention": one short, prioritised list of what a person has to look at, drawn from the state the other modules already keep.

GET /api/v1/triage/attention-items returns at most MAX_ITEMS items, most urgent first. It makes no network calls (it reads local
state only), so it is cheap enough to poll. Triggers:
  a. google_login     the saved Google sign-in was rejected/undecryptable, or is about to lapse
  b. sync_failure     the last Search Console sync failed or was partial, or the last automated crawl check could not run
  c. crawler_refused  the monitored page turns an AI crawler away (HTTP 4xx/5xx)
  d. waiting_decision a high-scoring opportunity nobody has reviewed yet
  e. cannibalization  queries that split impressions across several URLs in the synced Search Console data
  f. stale_evidence   Search Console data or the crawl check is older than STALE_DAYS
  g. evidence_audit   inconsistencies the stored evidence audit found (text vs data, snapshot/baseline integrity)

What it cannot know, and says so rather than guessing:
  * Google does not tell us when a refresh token expires. "Expiring within 48 hours" only applies if GSC_REFRESH_TOKEN_TTL_DAYS is
    set (use 7 if your OAuth consent screen is in "Testing" mode); otherwise only an actual rejection is flagged.
  * A "Cloudflare challenge" shows up to us only as an HTTP 403/503 for a crawler's user-agent, so that is how it is reported.
"""

import datetime
import json
import logging
import os
from contextlib import closing

from fastapi import APIRouter

import alerting_engine_router as alerting
from cannibalization_validation import validate_split_map
import governance_store as gov
import evidence_audit_router as audit
import gsc_connector_router as gsc
from opportunities_router import all_opportunities

router = APIRouter(prefix="/triage", tags=["Triage"])  # app.py mounts it under /api/v1
log = logging.getLogger("triage")

MAX_ITEMS = 5
STALE_DAYS = 7
LOGIN_WARN_HOURS = 48
HIGH_PRIORITY = 65
SEVERITY_RANK = {"critical": 3, "warning": 2, "action": 1}
SEVERITY_LABEL = {"critical": "Critical", "warning": "Warning", "action": "Action needed"}
CLEAN_MESSAGE = "Nothing needs a decision"


def _parse(ts: str | None) -> datetime.datetime | None:
    if not ts:
        return None
    try:
        d = datetime.datetime.fromisoformat(ts)
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=datetime.timezone.utc)


def _item(trigger: str, severity: str, title: str, summary: str, label: str, target: dict, key: str = "") -> dict:
    return {
        "id": f"{trigger}:{key}" if key else trigger,
        "trigger": trigger,
        "severity": severity,
        "severity_label": SEVERITY_LABEL[severity],
        "title": title,
        "summary": summary,
        "action": {"label": label, "target": target},
    }


def _ago(delta: datetime.timedelta) -> str:
    hours = int(delta.total_seconds() // 3600)
    return f"{hours} hours" if hours < 48 else f"{hours // 24} days"


def _short(text: str, n: int = 140) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= n else text[: n - 1] + "…"


# ---------------------------------------------------------------------------
# Evaluators: each takes `now` and returns a list of items (empty = nothing to report)
# ---------------------------------------------------------------------------
def check_google_login(now: datetime.datetime) -> list[dict]:
    err = gsc.get_health("auth_error")
    if err:
        why = {
            "undecryptable": "The stored credentials can no longer be read (the encryption key changed).",
            "invalid_grant": "Google says the access was revoked or has expired.",
            "rejected": "Google rejected the saved credentials.",
        }.get(err.get("reason", ""), "Google rejected the saved credentials.")
        return [_item("google_login", "critical", "Google sign-in needs to be redone", f"{why} Reconnect so syncs and checks can run.", "Reconnect Google", {"kind": "tool", "tool": "sync"})]

    conn = gsc._get_connection()
    try:
        ttl_days = float(os.getenv("GSC_REFRESH_TOKEN_TTL_DAYS", "0") or 0)
    except ValueError:
        ttl_days = 0
    connected_at = _parse(conn["connected_at"]) if conn else None
    if conn and ttl_days > 0 and connected_at:
        left = connected_at + datetime.timedelta(days=ttl_days) - now
        if left <= datetime.timedelta(0):
            return [_item("google_login", "critical", "Google sign-in has expired", f"The saved sign-in is past its {ttl_days:g}-day limit. Reconnect to keep syncing.", "Reconnect Google", {"kind": "tool", "tool": "sync"})]
        if left <= datetime.timedelta(hours=LOGIN_WARN_HOURS):
            return [_item("google_login", "warning", "Google sign-in expires soon", f"The saved sign-in lapses in about {_ago(left)}. Reconnect before then so syncs do not stop.", "Reconnect Google", {"kind": "tool", "tool": "sync"})]
    return []


def check_sync_failure(now: datetime.datetime) -> list[dict]:
    out: list[dict] = []
    err = gsc.get_health("sync_error")
    status = gsc._status()
    sync = status.get("last_sync")
    if err:
        out.append(_item("sync_failure", "critical" if not sync else "warning", "The last Search Console sync failed", _short(f"{err.get('message', 'Unknown error')}"), "Open Google connection", {"kind": "tool", "tool": "sync"}, "sync"))
    elif sync:
        partial = []
        if sync.get("truncated"):
            partial.append("Search Console returned more rows than one request allows, so the data is cut off")
        if sync.get("previous_start") and not sync.get("rows_previous"):
            partial.append("the comparison period came back empty")
        if partial:
            out.append(_item("sync_failure", "warning", "The last Search Console sync was partial", _short("; ".join(partial)).capitalize() + ".", "Open Google connection", {"kind": "tool", "tool": "sync"}, "partial"))

    raw = alerting._kv_get("last_run")
    if raw:
        try:
            ran = json.loads(raw).get("ran", {}).get("bot_access") or {}
        except ValueError:
            ran = {}
        reason = str(ran.get("reason", ""))
        if ran.get("status") == "skipped" and reason and not reason.startswith(("Turned off", "No monitor URL")):
            out.append(_item("sync_failure", "warning", "The last crawl check could not run", _short(reason), "Open the alert checks", {"kind": "module", "module": "alerts"}, "crawl"))
    return out


def check_crawler_refused(now: datetime.datetime) -> list[dict]:
    with closing(alerting._db()) as db:
        rows = db.execute("SELECT title, action_json, data_json FROM alerts WHERE status = 'open' AND fingerprint LIKE 'bot:http:%' ORDER BY id DESC").fetchall()
    if not rows:
        return []
    names, statuses, url = [], set(), None
    for title, action_json, data_json in rows:
        data = json.loads(data_json) if data_json else {}
        action = json.loads(action_json) if action_json else {}
        names.append(title.split(" crawler")[0])
        if data.get("status"):
            statuses.add(int(data["status"]))
        url = url or action.get("url")
    codes = ", ".join(f"HTTP {s}" for s in sorted(statuses)) or "an error"
    hint = " A firewall or bot challenge (such as Cloudflare) is the usual cause." if statuses & {403, 503} else ""
    who = ", ".join(sorted(set(names)))
    return [_item("crawler_refused", "critical", f"{len(set(names))} AI crawler{'s are' if len(set(names)) != 1 else ' is'} being turned away", _short(f"{who} get {codes} on {url or 'the monitored page'}.{hint}", 170), "Open Crawler Simulator", {"kind": "tool", "tool": "crawler", "url": url}, "bots")]


def check_waiting_decision(now: datetime.datetime) -> list[dict]:
    states = gov.all_states()
    waiting = [o for o in all_opportunities() if (o.get("score") or 0) >= HIGH_PRIORITY and states.get(o["id"], {}).get("status", "Proposed") == "Proposed"]
    if not waiting:
        return []
    top = max(waiting, key=lambda o: (o["score"], o.get("impressions", 0)))
    more = f" ({len(waiting) - 1} more waiting)" if len(waiting) > 1 else ""
    return [_item("waiting_decision", "action", "Waiting for a decision", _short(f"“{top['priority']}” scores {top['score']:g} and has no reviewer sign-off yet{more}."), "Review and sign off", {"kind": "opportunity", "opportunity_id": top["id"]}, str(top["id"]))]


def check_cannibalization(now: datetime.datetime) -> list[dict]:
    t, _, _ = alerting.load_settings()
    if not t.check_cannibalization:
        return []
    rows = gsc.load_rows("current")
    if not rows:
        return []
    split = alerting._split_map(rows, t.cannibalization_min_impressions)
    if not split:
        return []
    verdicts = validate_split_map(split, gsc.load_rows("previous"))
    ranked = sorted(((sum(u["imps"] for u in v["urls"].values()), v["query"], len(v["urls"])) for k, v in split.items() if verdicts[k]["verdict"] == "harmful"), reverse=True)
    if not ranked:
        return []
    imps, query, urls = ranked[0]
    more = f" and {len(ranked) - 1} more" if len(ranked) > 1 else ""
    return [_item("cannibalization", "action", f"{len(ranked)} quer{'ies' if len(ranked) != 1 else 'y'} split traffic across pages", _short(f"“{query}”{more}: {imps:,} impressions shared by {urls} URLs, and the split is still there in the latest sync."), "Open Cannibalization fix", {"kind": "tool", "tool": "cannibalization"})]


def check_stale_evidence(now: datetime.datetime) -> list[dict]:
    parts, target, label = [], None, "Run the checks"
    sync = gsc._status().get("last_sync")
    synced = _parse(sync["synced_at"]) if sync else None
    if synced and now - synced >= datetime.timedelta(days=STALE_DAYS):
        parts.append(f"Search Console data is {_ago(now - synced)} old")
        target, label = {"kind": "tool", "tool": "sync"}, "Sync Search Console"
    checked = _parse(alerting._kv_get("last_check"))
    if checked and now - checked >= datetime.timedelta(days=STALE_DAYS):
        parts.append(f"the last crawl check was {_ago(now - checked)} ago")
        target = target or {"kind": "module", "module": "alerts"}
    if not parts:
        return []
    return [_item("stale_evidence", "warning", "Evidence is out of date", _short(parts[0][0].upper() + parts[0][1:] + (f" and {parts[1]}" if len(parts) > 1 else "") + f". Anything built on it is older than {STALE_DAYS} days."), label, target)]


# Already reported by their own items above, so the audit does not repeat them here.
AUDIT_SKIP = {"integrity:empty-previous"}


def check_evidence_audit(now: datetime.datetime) -> list[dict]:
    """Inconsistencies found by the last evidence audit (staleness is covered by check_stale_evidence). Reads the stored run; never re-runs it."""
    last = audit.latest_result()
    if not last:
        return []
    found = [f for f in last["findings"] if f["check"] != "stale_data" and f["severity"] in ("error", "warning") and f["id"] not in AUDIT_SKIP]
    if not found:
        return []
    errors = sum(f["severity"] == "error" for f in found)
    first = found[0]["title"]
    more = f" and {len(found) - 1} more" if len(found) > 1 else ""
    return [_item("evidence_audit", "critical" if errors else "warning", f"The evidence audit found {len(found)} inconsistenc{'ies' if len(found) != 1 else 'y'}", _short(f"{first}{more}."), "Open Evidence Audit", {"kind": "module", "module": "evidence"})]


EVALUATORS = [check_google_login, check_sync_failure, check_crawler_refused, check_waiting_decision, check_cannibalization, check_stale_evidence, check_evidence_audit]


def build_attention(now: datetime.datetime | None = None) -> dict:
    now = now or datetime.datetime.now(datetime.timezone.utc)
    found: list[dict] = []
    errors: list[str] = []
    for fn in EVALUATORS:
        try:
            found += fn(now)
        except Exception:  # noqa: BLE001 - one broken check must not hide the others
            log.exception("triage check %s failed", fn.__name__)
            errors.append(fn.__name__.removeprefix("check_"))
    order = {fn.__name__.removeprefix("check_"): i for i, fn in enumerate(EVALUATORS)}
    found.sort(key=lambda i: (-SEVERITY_RANK[i["severity"]], order[i["trigger"]]))
    shown = found[:MAX_ITEMS]
    if found:
        status, message = "attention", f"{len(found)} thing{'s' if len(found) != 1 else ''} need{'' if len(found) != 1 else 's'} your attention"
    elif errors:
        status, message = "degraded", "Some checks could not run, so this list may be incomplete"
    else:
        status, message = "clear", CLEAN_MESSAGE
    return {
        "status": status,
        "message": message,
        "generated_at": now.isoformat(timespec="seconds"),
        "total": len(found),
        "shown": len(shown),
        "hidden": len(found) - len(shown),
        "items": shown,
        "check_errors": errors,
    }


@router.get("/attention-items")
async def attention_items():
    """At most five prioritised things that need a human. Read-only and local: it never calls Google or fetches a page."""
    return build_attention()

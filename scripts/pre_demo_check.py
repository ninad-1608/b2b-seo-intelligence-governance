#!/usr/bin/env python
"""
Is the dashboard ready to show? Prints one PASS / WARN / FAIL line per check and a verdict. Exit code 0 = ready, 1 = something FAILED.

    python scripts/pre_demo_check.py                         test the code in-process against the real databases (no server needed)
    python scripts/pre_demo_check.py --url http://127.0.0.1:8010 --frontend http://127.0.0.1:3000
                                                             test the servers you are about to demo, over HTTP
    python scripts/pre_demo_check.py --strict                treat WARN as FAIL
    python scripts/pre_demo_check.py --json                  machine-readable report

What it checks
  Environment   Python and package versions, .env, the AI key and Google OAuth settings (presence only: values are never printed)
  Databases     each SQLite file opens, passes PRAGMA integrity_check, has the expected tables and columns; the governance log has its
                append-only triggers and an unbroken hash chain; the Google token can be decrypted-looking (key file present)
  Backups       the newest backup is under 24 hours old
  Endpoints     governance, triage, evidence audit and the other critical APIs return the shape the UI needs
  Frontend      (when --frontend is given, or the default port answers) the home page renders and is not showing "API down"

It is READ-ONLY with two small exceptions you should know about: GET /audit/status stores a fresh audit run when the evidence has
changed, and lazy databases (governance, audit...) are created if their feature has never been used. It never records a decision,
locks a baseline, calls an AI model, or contacts Google.
"""

import argparse
import contextlib
import datetime
import importlib
import io
import json
import os
import re
import sqlite3
import sys
import time
from contextlib import closing
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import BACKUP_DIR, DATABASES, ROOT, human_size, setup_console  # noqa: E402

PASS, WARN, FAIL = "PASS", "WARN", "FAIL"
SLOW_SECONDS = 3.0
BACKUP_MAX_AGE_HOURS = 24


class Report:
    def __init__(self) -> None:
        self.items: list[dict] = []
        self.section = ""

    def start(self, name: str) -> None:
        self.section = name
        print(f"\n== {name} ==")

    def add(self, status: str, name: str, detail: str = "") -> None:
        self.items.append({"section": self.section, "status": status, "name": name, "detail": detail})
        print(f"[{status}] {name}" + (f" - {detail}" if detail else ""))

    def count(self, status: str) -> int:
        return sum(1 for i in self.items if i["status"] == status)


# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------
def read_env_file(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        m = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$", line)
        if m and not line.lstrip().startswith("#"):
            out[m.group(1)] = m.group(2).strip().strip("'\"")
    return out


def check_environment(r: Report) -> None:
    r.start("Environment")
    v = sys.version_info
    r.add(PASS if v >= (3, 10) else FAIL, "Python version", f"{v.major}.{v.minor}.{v.micro}" + ("" if v >= (3, 10) else " (3.10 or newer is required)"))
    for mod, needed in (("fastapi", True), ("uvicorn", True), ("pydantic", True), ("requests", True), ("cryptography", True), ("pandas", False)):
        try:
            m = importlib.import_module(mod)
            r.add(PASS, f"package {mod}", getattr(m, "__version__", ""))
        except ImportError:
            r.add(FAIL if needed else WARN, f"package {mod}", "not installed" + ("" if needed else " (CSV upload will not work)"))
    env = read_env_file(ROOT / ".env")
    merged = {**env, **{k: v for k, v in os.environ.items() if k in ("OPENROUTER_API_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GSC_TOKEN_ENCRYPTION_KEY")}}
    r.add(PASS if env else WARN, ".env file", "found" if env else f"missing at {ROOT / '.env'}: AI features and Google sign-in need it")
    if merged.get("OPENROUTER_API_KEY"):
        r.add(PASS, "AI key (OPENROUTER_API_KEY)", "set")
    else:
        r.add(WARN, "AI key (OPENROUTER_API_KEY)", "not set: briefs, fix code and rewrites will fail in a demo")
    if merged.get("GOOGLE_CLIENT_ID") and merged.get("GOOGLE_CLIENT_SECRET"):
        r.add(PASS, "Google OAuth client", "set")
    else:
        r.add(WARN, "Google OAuth client", "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set: Connect Google will not work (sandbox data still does)")


# ---------------------------------------------------------------------------
# Databases
# ---------------------------------------------------------------------------
def check_one_database(r: Report, name: str, meta: dict, announce_missing: bool = True) -> bool:
    path = ROOT / name
    if not path.exists():
        if announce_missing:
            r.add(WARN if meta["lazy"] else FAIL, f"{name}", f"does not exist yet ({meta['role']})" + ("; created on first use" if meta["lazy"] else ""))
        return False
    try:
        with closing(sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True, timeout=5)) as c:
            integrity = c.execute("PRAGMA integrity_check").fetchall()
            if integrity != [("ok",)]:
                r.add(FAIL, f"{name} integrity", f"PRAGMA integrity_check: {integrity[:2]}")
                return False
            problems = []
            counts = []
            for table, cols in meta["tables"].items():
                have = [row[1] for row in c.execute(f'PRAGMA table_info("{table}")')]
                if not have:
                    problems.append(f"table {table} is missing")
                    continue
                gone = [col for col in cols if col not in have]
                if gone:
                    problems.append(f"{table} lacks column(s) {', '.join(gone)}")
                counts.append(f"{table}={c.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]}")
            triggers = {row[0] for row in c.execute("SELECT name FROM sqlite_master WHERE type = 'trigger'")}
            for t in meta.get("triggers", []):
                if t not in triggers:
                    problems.append(f"trigger {t} is missing (the decision log would no longer be append-only)")
        if problems:
            r.add(FAIL, f"{name} schema", "; ".join(problems))
            return False
        r.add(PASS, f"{name}", f"{human_size(path.stat().st_size)}, integrity ok, schema ok ({', '.join(counts)})")
        return True
    except sqlite3.Error as e:
        r.add(FAIL, f"{name}", f"cannot open: {e}")
        return False


def check_databases(r: Report) -> set[str]:
    r.start("Databases")
    missing_lazy: set[str] = set()
    for name, meta in DATABASES.items():
        if not (ROOT / name).exists() and meta["lazy"]:
            missing_lazy.add(name)
        check_one_database(r, name, meta)
    unknown = sorted(p.name for p in ROOT.glob("*.db") if p.name not in DATABASES)
    if unknown:
        r.add(WARN, "unrecognised database file(s)", f"{', '.join(unknown)} (not in the backup/check registry; add it to scripts/_common.py)")

    # the decision log's tamper evidence, and the Google key
    if (ROOT / "governance.db").exists():
        try:
            sys.path.insert(0, str(ROOT))
            with contextlib.redirect_stdout(io.StringIO()):
                gov = importlib.import_module("governance_store")
            chain = gov.verify_chain()
            r.add(PASS if chain["ok"] else FAIL, "governance log hash chain", f"{chain['entries']} entries verified" if chain["ok"] else f"BROKEN at entry {chain['first_bad_id']}: the log was edited or truncated")
        except Exception as e:  # noqa: BLE001
            r.add(FAIL, "governance log hash chain", f"{type(e).__name__}: {e}")
    if (ROOT / "gsc_connector.db").exists():
        with closing(sqlite3.connect(f"{(ROOT / 'gsc_connector.db').as_uri()}?mode=ro", uri=True)) as c:
            connected = c.execute("SELECT COUNT(*) FROM connection").fetchone()[0]
            synced = c.execute("SELECT synced_at FROM sync_meta WHERE id = 1").fetchone()
        has_key = (ROOT / "gsc_connector.key").exists() or bool(os.getenv("GSC_TOKEN_ENCRYPTION_KEY") or read_env_file(ROOT / ".env").get("GSC_TOKEN_ENCRYPTION_KEY"))
        if connected and not has_key:
            r.add(FAIL, "Google token key", "a Google connection is saved but gsc_connector.key is missing: the token cannot be decrypted, reconnect Google")
        else:
            r.add(PASS, "Google connection", ("connected" if connected else "not connected (sandbox data will be shown)") + (f"; last sync {synced[0]}" if synced else ""))
    return missing_lazy


def check_backups(r: Report) -> None:
    r.start("Backups")
    archives = sorted(BACKUP_DIR.glob("seo-dashboard-backup-*.zip")) if BACKUP_DIR.exists() else []
    if not archives:
        r.add(WARN, "latest backup", "none yet: run  npm run backup  before the demo")
        return
    newest = archives[-1]
    age = (time.time() - newest.stat().st_mtime) / 3600
    r.add(PASS if age <= BACKUP_MAX_AGE_HOURS else WARN, "latest backup", f"{newest.name}, {age:.1f} hours old" + ("" if age <= BACKUP_MAX_AGE_HOURS else f" (older than {BACKUP_MAX_AGE_HOURS}h: run npm run backup)"))


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
class Client:
    """The same calls either way: in-process against the app's code, or over HTTP against a running server."""

    def __init__(self, url: str | None) -> None:
        self.url = url.rstrip("/") if url else None
        self._tc = None

    def _testclient(self):
        if self._tc is None:
            os.chdir(ROOT)  # app.py opens "accounts.db" relative to the working directory
            sys.path.insert(0, str(ROOT))
            with contextlib.redirect_stdout(io.StringIO()):  # the AI router announces its key on import
                app = importlib.import_module("app")
            from fastapi.testclient import TestClient

            self._tc = TestClient(app.app)
        return self._tc

    def request(self, method: str, path: str, **kw):
        if self.url:
            import requests

            return requests.request(method, self.url + path, timeout=20, **kw)
        return self._testclient().request(method, path, **kw)


def run_endpoint(r: Report, client: Client, name: str, method: str, path: str, validate, **kw) -> object | None:
    t0 = time.perf_counter()
    try:
        res = client.request(method, path, **kw)
    except Exception as e:  # noqa: BLE001 - connection refused, timeout, import error in-process...
        r.add(FAIL, f"{method} {path}", f"{type(e).__name__}: {e}"[:200])
        return None
    took = time.perf_counter() - t0
    if res.status_code != 200:
        r.add(FAIL, f"{method} {path}", f"HTTP {res.status_code}: {res.text[:150]}")
        return None
    try:
        body = res.json()
        detail = validate(body)
    except AssertionError as e:
        r.add(FAIL, f"{method} {path}", f"unexpected response: {e}")
        return None
    except Exception as e:  # noqa: BLE001
        r.add(FAIL, f"{method} {path}", f"could not read the response: {type(e).__name__}: {e}")
        return None
    r.add(WARN if took > SLOW_SECONDS else PASS, f"{name}", f"{detail} ({took * 1000:.0f} ms)" + (f", slower than {SLOW_SECONDS:g}s" if took > SLOW_SECONDS else ""))
    return body


def need(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def check_endpoints(r: Report, client: Client) -> None:
    r.start("Endpoints" + (f" ({client.url})" if client.url else " (in-process)"))
    if not client.url:  # importing the app is start-up cost, not request latency; do it first and report a failure on its own
        t0 = time.perf_counter()
        try:
            client._testclient()
            r.add(PASS, "application imports", f"app.py loaded with all routers ({(time.perf_counter() - t0):.1f} s)")
        except Exception as e:  # noqa: BLE001
            r.add(FAIL, "application imports", f"{type(e).__name__}: {e}"[:300])
            return

    def v_openapi(b):
        paths = set(b["paths"])
        want = {"/api/v1/opportunities", "/api/v1/opportunities/{opportunity_id}/decision", "/api/v1/triage/attention-items", "/api/v1/audit/status", "/api/v1/cannibalization/deep-check", "/api/v1/reports/executive-audit-pdf"}
        gone = sorted(want - paths)
        need(not gone, f"routes missing: {', '.join(gone)}")
        return f"{len(paths)} routes, critical routes present"

    run_endpoint(r, client, "API routes", "GET", "/openapi.json", v_openapi)

    def v_opps(b):
        need(b.get("status") == "success" and b["items"], "no opportunities returned")
        need(all("governance" in i and i["governance"]["status"] for i in b["items"]), "an item has no governance state")
        c = b["counts"]
        return f"{len(b['items'])} opportunities; " + ", ".join(f"{k} {v}" for k, v in c.items() if v)

    opps = run_endpoint(r, client, "Governance: opportunities and review states", "GET", "/api/v1/opportunities", v_opps)

    def v_verify(b):
        need(b.get("ok") is True, f"chain NOT ok: first bad entry {b.get('first_bad_id')}")
        return f"decision log verified, {b['entries']} entries"

    run_endpoint(r, client, "Governance: decision log integrity", "GET", "/api/v1/opportunities/audit-log/verify", v_verify)

    if opps:
        first = opps["items"][0]["id"]

        def v_hist(b):
            need("items" in b and b["integrity"]["ok"], "history/integrity missing")
            return f"history for #{first} readable"

        run_endpoint(r, client, "Governance: history", "GET", f"/api/v1/opportunities/{first}/history", v_hist)

    def v_triage(b):
        need({"status", "message", "items", "total", "shown", "hidden"} <= set(b), "fields missing")
        need(b["status"] in ("clear", "attention", "degraded") and b["shown"] <= 5 and len(b["items"]) == b["shown"], "bad status or more than 5 items")
        need(all({"severity_label", "title", "summary", "action"} <= set(i) for i in b["items"]), "an item lacks title/summary/action")
        if b["status"] == "degraded":
            raise AssertionError(f"some checks could not run: {b['check_errors']}")
        return b["message"] + "".join(f"\n         - {i['severity_label']}: {i['title']}" for i in b["items"])

    run_endpoint(r, client, "Triage: needs-attention strip", "GET", "/api/v1/triage/attention-items", v_triage)

    audit_body: dict = {}

    def v_audit(b):
        need({"ran_at", "status", "counts", "error_count", "sources", "checks", "findings"} <= set(b), "fields missing")
        need(set(b["checks"]) == {"stale_data", "text_consistency", "integrity"}, "a check is missing")
        need(b["counts"]["total"] == len(b["findings"]), "counts do not add up")
        need(all(c["status"] != "failed" for c in b["checks"].values()), "an audit check crashed: " + ", ".join(k for k, c in b["checks"].items() if c["status"] == "failed"))
        audit_body.update(b)
        return f"last run {b['ran_at']}, {b['counts']['error']} errors / {b['counts']['warning']} warnings / {b['counts']['info']} notes"

    run_endpoint(r, client, "Audit: evidence status", "GET", "/api/v1/audit/status", v_audit)
    if audit_body:
        e = audit_body["error_count"]
        r.add(WARN if e else PASS, "Audit: no errors on screen", f"{e} audit error(s) will show in the demo: open the Evidence Audit" if e else "no errors")
        for s in audit_body["sources"]:
            if s["key"] == "gsc" and s["status"] == "stale":
                r.add(WARN, "Search Console data freshness", f"synced {s['last_sync']}, {s['age_days']} days ago: sync again before the demo")
            elif s["key"] == "gsc" and s["status"] == "current":
                r.add(PASS, "Search Console data freshness", f"synced {s['last_sync']}")

    run_endpoint(r, client, "Google connector status", "GET", "/api/v1/gsc/status", lambda b: (need("connected" in b and "configured" in b, "fields missing"), f"configured={b['configured']}, connected={b['connected']}")[1])
    run_endpoint(r, client, "Alerts summary", "GET", "/api/v1/alerts/summary", lambda b: (need({"open_total", "unread_total", "last_check"} <= set(b), "fields missing"), f"{b['open_total']} open alert(s)")[1])
    run_endpoint(r, client, "Custom priorities", "GET", "/api/v1/priorities", lambda b: (need("items" in b or isinstance(b, list), "no list"), "readable")[1])

    sample = [
        {"query": "demo query", "url": "https://example.com/blog/a", "impressions": 200, "average_position": 8.0},
        {"query": "demo query", "url": "https://example.com/blog/b", "impressions": 150, "average_position": 9.0},
    ]

    def v_cann(b):
        need("candidates" in b and b["candidates"] and len(b["candidates"][0]["validation"]["checks"]) == 6, "validation checks missing")
        return f"six-check validation works (sample verdict: {b['candidates'][0]['validation']['label']})"

    run_endpoint(r, client, "Cannibalization validation (pure calculation)", "POST", "/analyze-cannibalization", v_cann, json=sample)


def check_report_pdf(r: Report, client: Client) -> None:
    """The executive PDF must build, be a real multi-page PDF, and carry the disclaimer (read-only: it only reads the data)."""
    t0 = time.perf_counter()
    try:
        res = client.request("GET", "/api/v1/reports/executive-audit-pdf", params={"prepared_for": "Pre-demo check"})
    except Exception as e:  # noqa: BLE001
        r.add(FAIL, "Executive PDF export", f"{type(e).__name__}: {e}"[:200])
        return
    took = time.perf_counter() - t0
    if res.status_code != 200:
        r.add(FAIL, "Executive PDF export", f"HTTP {res.status_code}: {res.text[:150]}")
        return
    data = res.content
    pages = len(re.findall(rb"/Type\s*/Page[^s]", data))
    problems = []
    if not data.startswith(b"%PDF-") or b"%%EOF" not in data[-32:]:
        problems.append("not a complete PDF")
    if res.headers.get("content-type", "").split(";")[0] != "application/pdf":
        problems.append(f"content-type {res.headers.get('content-type')}")
    if pages < 4:
        problems.append(f"only {pages} page(s)")
    if problems:
        r.add(FAIL, "Executive PDF export", "; ".join(problems))
        return
    source = res.headers.get("x-report-source", "?")
    r.add(WARN if took > 10 else PASS, "Executive PDF export", f"{pages} pages, {human_size(len(data))}, built from {source} data ({took:.1f} s)" + ("; DEMO data: it will be marked DEMO DATA on every page" if source == "sample" else ""))


def check_frontend(r: Report, url: str, required: bool) -> None:
    r.start(f"Frontend ({url})")
    import requests

    try:
        res = requests.get(url, timeout=20)
    except requests.RequestException as e:
        r.add(FAIL if required else WARN, "dashboard page", f"not reachable ({type(e).__name__}): start it with  npm run start  in seo-dashboard")
        return
    if res.status_code != 200:
        r.add(FAIL, "dashboard page", f"HTTP {res.status_code}")
        return
    html = res.text
    r.add(PASS if "SEO Opportunities Dashboard" in html else FAIL, "dashboard page renders", "title found" if "SEO Opportunities Dashboard" in html else "the dashboard title is not in the page")
    if "Could not reach the analysis API" in html:
        r.add(FAIL, "frontend can reach the API", "the page is showing 'Could not reach the analysis API': check API_URL for the frontend")
    else:
        r.add(PASS, "frontend can reach the API", "no 'API down' message in the page")


# ---------------------------------------------------------------------------
def main(argv: list[str] | None = None) -> int:
    setup_console()
    ap = argparse.ArgumentParser(description="Pre-demo diagnostic: PASS / WARN / FAIL for the dashboard's databases and critical endpoints.")
    ap.add_argument("--url", help="test a running API over HTTP (default: in-process)")
    ap.add_argument("--frontend", nargs="?", const="http://127.0.0.1:3000", help="also test the web app (default http://127.0.0.1:3000)")
    ap.add_argument("--strict", action="store_true", help="count WARN as FAIL")
    ap.add_argument("--json", action="store_true", help="print the report as JSON at the end")
    args = ap.parse_args(argv)

    started = datetime.datetime.now()
    print(f"Pre-demo check  {started:%Y-%m-%d %H:%M:%S}   project: {ROOT}")
    r = Report()
    check_environment(r)
    missing_lazy = check_databases(r)
    check_backups(r)
    client = Client(args.url)
    check_endpoints(r, client)
    check_report_pdf(r, client)
    if missing_lazy:  # the endpoints above create these on first use; make sure what they created is sound
        r.start("Databases created by the endpoint checks")
        for name in sorted(missing_lazy):
            if (ROOT / name).exists():
                check_one_database(r, name, DATABASES[name], announce_missing=False)
    if args.frontend:
        check_frontend(r, args.frontend, required=True)

    fails, warns = r.count(FAIL), r.count(WARN)
    if args.strict:
        fails, warns = fails + warns, 0
    print("\n" + "=" * 60)
    print(f"{r.count(PASS)} passed, {r.count(WARN)} warning(s), {r.count(FAIL)} failed" + (" (strict: warnings count as failures)" if args.strict else ""))
    verdict = "READY FOR DEMO" if not fails else "NOT READY"
    print(verdict + (f" (with {warns} warning(s) to look at)" if not fails and warns else ""))
    if args.json:
        print(json.dumps({"ready": not fails, "items": r.items}, indent=2))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())

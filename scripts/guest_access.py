#!/usr/bin/env python
"""
Temporary, read-only access to the dashboard for stakeholders, through a public tunnel, without exposing the app itself.

WHY THIS EXISTS. The dashboard and its API have no login. Pointing a tunnel straight at them would let anyone with the URL record
review decisions, disconnect Google, change alert webhooks and spend your AI credits. So guests never reach the app directly: they go
through a small guard proxy (this script) that

  * needs a secret token (a one-time link; the token is swapped for an HttpOnly cookie and removed from the address bar),
  * allows GET and HEAD only: nothing can be created, changed or deleted, and AI features are off (they would spend your key),
  * blocks routes that expose setup rather than results (Google sign-in/properties, alert webhook settings, API docs/openapi),
  * rate-limits each visitor and locks out repeated wrong tokens,
  * binds to 127.0.0.1 only (the tunnel is the only way in), and stops itself when the time limit is up.

COMMANDS
  check                       are the pieces in place, and is anything exposed that should not be?
  token                       print a fresh random token
  serve  [--ttl 120]          run the guard proxy only (point your own tunnel at it)
  tunnel [--provider ...]     run the guard proxy AND a cloudflared / ngrok tunnel, self-test the PUBLIC url, print the link
  verify URL --token T        prove the access controls hold on any URL (local or public)

BEFORE A GUEST SESSION
  1. API on loopback:     uvicorn app:app --host 127.0.0.1 --port 8010
  2. Web app built for same-origin use (a guest's browser cannot reach your localhost:8010):
         cd seo-dashboard && npm run build:guest && npm run start:guest        (serves on 127.0.0.1:3300)
  3. python scripts/guest_access.py check
  4. python scripts/guest_access.py tunnel                     (needs cloudflared or ngrok installed and signed in)

Anyone holding the link can read the dashboard until the time limit. Share it privately, keep the TTL short, and stop the script
(Ctrl-C) when the meeting ends. The token is never written to disk or to the access log.
"""

import argparse
import hashlib
import hmac
import http.server
import json
import os
import queue
import re
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
from collections import defaultdict, deque
from pathlib import Path
from urllib.parse import parse_qsl, unquote, urlencode, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import ROOT, setup_console  # noqa: E402

DEFAULT_PROXY_PORT = 8800
DEFAULT_FRONTEND = "http://127.0.0.1:3300"
DEFAULT_API = "http://127.0.0.1:8010"
DEFAULT_TTL_MINUTES = 120
MAX_TTL_MINUTES = 24 * 60
MIN_TOKEN_LENGTH = 16
COOKIE_NAME = "guest_session"
RATE_LIMIT_PER_MINUTE = 600
FAIL_LIMIT, FAIL_WINDOW_SECONDS = 10, 300  # wrong tokens before a lockout, and how long it lasts
MAX_BODY_BYTES = 1_000_000
UPSTREAM_TIMEOUT = 60

# GET routes that expose setup rather than results. Matched case-insensitively against the decoded path, as a prefix.
BLOCKED_PREFIXES = (
    "/docs", "/redoc", "/openapi.json",
    "/api/v1/gsc/auth-url", "/api/v1/gsc/callback", "/api/v1/gsc/properties", "/gsc/callback",
    "/api/v1/alerts/settings",
)
FORWARD_HEADERS = ("accept", "accept-language", "content-type", "user-agent", "range", "if-none-match", "if-modified-since")
HOP_BY_HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade", "content-encoding", "content-length", "set-cookie", "server", "date"}
SECURITY_HEADERS = {"X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "Cache-Control": "private, no-store"}


# ---------------------------------------------------------------------------
# The guard proxy
# ---------------------------------------------------------------------------
class GuardConfig:
    def __init__(self, token: str, frontend: str, api: str, api_paths: list[re.Pattern], ttl_minutes: int, allow_post: list[re.Pattern], extra_blocked: tuple[str, ...] = ()):
        if len(token) < MIN_TOKEN_LENGTH:
            raise ValueError(f"The token must be at least {MIN_TOKEN_LENGTH} characters (use the 'token' command).")
        self.token = token
        self.frontend, self.api = frontend.rstrip("/"), api.rstrip("/")
        self.api_paths = api_paths
        self.allow_post = allow_post
        self.blocked = tuple(p.lower() for p in BLOCKED_PREFIXES + extra_blocked)
        self.expires_at = time.time() + ttl_minutes * 60
        self.cookie_value = hmac.new(os.urandom(32), b"guest-session-v1", hashlib.sha256).hexdigest()  # per run: old cookies die with the process
        self.lock = threading.Lock()
        self.hits: dict[str, deque] = defaultdict(deque)
        self.fails: dict[str, deque] = defaultdict(deque)


def openapi_patterns(api: str) -> list[re.Pattern]:
    import requests

    spec = requests.get(f"{api}/openapi.json", timeout=10).json()
    out = []
    for path in spec["paths"]:
        if path in ("/", "/docs", "/redoc", "/openapi.json"):
            continue  # "/" must stay the web app
        out.append(re.compile("^" + re.sub(r"\\\{[^/]+?\\\}", "[^/]+", re.escape(path)) + "$"))
    return out


def same(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode(), b.encode())


class Guard(http.server.BaseHTTPRequestHandler):
    server_version = "GuestGuard"
    sys_version = ""
    protocol_version = "HTTP/1.0"  # one request per connection: simple, and fine for a demo

    cfg: GuardConfig  # set on the server

    def log_message(self, *a) -> None:  # silence the default log (it would print the query string, which can hold the token)
        pass

    # -- small helpers
    def client_ip(self) -> str:
        # Only a loopback tunnel can reach this server, so its forwarding headers are the visitor's address.
        fwd = self.headers.get("CF-Connecting-IP") or (self.headers.get("X-Forwarded-For") or "").split(",")[0].strip()
        return fwd or self.client_address[0]

    def is_https(self) -> bool:
        return (self.headers.get("X-Forwarded-Proto", "").lower() == "https") or ('"scheme":"https"' in self.headers.get("CF-Visitor", ""))

    def respond(self, status: int, body: bytes = b"", ctype: str = "text/plain; charset=utf-8", extra: list[tuple[str, str]] | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in SECURITY_HEADERS.items():
            self.send_header(k, v)
        for k, v in extra or []:
            self.send_header(k, v)
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)
        self.log_line(status)

    def log_line(self, status: int) -> None:
        path = urlsplit(self.path).path[:120]  # path only, never the query string
        print(f"{time.strftime('%H:%M:%S')} {self.client_ip():<15} {self.command:<6} {status} {path}", flush=True)

    def throttled(self, ip: str) -> bool:
        now = time.time()
        with self.cfg.lock:
            d = self.cfg.hits[ip]
            while d and now - d[0] > 60:
                d.popleft()
            d.append(now)
            return len(d) > RATE_LIMIT_PER_MINUTE

    def locked_out(self, ip: str) -> bool:
        now = time.time()
        with self.cfg.lock:
            d = self.cfg.fails[ip]
            while d and now - d[0] > FAIL_WINDOW_SECONDS:
                d.popleft()
            return len(d) >= FAIL_LIMIT

    def record_failure(self, ip: str) -> None:
        with self.cfg.lock:
            self.cfg.fails[ip].append(time.time())

    # -- authentication
    def authenticate(self, query: list[tuple[str, str]]) -> str:
        """'ok' (header or cookie), 'exchange' (valid ?access= to swap for a cookie), 'bad' (wrong credential), 'none'."""
        cfg = self.cfg
        auth = self.headers.get("Authorization", "")
        supplied = (auth[7:].strip() if auth.lower().startswith("bearer ") else "") or self.headers.get("X-Guest-Token", "")
        if supplied:
            return "ok" if same(supplied, cfg.token) else "bad"
        cookie = ""
        for part in (self.headers.get("Cookie") or "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == COOKIE_NAME:
                cookie = v
        if cookie and same(cookie, cfg.cookie_value):
            return "ok"
        access = dict(query).get("access")
        if access is not None:
            return "exchange" if same(access, cfg.token) else "bad"
        return "none"

    # -- the one handler for every method
    def handle_any(self) -> None:
        cfg = self.cfg
        ip = self.client_ip()
        if time.time() >= cfg.expires_at:
            return self.respond(410, b"This guest link has expired.\n")
        if self.throttled(ip):
            return self.respond(429, b"Too many requests.\n", extra=[("Retry-After", "60")])
        if self.locked_out(ip):
            return self.respond(429, b"Too many wrong attempts. Try again later.\n", extra=[("Retry-After", str(FAIL_WINDOW_SECONDS))])

        parts = urlsplit(self.path)
        query = parse_qsl(parts.query, keep_blank_values=True)
        verdict = self.authenticate(query)
        if verdict == "bad":
            self.record_failure(ip)
        if verdict in ("bad", "none"):
            return self.respond(401, b"Access link required.\n")

        if verdict == "exchange":  # swap the token in the URL for a cookie, and take it out of the address bar
            if self.command not in ("GET", "HEAD"):
                return self.respond(405, b"Method not allowed.\n", extra=[("Allow", "GET, HEAD")])
            clean = urlencode([(k, v) for k, v in query if k != "access"])
            target = parts.path + (f"?{clean}" if clean else "")
            remaining = max(1, int(cfg.expires_at - time.time()))
            cookie = f"{COOKIE_NAME}={cfg.cookie_value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={remaining}" + ("; Secure" if self.is_https() else "")
            return self.respond(302, b"", extra=[("Location", target or "/"), ("Set-Cookie", cookie)])

        # method policy: read-only
        if self.command not in ("GET", "HEAD") and not (self.command == "POST" and any(p.search(parts.path) for p in cfg.allow_post)):
            return self.respond(405, b"This guest link is read-only.\n", extra=[("Allow", "GET, HEAD")])

        # path policy
        decoded = unquote(parts.path)
        if "\\" in decoded or "\x00" in decoded or "/../" in decoded + "/" or decoded.endswith("/..") or "%2f" in parts.path.lower() or "%2e" in parts.path.lower():
            return self.respond(400, b"Bad path.\n")
        low = decoded.lower()
        if any(low == b or low.startswith(b.rstrip("/") + "/") or low.startswith(b) for b in cfg.blocked):
            return self.respond(403, b"Not available to guests.\n")

        self.forward(parts, query)

    def forward(self, parts, query) -> None:
        import requests

        cfg = self.cfg
        to_api = any(p.match(parts.path) for p in cfg.api_paths)
        base = cfg.api if to_api else cfg.frontend
        kept = urlencode([(k, v) for k, v in query if k != "access"])
        url = base + parts.path + (f"?{kept}" if kept else "")
        headers = {k: v for k, v in ((h, self.headers.get(h)) for h in FORWARD_HEADERS) if v}
        headers["Accept-Encoding"] = "identity"  # no compression between us and the app: simple, and the tunnel compresses anyway
        body = None
        if self.command == "POST":
            n = int(self.headers.get("Content-Length") or 0)
            if n > MAX_BODY_BYTES:
                return self.respond(413, b"Too large.\n")
            body = self.rfile.read(n) if n else b""
        try:
            up = requests.request(self.command, url, headers=headers, data=body, stream=True, allow_redirects=False, timeout=UPSTREAM_TIMEOUT)
        except requests.RequestException:
            return self.respond(502, b"The dashboard is not reachable right now.\n")
        try:
            self.send_response(up.status_code)
            for k, v in up.headers.items():
                kl = k.lower()
                if kl in HOP_BY_HOP or k in SECURITY_HEADERS:
                    continue
                if kl == "location":  # keep redirects on the public address
                    for b in (cfg.frontend, cfg.api):
                        if v.startswith(b):
                            v = v[len(b):] or "/"
                self.send_header(k, v)
            for k, v in SECURITY_HEADERS.items():
                self.send_header(k, v)
            self.send_header("Connection", "close")
            self.end_headers()
            if self.command != "HEAD":
                for chunk in up.iter_content(chunk_size=65536):
                    self.wfile.write(chunk)
            self.log_line(up.status_code)
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            up.close()

    do_GET = do_HEAD = do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = handle_any


def make_server(cfg: GuardConfig, port: int) -> http.server.ThreadingHTTPServer:
    class Handler(Guard):
        pass

    Handler.cfg = cfg
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)  # loopback only
    srv.daemon_threads = True
    return srv


def build_config(args, token: str) -> GuardConfig:
    try:
        patterns = openapi_patterns(args.api)
    except Exception as e:  # noqa: BLE001
        raise SystemExit(f"Cannot read {args.api}/openapi.json ({type(e).__name__}). Is the API running?  uvicorn app:app --host 127.0.0.1 --port 8010")
    return GuardConfig(token, args.frontend, args.api, patterns, args.ttl, [re.compile(p) for p in args.allow_post], tuple(args.block))


# ---------------------------------------------------------------------------
# Verifying the access controls (works on a local or a public URL)
# ---------------------------------------------------------------------------
def verify_url(base: str, token: str) -> list[tuple[str, str, str]]:
    """Returns [(PASS|FAIL, name, detail)]. Sends no request that could change anything: writes are probed with bodies the app rejects."""
    import requests

    base = base.rstrip("/")
    out: list[tuple[str, str, str]] = []

    def rec(ok: bool, name: str, detail: str = "") -> None:
        out.append(("PASS" if ok else "FAIL", name, detail))

    def call(method: str, path: str, **kw):
        return requests.request(method, base + path, timeout=30, allow_redirects=False, **kw)

    auth = {"Authorization": f"Bearer {token}"}
    try:
        r = call("GET", "/")
        rec(r.status_code == 401 and "Dashboard" not in r.text, "no token -> refused", f"HTTP {r.status_code}")
        r = call("GET", "/api/v1/triage/attention-items")
        rec(r.status_code == 401, "no token -> API refused", f"HTTP {r.status_code}")
        r = call("GET", "/?access=definitely-not-the-token")
        rec(r.status_code == 401, "wrong token -> refused", f"HTTP {r.status_code}")
        r = call("GET", "/", headers={"Authorization": "Bearer wrong-wrong-wrong-wrong"})
        rec(r.status_code == 401, "wrong bearer token -> refused", f"HTTP {r.status_code}")

        r = call("GET", f"/api/v1/triage/attention-items?access={token}")
        cookie = r.headers.get("Set-Cookie", "")
        rec(r.status_code == 302 and "access" not in r.headers.get("Location", ""), "valid link -> redirect that removes the token from the URL", f"HTTP {r.status_code} -> {r.headers.get('Location')}")
        rec("HttpOnly" in cookie and "SameSite" in cookie, "session cookie is HttpOnly + SameSite", cookie.split(";")[0][:20] + "..." if cookie else "no cookie")
        cookies = {COOKIE_NAME: cookie.split(";")[0].split("=", 1)[1]} if "=" in cookie else {}
        r = call("GET", "/api/v1/triage/attention-items", cookies=cookies)
        rec(r.status_code == 200 and "items" in r.json(), "cookie -> API data (same origin)", f"HTTP {r.status_code}")
        r = call("GET", "/api/v1/triage/attention-items", headers=auth)
        rec(r.status_code == 200, "bearer token -> API data", f"HTTP {r.status_code}")
        r = call("GET", "/", headers=auth)
        rec(r.status_code == 200 and "text/html" in r.headers.get("Content-Type", ""), "bearer token -> web app", f"HTTP {r.status_code}")
        for h in ("X-Content-Type-Options", "Referrer-Policy", "X-Frame-Options"):
            rec(h in r.headers, f"security header {h}")
        rec(token not in r.text and token not in str(r.headers), "token is not echoed back")

        # writes: sent with a body the app would reject, so even a broken guard cannot change data
        for method, path, kw in (
            ("POST", "/api/v1/opportunities/1/decision", {"json": {}}),
            ("POST", "/api/v1/priorities", {"json": {}}),
            ("DELETE", "/api/v1/priorities/999999999", {}),
            ("PUT", "/api/v1/priorities/999999999", {"json": {}}),
        ):
            r = call(method, path, headers=auth, **kw)
            rec(r.status_code == 405, f"{method} {path} -> blocked (read-only)", f"HTTP {r.status_code}")
        for path in ("/openapi.json", "/docs", "/api/v1/gsc/auth-url", "/api/v1/gsc/properties", "/api/v1/alerts/settings", "/gsc/callback"):
            r = call("GET", path, headers=auth)
            rec(r.status_code == 403, f"GET {path} -> blocked", f"HTTP {r.status_code}")
        for path in ("/api/v1/%2e%2e/docs", "/%2e%2e/%2e%2e/etc/passwd", "/api/v1/..%5cdocs"):
            r = call("GET", path, headers=auth)
            rec(r.status_code in (400, 403, 404), f"traversal {path} -> not served", f"HTTP {r.status_code}")
    except requests.RequestException as e:
        rec(False, "reach the URL", f"{type(e).__name__}: {e}"[:200])
    return out


def print_results(results: list[tuple[str, str, str]]) -> bool:
    for status, name, detail in results:
        print(f"[{status}] {name}" + (f" - {detail}" if detail else ""))
    failed = sum(1 for s, _n, _d in results if s == "FAIL")
    print(f"{len(results) - failed} passed, {failed} failed")
    return failed == 0


# ---------------------------------------------------------------------------
# Tunnels
# ---------------------------------------------------------------------------
class Tunnel:
    name = ""
    url_re: re.Pattern

    def __init__(self) -> None:
        self.proc: subprocess.Popen | None = None
        self.lines: "queue.Queue[str]" = queue.Queue()
        self.tail: deque = deque(maxlen=8)

    def command(self, binary: str, port: int) -> list[str]:
        raise NotImplementedError

    def binary(self) -> str | None:
        return shutil.which(self.name)

    def start(self, port: int, timeout: float = 45.0) -> str:
        binary = self.binary()
        if not binary:
            raise RuntimeError(f"{self.name} is not installed or not on PATH.")
        self.proc = subprocess.Popen(self.command(binary, port), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")

        def pump() -> None:
            assert self.proc and self.proc.stdout
            for line in self.proc.stdout:
                self.tail.append(line.strip())
                self.lines.put(line)

        threading.Thread(target=pump, daemon=True).start()
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                line = self.lines.get(timeout=0.5)
            except queue.Empty:
                if self.proc.poll() is not None:
                    break
                continue
            url = self.parse_url(line)
            if url:
                return url
        self.stop()
        raise RuntimeError(f"{self.name} did not report a public URL. Last output:\n  " + "\n  ".join(self.tail))

    def parse_url(self, line: str) -> str | None:
        m = self.url_re.search(line)
        return m.group(0) if m else None

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self.proc.kill()


class Cloudflared(Tunnel):
    name = "cloudflared"
    url_re = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")

    def command(self, binary: str, port: int) -> list[str]:
        return [binary, "tunnel", "--url", f"http://127.0.0.1:{port}", "--no-autoupdate"]


class Ngrok(Tunnel):
    name = "ngrok"
    url_re = re.compile(r"https://[a-z0-9.-]+\.ngrok[a-z0-9.-]*\.(?:io|app|dev)")

    def command(self, binary: str, port: int) -> list[str]:
        return [binary, "http", f"127.0.0.1:{port}", "--log", "stdout", "--log-format", "json"]

    def parse_url(self, line: str) -> str | None:
        try:
            url = json.loads(line).get("url", "")
        except ValueError:
            url = ""
        m = self.url_re.search(url or line)
        return m.group(0) if m else None


PROVIDERS = {"cloudflared": Cloudflared, "ngrok": Ngrok}


def run_tunnel(args, tunnel: Tunnel | None = None) -> int:
    """Guard proxy + tunnel + a self-test of the PUBLIC address before the link is printed."""
    token = args.token or os.getenv("GUEST_ACCESS_TOKEN") or secrets.token_urlsafe(24)
    if tunnel is None:
        order = [args.provider] if args.provider != "auto" else list(PROVIDERS)
        for name in order:
            if PROVIDERS[name]().binary():
                tunnel = PROVIDERS[name]()
                break
        if tunnel is None:
            print("No tunnel program found. Install one and sign in, then run again:", file=sys.stderr)
            print("  cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ (quick tunnels need no account)", file=sys.stderr)
            print("  ngrok:       https://ngrok.com/download (needs a free account token)", file=sys.stderr)
            print("  or run 'serve' and point any tunnel you already use at the printed port.", file=sys.stderr)
            return 2
    cfg = build_config(args, token)
    server = make_server(cfg, args.port)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    threading.Timer(args.ttl * 60, server.shutdown).start()
    print(f"Guard proxy listening on 127.0.0.1:{args.port} (web app {cfg.frontend}, API {cfg.api}); read-only; expires in {args.ttl} min")
    try:
        public = tunnel.start(args.port)
        print(f"Tunnel ({tunnel.name}) is up at {public}\nSelf-testing the access controls on the PUBLIC address before sharing...")
        if not print_results(verify_url(public, token)):
            print("\nThe access controls did NOT hold on the public address. The link was not printed. Stopping.", file=sys.stderr)
            return 1
        expires = time.strftime("%H:%M", time.localtime(cfg.expires_at))
        print(f"\nShare this link (read-only, expires {expires}, or Ctrl-C to stop now):\n\n  {public}/?access={token}\n")
        print("Anyone with this link can read the dashboard until then. The token is not saved anywhere.")
        while time.time() < cfg.expires_at:
            if tunnel.proc and tunnel.proc.poll() is not None:
                print("The tunnel process exited.", file=sys.stderr)
                return 1
            time.sleep(1)
        print("Time limit reached.")
        return 0
    except KeyboardInterrupt:
        print("\nStopped.")
        return 0
    except RuntimeError as e:
        print(f"Tunnel failed: {e}", file=sys.stderr)
        return 1
    finally:
        tunnel.stop()
        server.shutdown()
        print("Tunnel and guard proxy stopped; the link no longer works.")


# ---------------------------------------------------------------------------
# check
# ---------------------------------------------------------------------------
def reachable(host: str, port: int, timeout: float = 1.5) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def lan_address() -> str | None:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 9))  # no packet is sent; this just picks the outbound interface
            ip = s.getsockname()[0]
        return None if ip.startswith("127.") else ip
    except OSError:
        return None


def cmd_check(args) -> int:
    rows: list[tuple[str, str, str]] = []

    def add(status: str, name: str, detail: str = "") -> None:
        rows.append((status, name, detail))

    fe, api = urlsplit(args.frontend), urlsplit(args.api)
    fe_port, api_port = fe.port or 80, api.port or 80
    add("PASS" if reachable("127.0.0.1", api_port) else "FAIL", f"API answers on {args.api}", "" if reachable("127.0.0.1", api_port) else "start it:  uvicorn app:app --host 127.0.0.1 --port 8010")
    add("PASS" if reachable("127.0.0.1", fe_port) else "FAIL", f"web app answers on {args.frontend}", "" if reachable("127.0.0.1", fe_port) else "start it:  cd seo-dashboard && npm run build:guest && npm run start:guest")

    lan = lan_address()
    if lan:
        for label, port in (("API", api_port), ("web app", fe_port), ("guard proxy", args.port)):
            if reachable(lan, port):
                add("FAIL" if label != "guard proxy" else "WARN", f"{label} (port {port}) is reachable on your network address {lan}",
                    "anyone on your network can use it without the guard: bind it to 127.0.0.1" if label != "guard proxy" else "expected only while serving; the guard still needs the token")
            else:
                add("PASS", f"{label} (port {port}) is not exposed on {lan}")
    else:
        add("PASS", "no network address found besides loopback", "nothing to expose")

    guest_dist = ROOT / "seo-dashboard" / ".next-guest"
    if not guest_dist.exists():
        add("WARN", "web app built for guests (.next-guest)", "not built: a guest's browser would call THEIR localhost:8010. Run  npm run build:guest")
    else:
        leaks = 0
        for p in (guest_dist / "static").rglob("*.js") if (guest_dist / "static").exists() else []:
            try:
                if "127.0.0.1:8010" in p.read_text(encoding="utf-8", errors="ignore"):
                    leaks += 1
            except OSError:
                pass
        add("PASS" if leaks == 0 else "FAIL", "guest build uses same-origin API calls", "no localhost API address in the browser bundles" if leaks == 0 else f"{leaks} bundle(s) still point the browser at 127.0.0.1:8010: rebuild with  npm run build:guest")

    found = [n for n in ("cloudflared", "ngrok") if shutil.which(n)]
    add("PASS" if found else "WARN", "tunnel program", ", ".join(found) if found else "cloudflared / ngrok not on PATH (you can still use 'serve' with a tunnel you already have)")
    if shutil.which("tailscale"):
        add("PASS", "tailscale found", "private sharing works too:  tailscale serve --bg 8800  (guests need Tailscale); use 'serve', not 'tunnel'")
    token_env = os.getenv("GUEST_ACCESS_TOKEN")
    if token_env:
        add("PASS" if len(token_env) >= MIN_TOKEN_LENGTH else "FAIL", "GUEST_ACCESS_TOKEN", f"{len(token_env)} characters" + ("" if len(token_env) >= MIN_TOKEN_LENGTH else f" (needs {MIN_TOKEN_LENGTH}+)"))
    add("PASS", "guard policy", f"GET/HEAD only; blocked: {', '.join(BLOCKED_PREFIXES[:3])}... ; {RATE_LIMIT_PER_MINUTE}/min per visitor; lockout after {FAIL_LIMIT} wrong tokens")
    ok = print_results(rows)
    print("\nNote: the app itself has no login. Never tunnel the web app or the API directly; only the guard proxy (port " + str(args.port) + ").")
    return 0 if ok else 1


# ---------------------------------------------------------------------------
def add_common(p: argparse.ArgumentParser) -> None:
    p.add_argument("--frontend", default=DEFAULT_FRONTEND, help=f"web app (default {DEFAULT_FRONTEND})")
    p.add_argument("--api", default=DEFAULT_API, help=f"API (default {DEFAULT_API})")
    p.add_argument("--port", type=int, default=DEFAULT_PROXY_PORT, help=f"guard proxy port (default {DEFAULT_PROXY_PORT})")


def add_serve_opts(p: argparse.ArgumentParser) -> None:
    add_common(p)
    p.add_argument("--ttl", type=int, default=DEFAULT_TTL_MINUTES, help=f"minutes until the guest link stops working (default {DEFAULT_TTL_MINUTES}, max {MAX_TTL_MINUTES})")
    p.add_argument("--token", help="use this token instead of a random one (or set GUEST_ACCESS_TOKEN)")
    p.add_argument("--allow-post", action="append", default=[], metavar="REGEX", help="let guests POST to paths matching this (e.g. compute-only endpoints). Default: nothing")
    p.add_argument("--block", action="append", default=[], metavar="PREFIX", help="also block this path prefix")


def main(argv: list[str] | None = None) -> int:
    setup_console()
    ap = argparse.ArgumentParser(description="Temporary read-only guest access to the dashboard through a guarded tunnel.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    add_common(sub.add_parser("check", help="verify the pieces and look for anything exposed"))
    sub.add_parser("token", help="print a fresh random token")
    add_serve_opts(sub.add_parser("serve", help="run the guard proxy only"))
    t = sub.add_parser("tunnel", help="guard proxy + public tunnel + self-test")
    add_serve_opts(t)
    t.add_argument("--provider", choices=["auto", *PROVIDERS], default="auto")
    v = sub.add_parser("verify", help="prove the access controls hold on a URL")
    v.add_argument("url")
    v.add_argument("--token", default=os.getenv("GUEST_ACCESS_TOKEN"), required=not os.getenv("GUEST_ACCESS_TOKEN"))
    args = ap.parse_args(argv)

    if args.cmd == "token":
        print(secrets.token_urlsafe(24))
        return 0
    if args.cmd == "check":
        return cmd_check(args)
    if args.cmd == "verify":
        return 0 if print_results(verify_url(args.url, args.token)) else 1
    if not 1 <= args.ttl <= MAX_TTL_MINUTES:
        print(f"--ttl must be between 1 and {MAX_TTL_MINUTES} minutes", file=sys.stderr)
        return 2
    if args.cmd == "tunnel":
        return run_tunnel(args)
    # serve
    token = args.token or os.getenv("GUEST_ACCESS_TOKEN") or secrets.token_urlsafe(24)
    try:
        cfg = build_config(args, token)
    except ValueError as e:
        print(e, file=sys.stderr)
        return 2
    server = make_server(cfg, args.port)
    threading.Timer(args.ttl * 60, server.shutdown).start()
    print(f"Guard proxy on http://127.0.0.1:{args.port}  ->  web app {cfg.frontend}, API {cfg.api}")
    print(f"Read-only, expires in {args.ttl} min. Point your tunnel at port {args.port} (never at the app), then share:\n\n  <your public url>/?access={token}\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        print("Stopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

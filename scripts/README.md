# Operational scripts

Run from the project folder (`b2b-accounts`) with `python scripts/<name>.py`, or from `seo-dashboard` with the npm shortcuts below.
No `make` on Windows? Use npm. (A `Makefile` with the same targets is in the project root for machines that have it.)

| npm (inside `seo-dashboard`) | What it does |
|---|---|
| `npm run backup` | Back up every SQLite database into `backups/`, prune archives older than 30 days |
| `npm run backup:dry` | Show what would be backed up and pruned; change nothing |
| `npm run backups` | List existing backups |
| `npm run pre-demo` | PASS / WARN / FAIL report on databases and critical endpoints (in-process, no server needed) |
| `npm run pre-demo:live` | The same, over HTTP against the running API (8010) and web app (3000) |
| `npm run guest:check` | Are the guest-access pieces in place, and is anything exposed that should not be? |
| `npm run guest:tunnel` | Read-only public link for stakeholders (guard proxy + cloudflared/ngrok + self-test) |
| `npm run build:guest` / `start:guest` | Build and serve the web app for guest sessions (port 3300) |

## backup_database.py

Archives `accounts.db`, `governance.db`, `audit.db`, `priorities.db`, `alerts.db` and `gsc_connector.db` (every `*.db` in the project
folder) into `backups/seo-dashboard-backup-<UTC timestamp>.zip`, with a `manifest.json` (sizes, row counts, SHA-256).

- Uses SQLite's online-backup API, so copies are consistent while the API is running. Each copy is integrity-checked before it is archived.
- If any database fails, the run exits 1, writes no archive and **prunes nothing**.
- Only archives named like its own are ever deleted. Options: `--keep-days N`, `--dir PATH`, `--dry-run`, `--list`.
- **Not included:** `gsc_connector.key` (decrypts the Google token in `gsc_connector.db`) and `.env`. Keep the key somewhere safe; without it,
  restore the data and reconnect Google. `backups/` gets a `.gitignore` that ignores everything: it holds client data.
- **Restore:** stop the API, unzip an archive, copy the `.db` files over the ones in the project folder, start the API.
- Schedule it (Windows): Task Scheduler, action `python C:\Users\Ninad\b2b-accounts\scripts\backup_database.py`, daily.

## pre_demo_check.py

Environment (Python, packages, `.env`, AI key and Google OAuth presence, never their values), each database (opens, `integrity_check`, expected
tables and columns, the decision log's append-only triggers and hash chain), backup age, then the critical endpoints: governance, triage,
audit, Google status, alerts, priorities and the cannibalization validation. Exit 0 = ready (warnings are listed), 1 = something failed.
`--strict` turns warnings into failures, `--json` adds a machine-readable report.

Read-only, with two small side effects: `GET /audit/status` stores a fresh audit run when the evidence changed, and databases for features
never used yet are created empty. It never records a decision, locks a baseline, calls an AI model, or contacts Google.

## guest_access.py

**The dashboard and API have no login.** Never point a tunnel straight at them: anyone with the URL could record review decisions, disconnect
Google, change alert webhooks and spend your AI credits. Guests go through a guard proxy instead:

- a secret token is required (the one-time link swaps it for an `HttpOnly` cookie and removes it from the address bar);
- **read-only**: GET/HEAD only. Creating, editing and AI generation are off for guests (they would spend your key);
- blocks setup routes: API docs/openapi, Google sign-in/properties, alert webhook settings;
- 600 requests/min per visitor, lockout after 10 wrong tokens, 24 h hard maximum, default 2 h, then every request returns 410;
- binds to `127.0.0.1` only; the access log never records the token or query strings; the token is not saved to disk.

Session steps:

1. `uvicorn app:app --host 127.0.0.1 --port 8010` (loopback, not `0.0.0.0`)
2. `cd seo-dashboard && npm run build:guest && npm run start:guest` (the browser must call the API on the same origin; the normal build points it at
   `127.0.0.1:8010`, which a guest's machine cannot reach)
3. `npm run guest:check`
4. `npm run guest:tunnel` — needs `cloudflared` (quick tunnels need no account) or `ngrok` (free account token). It starts the guard and the tunnel,
   **runs the 26-check access-control test against the public address**, and only then prints the link. If a check fails, no link is printed.
5. Ctrl-C when the meeting ends. The link stops working immediately.

Other commands: `serve` (guard only, bring your own tunnel, e.g. `tailscale serve --bg 8800` for a private tailnet link), `token`, and
`verify <url> --token T` to re-test any address. If a tunnel is already in use, point it at the guard port (8800), never at the app.

Verified here against a local API and web app, and with a stand-in tunnel; **not** against a real cloudflared/ngrok tunnel (neither is installed on this machine).

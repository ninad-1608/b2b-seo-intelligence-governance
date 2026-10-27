"""Shared helpers for the operational scripts: where things live, the database registry, and console output."""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # the backend folder that holds app.py and the *.db files
BACKUP_DIR = ROOT / "backups"

# Every SQLite database the app writes, with what a healthy copy must contain. `lazy` databases are created the first time
# their feature is used, so a fresh install legitimately does not have them yet.
DATABASES: dict[str, dict] = {
    "accounts.db": {
        "role": "main",
        "lazy": False,
        "tables": {"accounts": ["id", "company_name", "domain", "hubspot_lifecycle_stage", "estimated_deal_size"]},
    },
    "governance.db": {
        "role": "reviews and the append-only decision log",
        "lazy": True,
        "tables": {
            "governance_state": ["opportunity_id", "status", "reviewer", "verdict", "decided_at", "baseline_json", "baseline_locked_at", "updated_at"],
            "governance_history": ["id", "opportunity_id", "event", "actor", "from_status", "to_status", "created_at", "prev_hash", "hash"],
        },
        "triggers": ["governance_history_no_update", "governance_history_no_delete"],
    },
    "audit.db": {
        "role": "evidence audit runs",
        "lazy": True,
        "tables": {"audit_runs": ["id", "ran_at", "result_json"]},
    },
    "priorities.db": {
        "role": "custom business priorities",
        "lazy": True,
        "tables": {"priorities": ["id", "name", "keyword", "impressions", "level", "first_party_evidence", "ranking_opportunity", "query_url_evidence"]},
    },
    "alerts.db": {
        "role": "alerts and their settings",
        "lazy": True,
        "tables": {
            "alerts": ["id", "fingerprint", "kind", "severity", "title", "detail", "status", "created_at"],
            "settings": ["id", "thresholds_json"],
            "kv": ["key", "value"],
        },
    },
    "gsc_connector.db": {
        "role": "Google connection and synced Search Console rows (token is encrypted)",
        "lazy": True,
        "tables": {
            "connection": ["id", "refresh_token_enc", "scopes", "connected_at"],
            "sync_meta": ["id", "site_url", "start_date", "end_date", "synced_at"],
            "gsc_rows": ["period", "query", "page", "clicks", "impressions", "ctr", "position"],
            "health": ["key", "value"],
        },
    },
}


def setup_console() -> None:
    """Windows consoles default to a legacy code page; never crash on a character."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def human_size(n: int) -> str:
    size = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.0f} {unit}" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024
    return f"{n} B"


def discover_databases(root: Path = ROOT) -> list[Path]:
    """Every *.db in the backend folder (the registry above says what each one is)."""
    return sorted(p for p in root.glob("*.db") if p.is_file())

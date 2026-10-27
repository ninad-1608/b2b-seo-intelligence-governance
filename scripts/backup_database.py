#!/usr/bin/env python
"""
Back up every SQLite database the dashboard uses into one timestamped zip, then delete archives older than 30 days.

    python scripts/backup_database.py              back up now
    python scripts/backup_database.py --dry-run    show what would be backed up and pruned, change nothing
    python scripts/backup_database.py --list       list the archives that exist
    python scripts/backup_database.py --keep-days 14 --dir D:/seo-backups

How it stays safe:
  * It copies with SQLite's own online-backup API, so a copy is consistent even while the API is writing (a plain file copy is not).
  * Each copy is opened and checked (PRAGMA integrity_check) before it goes into the archive. If any database fails, the run
    exits 1 and NOTHING is pruned, so a bad night never eats your last good backup.
  * Only archives whose names match this script's pattern are ever deleted; nothing else in the folder is touched.
  * The archive is written to a temporary name and renamed only when complete.

What is NOT in the archive: gsc_connector.key (the key that decrypts the Google token in gsc_connector.db) and .env. Keep the key
somewhere safe on its own; without it, restore the data and reconnect Google. The backups folder holds client data, so it is
created with a .gitignore that ignores everything: keep it out of version control and shared drives.

Restore (stop the API first): unzip an archive and copy the .db files over the ones in the project folder.
Exit codes: 0 ok, 1 a database could not be backed up or verified, 2 nothing to back up / bad arguments.
"""

import argparse
import datetime
import hashlib
import json
import re
import sqlite3
import sys
import tempfile
import time
import zipfile
from contextlib import closing
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import BACKUP_DIR, DATABASES, ROOT, discover_databases, human_size, setup_console  # noqa: E402

PREFIX = "seo-dashboard-backup-"
NAME_RE = re.compile(rf"^{PREFIX}(\d{{8}}T\d{{6}}Z)\.zip$")
STAMP_FMT = "%Y%m%dT%H%M%SZ"


def archive_time(path: Path) -> datetime.datetime | None:
    m = NAME_RE.match(path.name)
    if not m:
        return None
    return datetime.datetime.strptime(m.group(1), STAMP_FMT).replace(tzinfo=datetime.timezone.utc)


def list_archives(directory: Path) -> list[Path]:
    return sorted((p for p in directory.glob(f"{PREFIX}*.zip") if archive_time(p)), key=archive_time)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def copy_database(src: Path, dest: Path) -> dict:
    """Consistent copy via the SQLite backup API, then verify the copy. Returns what was found; raises on any problem."""
    with closing(sqlite3.connect(f"{src.as_uri()}?mode=ro", uri=True)) as s, closing(sqlite3.connect(dest)) as d:
        s.backup(d)
    with closing(sqlite3.connect(dest)) as d:
        result = d.execute("PRAGMA integrity_check").fetchall()
        if result != [("ok",)]:
            raise RuntimeError(f"integrity_check failed on the copy: {result[:3]}")
        tables = [r[0] for r in d.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        rows = {t: d.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for t in tables}
    return {"tables": rows, "bytes": dest.stat().st_size, "sha256": sha256(dest)}


def prune(directory: Path, keep_days: int, now: datetime.datetime, protect: Path | None, dry_run: bool) -> list[Path]:
    cutoff = now - datetime.timedelta(days=keep_days)
    old = [p for p in list_archives(directory) if archive_time(p) < cutoff and p != protect]
    for p in old:
        if not dry_run:
            p.unlink()
    return old


def main(argv: list[str] | None = None) -> int:
    setup_console()
    ap = argparse.ArgumentParser(description="Back up all dashboard SQLite databases into a timestamped zip and prune old archives.")
    ap.add_argument("--dir", type=Path, default=BACKUP_DIR, help=f"where archives go (default {BACKUP_DIR})")
    ap.add_argument("--source", type=Path, default=ROOT, help="folder holding the *.db files (default: the project folder)")
    ap.add_argument("--keep-days", type=int, default=30, help="delete archives older than this many days (default 30)")
    ap.add_argument("--dry-run", action="store_true", help="report only; write and delete nothing")
    ap.add_argument("--list", action="store_true", help="list existing archives and exit")
    args = ap.parse_args(argv)

    if args.keep_days < 1:
        print("--keep-days must be at least 1", file=sys.stderr)
        return 2
    now = datetime.datetime.now(datetime.timezone.utc)

    if args.list:
        archives = list_archives(args.dir) if args.dir.exists() else []
        if not archives:
            print(f"No backups in {args.dir}")
        for p in archives:
            age = (now - archive_time(p)).days
            print(f"{p.name}  {human_size(p.stat().st_size):>9}  {age} day(s) old")
        return 0

    dbs = discover_databases(args.source)
    if not dbs:
        print(f"No .db files found in {args.source}; nothing to back up.", file=sys.stderr)
        return 2
    present = {p.name for p in dbs}
    for name, meta in DATABASES.items():
        if name not in present and args.source.resolve() == ROOT:
            print(f"note: {name} ({meta['role']}) does not exist yet; it is created the first time that feature is used.")

    if args.dry_run:
        print(f"DRY RUN: would archive {len(dbs)} database(s) from {args.source} into {args.dir}:")
        for p in dbs:
            print(f"  {p.name}  {human_size(p.stat().st_size)}")
        old = prune(args.dir, args.keep_days, now, None, dry_run=True) if args.dir.exists() else []
        print(f"would delete {len(old)} archive(s) older than {args.keep_days} days" + "".join(f"\n  {p.name}" for p in old))
        return 0

    args.dir.mkdir(parents=True, exist_ok=True)
    guard = args.dir / ".gitignore"
    if not guard.exists():
        guard.write_text("# backups hold client data: never commit them\n*\n", encoding="utf-8")

    final = args.dir / f"{PREFIX}{now.strftime(STAMP_FMT)}.zip"
    while final.exists():  # names have one-second resolution: let the clock move on rather than overwrite or fail
        time.sleep(1.05)
        now = datetime.datetime.now(datetime.timezone.utc)
        final = args.dir / f"{PREFIX}{now.strftime(STAMP_FMT)}.zip"
    partial = final.with_suffix(".zip.partial")

    manifest = {"created_at": now.isoformat(timespec="seconds"), "source": str(args.source), "databases": {}}
    failures: list[str] = []
    with tempfile.TemporaryDirectory(prefix="seo-backup-") as tmp:
        tmpdir = Path(tmp)
        for p in dbs:
            try:
                info = copy_database(p, tmpdir / p.name)
                manifest["databases"][p.name] = info
                print(f"  ok    {p.name:<18} {human_size(info['bytes']):>9}  " + ", ".join(f"{t}={n}" for t, n in info["tables"].items()))
            except Exception as e:  # noqa: BLE001 - report every database, not just the first failure
                failures.append(p.name)
                print(f"  FAIL  {p.name:<18} {type(e).__name__}: {e}")
        if failures:
            print(f"\nBackup FAILED for: {', '.join(failures)}. No archive was written and nothing was pruned.", file=sys.stderr)
            return 1
        with zipfile.ZipFile(partial, "w", zipfile.ZIP_DEFLATED) as z:
            for name in manifest["databases"]:
                z.write(tmpdir / name, name)
            z.writestr("manifest.json", json.dumps(manifest, indent=2))
    # prove the archive reads back before it replaces anything
    with zipfile.ZipFile(partial) as z:
        bad = z.testzip()
    if bad:
        partial.unlink(missing_ok=True)
        print(f"Archive check failed on {bad}; nothing was kept or pruned.", file=sys.stderr)
        return 1
    partial.rename(final)
    print(f"\nWrote {final} ({human_size(final.stat().st_size)}, {len(manifest['databases'])} databases)")

    old = prune(args.dir, args.keep_days, now, protect=final, dry_run=False)
    print(f"Removed {len(old)} archive(s) older than {args.keep_days} days" + "".join(f"\n  {p.name}" for p in old))
    print(f"{len(list_archives(args.dir))} archive(s) kept in {args.dir}")
    key = args.source / "gsc_connector.key"
    if key.exists():
        print("reminder: gsc_connector.key is not in the archive. Store it separately or you must reconnect Google after a restore.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

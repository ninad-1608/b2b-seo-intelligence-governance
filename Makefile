# Convenience targets. On Windows without `make`, use the npm scripts instead (run them inside seo-dashboard):
#   npm run backup | pre-demo | guest:check | guest:tunnel
PYTHON ?= python

.PHONY: backup backup-dry backups pre-demo pre-demo-live guest-check guest-tunnel

backup:
	$(PYTHON) scripts/backup_database.py

backup-dry:
	$(PYTHON) scripts/backup_database.py --dry-run

backups:
	$(PYTHON) scripts/backup_database.py --list

pre-demo:
	$(PYTHON) scripts/pre_demo_check.py

pre-demo-live:
	$(PYTHON) scripts/pre_demo_check.py --url http://127.0.0.1:8010 --frontend

guest-check:
	$(PYTHON) scripts/guest_access.py check

guest-tunnel:
	$(PYTHON) scripts/guest_access.py tunnel

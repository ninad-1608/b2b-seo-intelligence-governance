"""Where the SQLite databases and the GSC key live.

Defaults to the backend folder (local development). In production set DATA_DIR to a
persistent disk (for example /var/data on Render) so data survives restarts and deploys.
"""
import os
from pathlib import Path

DATA_DIR = Path(os.getenv("DATA_DIR") or Path(__file__).resolve().parent)
DATA_DIR.mkdir(parents=True, exist_ok=True)

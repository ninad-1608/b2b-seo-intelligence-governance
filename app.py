"""B2B target accounts prototype: FastAPI + SQLite, single file.

Run:  pip install fastapi uvicorn
      uvicorn app:app --reload
"""
import io
import sqlite3
from collections import defaultdict
from contextlib import closing
from typing import Literal

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
import pandas as pd
from ai_router import router as ai_router
from decay_router import router as decay_router
from geo_router import router as geo_router
from scoring_router import router as scoring_router
from cannibalization_router import router as cannibalization_router
from internal_links_router import router as internal_links_router
from site_auditor_router import router as site_auditor_router
from content_brief_router import router as content_brief_router
from geo_simulator_router import router as geo_simulator_router
from topic_cluster_router import router as topic_cluster_router
from crawler_simulator_router import router as crawler_simulator_router
from content_refresh_router import router as content_refresh_router
from gsc_connector_router import load_rows as load_gsc_rows, router as gsc_connector_router
from priorities_router import router as priorities_router
from alerting_engine_router import router as alerting_router
from forecasting_engine_router import router as forecasting_router
from opportunities_router import router as opportunities_router
from triage_router import router as triage_router
from evidence_audit_router import audit_lifespan, router as evidence_audit_router
from report_router import router as report_router
from cannibalization_validation import router as cannibalization_validation_router, stored_evidence, validate_query
from pydantic import BaseModel, Field

DB_PATH = "accounts.db"
MIN_IMPRESSIONS = 10  # a URL only counts toward cannibalization above this
HIGH_RISK_IMPRESSIONS = 500  # total query impressions above this -> High
MEDIUM_RISK_IMPRESSIONS = 100  # 100-500 -> Medium, anything lower -> Low


def risk_level_for(total_impressions: int) -> Literal["High", "Medium", "Low"]:
    if total_impressions > HIGH_RISK_IMPRESSIONS:
        return "High"
    if total_impressions >= MEDIUM_RISK_IMPRESSIONS:
        return "Medium"
    return "Low"
LIFECYCLE_STAGES = ("Subscriber", "Lead", "MQL", "SQL", "Opportunity", "Customer")

app = FastAPI(title="B2B Target Accounts", lifespan=audit_lifespan)

app.include_router(ai_router)
app.include_router(decay_router)
app.include_router(geo_router)
app.include_router(scoring_router)
app.include_router(cannibalization_router)
app.include_router(internal_links_router)
app.include_router(site_auditor_router)
app.include_router(content_brief_router)
app.include_router(geo_simulator_router)
app.include_router(topic_cluster_router)
app.include_router(crawler_simulator_router)
app.include_router(content_refresh_router)
app.include_router(gsc_connector_router)
app.include_router(priorities_router)
app.include_router(alerting_router, prefix="/api/v1")
app.include_router(forecasting_router, prefix="/api/v1")
app.include_router(opportunities_router, prefix="/api/v1")
app.include_router(triage_router, prefix="/api/v1")
app.include_router(evidence_audit_router, prefix="/api/v1")
app.include_router(cannibalization_validation_router, prefix="/api/v1")
app.include_router(report_router, prefix="/api/v1")

origins = [
    "http://localhost:3000",
    "http://localhost:3001",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:3001",
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition", "X-Report-Source", "X-Report-Pages"],  # so the browser can name the downloaded report
)


class AccountIn(BaseModel):
    company_name: str = Field(min_length=1)
    domain: str = Field(min_length=1)
    hubspot_lifecycle_stage: Literal[LIFECYCLE_STAGES]
    estimated_deal_size: float = Field(ge=0)


class Account(AccountIn):
    id: int


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    stages = ", ".join(f"'{s}'" for s in LIFECYCLE_STAGES)
    with closing(get_conn()) as conn, conn:
        conn.execute(
            f"""
            CREATE TABLE IF NOT EXISTS accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                company_name TEXT NOT NULL,
                domain TEXT NOT NULL UNIQUE,
                hubspot_lifecycle_stage TEXT NOT NULL
                    CHECK (hubspot_lifecycle_stage IN ({stages})),
                estimated_deal_size REAL NOT NULL CHECK (estimated_deal_size >= 0)
            )
            """
        )


init_db()


@app.get("/", response_model=list[Account])
def list_accounts():
    """All accounts, largest estimated deal size first."""
    with closing(get_conn()) as conn:
        rows = conn.execute(
            "SELECT * FROM accounts ORDER BY estimated_deal_size DESC, company_name"
        ).fetchall()
    return [dict(r) for r in rows]


@app.post("/accounts", response_model=Account, status_code=201)
def create_account(account: AccountIn):
    try:
        with closing(get_conn()) as conn, conn:
            cur = conn.execute(
                "INSERT INTO accounts (company_name, domain, hubspot_lifecycle_stage, "
                "estimated_deal_size) VALUES (?, ?, ?, ?)",
                (
                    account.company_name,
                    account.domain.lower(),
                    account.hubspot_lifecycle_stage,
                    account.estimated_deal_size,
                ),
            )
            account_id = cur.lastrowid
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail="An account with this domain already exists")
    return {**account.model_dump(), "domain": account.domain.lower(), "id": account_id}


class GSCDataRow(BaseModel):
    query: str = Field(min_length=1)
    url: str = Field(min_length=1)
    impressions: int = Field(ge=0)
    average_position: float = Field(ge=0)


class UrlStat(BaseModel):
    url: str
    impressions: int
    average_position: float


class QueryReport(BaseModel):
    query: str
    status: Literal["Cannibalization Risk", "OK"]
    risk_level: Literal["High", "Medium", "Low"] | None  # only set when flagged
    total_impressions: int
    competing_urls: list[UrlStat]  # URLs above the impression threshold, best first
    validation: dict | None = None  # the six validation checks and the verdict; set on every candidate


class CannibalizationReport(BaseModel):
    total_queries: int
    queries_at_risk: int  # harmful overlaps only
    flagged: list[QueryReport]  # harmful overlaps only
    candidates: list[QueryReport] = []  # every query that looked like a split, with its verdict (harmful, false positive or cleared)
    verdict_counts: dict[str, int] = {}
    all_queries: list[QueryReport]


def detect_cannibalization(rows: list[GSCDataRow], previous: dict[str, dict[str, tuple[float, float]]] | None = None, use_stored_evidence: bool = False) -> CannibalizationReport:
    """Find queries with more than one distinct URL above 10 impressions (the candidates), then run the six validation checks on each.

    Only candidates that survive every check are flagged as harmful. The others stay in `candidates` with their verdict
    ("False positive" or "Cleared by validation checks") so the reason is visible.

    Rows sharing the same query and URL are merged first: impressions are summed and average_position is impression-weighted.
    `previous` ({query: {url: (impressions, position)}}) and the evidence stored by a deep check are used when available.
    """
    # query -> url -> [impressions, position * impressions, position sum, row count]
    merged: dict[str, dict[str, list[float]]] = defaultdict(dict)
    display_name: dict[str, str] = {}
    for r in rows:
        key = r.query.strip().lower()
        display_name.setdefault(key, r.query.strip())
        acc = merged[key].setdefault(r.url.strip(), [0, 0.0, 0.0, 0])
        acc[0] += r.impressions
        acc[1] += r.average_position * r.impressions
        acc[2] += r.average_position
        acc[3] += 1

    reports: list[QueryReport] = []
    for key, urls in merged.items():
        stats = []
        for url, (imps, weighted, pos_sum, n) in urls.items():
            # Fall back to a plain mean when every row has zero impressions.
            position = weighted / imps if imps else pos_sum / n
            stats.append(UrlStat(url=url, impressions=int(imps), average_position=round(position, 2)))
        competing = sorted(
            (s for s in stats if s.impressions > MIN_IMPRESSIONS),
            key=lambda s: (s.average_position, -s.impressions),
        )
        is_candidate = len(competing) > 1
        total = sum(s.impressions for s in stats)
        validation = None
        if is_candidate:
            evidence = (stored_evidence(display_name[key]) or {}) if use_stored_evidence else {}
            if previous and previous.get(key):
                evidence = {**evidence, "previous": previous[key]}
            validation = validate_query(
                display_name[key],
                [{"url": s.url, "impressions": s.impressions, "position": s.average_position} for s in competing],
                evidence or None,
            )
        harmful = bool(validation and validation["verdict"] == "harmful")
        reports.append(
            QueryReport(
                query=display_name[key],
                status="Cannibalization Risk" if harmful else "OK",
                risk_level=risk_level_for(total) if harmful else None,
                total_impressions=total,
                competing_urls=competing,
                validation=validation,
            )
        )

    reports.sort(key=lambda q: (q.status != "Cannibalization Risk", -q.total_impressions))
    flagged = [q for q in reports if q.status == "Cannibalization Risk"]
    candidates = sorted((q for q in reports if q.validation), key=lambda q: (q.validation["verdict"] != "harmful", -q.total_impressions))
    counts = {"harmful": 0, "false_positive": 0, "cleared": 0}
    for q in candidates:
        counts[q.validation["verdict"]] += 1
    return CannibalizationReport(
        total_queries=len(reports),
        queries_at_risk=len(flagged),
        flagged=flagged,
        candidates=candidates,
        verdict_counts=counts,
        all_queries=reports,
    )


@app.post("/analyze-cannibalization", response_model=CannibalizationReport)
def analyze_cannibalization(rows: list[GSCDataRow]):
    return detect_cannibalization(rows)


@app.get("/api/v1/gsc/cannibalization", response_model=CannibalizationReport)
def gsc_cannibalization():
    """Cannibalization analysis on the Search Console data synced through the Google connector."""
    rows = load_gsc_rows("current")
    if not rows:
        raise HTTPException(status_code=404, detail="No synced Search Console data yet. Run a sync first.")
    prev: dict[str, dict[str, tuple[float, float]]] = {}
    for q, page, _c, imps, _ctr, pos in load_gsc_rows("previous"):
        a = prev.setdefault(q.strip().lower(), {}).setdefault(page.strip(), [0, 0.0])
        a[0] += imps
        a[1] += pos * imps
    previous = {q: {u: (a[0], (a[1] / a[0]) if a[0] else 0.0) for u, a in urls.items()} for q, urls in prev.items()}
    return detect_cannibalization(
        [GSCDataRow(query=r[0], url=r[1], impressions=r[3], average_position=max(0.0, r[5])) for r in rows if r[0] and r[1]],
        previous=previous,
        use_stored_evidence=True,
    )


# Accepted header spellings after lowercasing/stripping (Search Console exports vary).
CSV_COLUMN_ALIASES = {
    "query": ("query", "queries", "top queries", "top query"),
    "url": ("url", "page", "pages", "top pages", "landing page"),
    "impressions": ("impressions",),
    "average_position": ("position", "average position", "avg. position", "avg position"),
}


class UploadReport(BaseModel):
    filename: str
    total_rows_processed: int
    rows_skipped: int  # rows with a blank query/URL or non-numeric impressions/position
    alerts: list[QueryReport]  # harmful overlaps only
    candidates: list[QueryReport] = []  # every candidate with its validation verdict
    verdict_counts: dict[str, int] = {}


@app.post("/upload-gsc-csv", response_model=UploadReport)
async def upload_gsc_csv(file: UploadFile = File(...)):
    """Analyze a Search Console CSV export (needs both a query and a page column)."""
    filename = file.filename or "upload.csv"
    raw = await file.read()
    if not raw.strip():
        raise HTTPException(status_code=400, detail="The uploaded file is empty")

    try:
        # utf-8-sig strips the BOM that Excel and GSC exports add.
        df = pd.read_csv(io.BytesIO(raw), encoding="utf-8-sig", dtype=str)
    except (UnicodeDecodeError, pd.errors.ParserError, pd.errors.EmptyDataError) as e:
        raise HTTPException(status_code=400, detail=f"Could not parse CSV: {e}")

    df.columns = [str(c).strip().lower() for c in df.columns]
    renames, missing = {}, []
    for target, aliases in CSV_COLUMN_ALIASES.items():
        found = next((a for a in aliases if a in df.columns), None)
        if found is None:
            missing.append(target)
        else:
            renames[found] = target
    if missing:
        raise HTTPException(
            status_code=422,
            detail=f"Missing required column(s): {', '.join(missing)}. Found: {', '.join(df.columns)}",
        )
    df = df.rename(columns=renames)[list(CSV_COLUMN_ALIASES)]

    for col in ("impressions", "average_position"):
        # GSC exports can contain thousands separators ("1,200").
        df[col] = pd.to_numeric(df[col].str.replace(",", "", regex=False), errors="coerce")
    for col in ("query", "url"):
        df[col] = df[col].str.strip()
    total = len(df)
    df = df.dropna()
    df = df[(df["query"] != "") & (df["url"] != "") & (df["impressions"] >= 0) & (df["average_position"] >= 0)]
    if df.empty:
        raise HTTPException(status_code=422, detail="No valid rows found in the CSV")

    rows = [
        GSCDataRow(
            query=r.query,
            url=r.url,
            impressions=int(r.impressions),
            average_position=float(r.average_position),
        )
        for r in df.itertuples(index=False)
    ]
    report = detect_cannibalization(rows)
    return UploadReport(
        filename=filename,
        total_rows_processed=len(rows),
        rows_skipped=total - len(rows),
        alerts=report.flagged,
        candidates=report.candidates,
        verdict_counts=report.verdict_counts,
    )

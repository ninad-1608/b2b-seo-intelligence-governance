"""Content Decay & Refresh Engine: compare two GSC windows, flag decayed pages, draft refresh briefs."""
import asyncio
import io
from collections import defaultdict

import pandas as pd
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, ValidationError
from starlette.datastructures import UploadFile  # request.form() yields Starlette's class, not FastAPI's subclass

from ai_router import client

router = APIRouter(prefix="/api/v1", tags=["Content Decay"])

MAX_ROWS = 50_000
HIGH_SEVERITY_DROP = 50.0  # worst-of(impressions, clicks) drop, in %
MEDIUM_SEVERITY_DROP = 35.0  # 20-35 -> Low (when the threshold is the default 20)


class MetricRow(BaseModel):
    url: str = Field(min_length=1)
    query: str = ""
    impressions: int = Field(ge=0)
    clicks: int = Field(ge=0)
    average_position: float = Field(ge=0)


class DecayRequest(BaseModel):
    previous: list[MetricRow] = Field(max_length=MAX_ROWS)  # older window (e.g. days 31-60)
    current: list[MetricRow] = Field(max_length=MAX_ROWS)  # recent window (e.g. days 1-30)
    min_prior_impressions: int = Field(default=500, ge=0)  # "high former impression volume"
    drop_threshold_pct: float = Field(default=20.0, ge=0, le=100)


class _Agg:
    """Impressions/clicks totals plus an impression-weighted average position."""

    __slots__ = ("impressions", "clicks", "_pos_weight")

    def __init__(self) -> None:
        self.impressions = 0
        self.clicks = 0
        self._pos_weight = 0.0

    def add(self, row: MetricRow) -> None:
        self.impressions += row.impressions
        self.clicks += row.clicks
        self._pos_weight += row.average_position * row.impressions

    @property
    def position(self) -> float | None:
        return round(self._pos_weight / self.impressions, 2) if self.impressions else None


def _drop_pct(prior: int, current: int) -> float:
    """% loss (positive = decline). 0 when there was nothing to lose."""
    if prior <= 0:
        return 0.0
    return round((prior - current) / prior * 100, 1)


def _pos_change(prior: float | None, current: float | None) -> float | None:
    """Positive = rankings got worse (higher position number)."""
    if prior is None or current is None:
        return None
    return round(current - prior, 2)


def _severity(worst_drop: float) -> str:
    if worst_drop >= HIGH_SEVERITY_DROP:
        return "High"
    if worst_drop >= MEDIUM_SEVERITY_DROP:
        return "Medium"
    return "Low"


def _aggregate(rows: list[MetricRow], key) -> dict:
    out: dict = defaultdict(_Agg)
    for r in rows:
        out[key(r)].add(r)
    return out


def _compare(prior: _Agg, current: _Agg) -> dict:
    return {
        "prior_impressions": prior.impressions,
        "current_impressions": current.impressions,
        "impressions_drop_pct": _drop_pct(prior.impressions, current.impressions),
        "prior_clicks": prior.clicks,
        "current_clicks": current.clicks,
        "clicks_drop_pct": _drop_pct(prior.clicks, current.clicks),
        "prior_position": prior.position,
        "current_position": current.position,
        "position_change": _pos_change(prior.position, current.position),
    }


def _run_decay(data: DecayRequest) -> dict:
    empty = _Agg()
    url_prev = _aggregate(data.previous, lambda r: r.url.strip())
    url_cur = _aggregate(data.current, lambda r: r.url.strip())
    pair_prev = _aggregate(data.previous, lambda r: (r.url.strip(), r.query.strip()))
    pair_cur = _aggregate(data.current, lambda r: (r.url.strip(), r.query.strip()))

    queries_by_url: dict[str, list[dict]] = defaultdict(list)
    for (url, query), prior in pair_prev.items():
        if not query or prior.impressions == 0:
            continue
        cmp = _compare(prior, pair_cur.get((url, query), empty))
        queries_by_url[url].append({"query": query, **cmp})

    decayed = []
    for url, prior in url_prev.items():
        if prior.impressions < data.min_prior_impressions:
            continue  # not enough former volume to matter
        cmp = _compare(prior, url_cur.get(url, empty))  # a page missing from `current` lost everything
        worst = max(cmp["impressions_drop_pct"], cmp["clicks_drop_pct"])
        if worst <= data.drop_threshold_pct:
            continue
        top_queries = sorted(
            queries_by_url[url], key=lambda q: q["prior_impressions"] - q["current_impressions"], reverse=True
        )[:5]
        decayed.append({"url": url, **cmp, "severity": _severity(worst), "top_queries": top_queries})

    decayed.sort(key=lambda d: d["prior_impressions"] - d["current_impressions"], reverse=True)
    return {
        "status": "success",
        "summary": {
            "urls_analyzed": len(url_prev),
            "decayed_count": len(decayed),
            "impressions_lost": sum(d["prior_impressions"] - d["current_impressions"] for d in decayed),
        },
        "decayed": decayed,
    }


# ---------------------------------------------------------------------------
# GSC CSV upload (multipart) support
# ---------------------------------------------------------------------------
MAX_CSV_BYTES = 20 * 1024 * 1024
CSV_ALIASES = {
    "url": ("page", "pages", "top pages", "url", "landing page", "address"),
    "query": ("query", "queries", "top queries", "search query"),
    "impressions": ("impressions",),
    "clicks": ("clicks",),
    "average_position": ("average_position", "average position", "avg. position", "avg position", "position"),
}
REQUIRED_CSV_COLUMNS = ("url", "impressions", "clicks", "average_position")  # query is optional


def _num(series: pd.Series) -> pd.Series:
    # GSC exports can contain thousands separators ("1,200").
    cleaned = series.astype(str).str.strip().str.replace(",", "", regex=False)
    return pd.to_numeric(cleaned, errors="coerce")


def _parse_gsc_csv(raw: bytes, label: str) -> tuple[list[MetricRow], int]:
    """Parse one GSC export into MetricRows. Returns (rows, skipped_row_count)."""
    if not raw.strip():
        raise HTTPException(status_code=400, detail=f"{label}: the uploaded file is empty")
    try:
        # utf-8-sig strips the BOM; sep=None sniffs comma vs semicolon vs tab.
        df = pd.read_csv(io.BytesIO(raw), encoding="utf-8-sig", dtype=str, sep=None, engine="python")
    except (UnicodeDecodeError, pd.errors.ParserError, pd.errors.EmptyDataError, ValueError) as e:
        raise HTTPException(status_code=400, detail=f"{label}: could not parse CSV ({e})")

    # Normalize headers (case, surrounding/duplicate whitespace) so aliases match cleanly.
    df.columns = [" ".join(str(c).strip().lower().split()) for c in df.columns]
    renames: dict[str, str] = {}
    missing = []
    for target, aliases in CSV_ALIASES.items():
        found = next((a for a in aliases if a in df.columns), None)
        if found is not None:
            renames[found] = target
        elif target in REQUIRED_CSV_COLUMNS:
            missing.append(target)
    if missing:
        raise HTTPException(
            status_code=400,
            detail=(
                f"{label}: missing required column(s): {', '.join(missing)}. "
                f"Found: {', '.join(df.columns)}. Expected Page, Impressions, Clicks and Position "
                "(Query is optional)."
            ),
        )
    df = df.rename(columns=renames)
    if "query" not in df.columns:
        df["query"] = ""
    df = df[list(CSV_ALIASES)]

    total = len(df)
    for col in ("impressions", "clicks", "average_position"):
        df[col] = _num(df[col])
    df["url"] = df["url"].fillna("").astype(str).str.strip()
    df["query"] = df["query"].fillna("").astype(str).str.strip()
    df = df.dropna(subset=["impressions", "clicks", "average_position"])
    df = df[(df["url"] != "") & (df["impressions"] >= 0) & (df["clicks"] >= 0) & (df["average_position"] >= 0)]
    if df.empty:
        raise HTTPException(status_code=422, detail=f"{label}: no valid rows found")
    if len(df) > MAX_ROWS:
        raise HTTPException(status_code=413, detail=f"{label}: too many rows ({len(df)}); the limit is {MAX_ROWS}")

    rows = [
        MetricRow(
            url=r.url,
            query=r.query,
            impressions=int(r.impressions),
            clicks=int(r.clicks),
            average_position=float(r.average_position),
        )
        for r in df.itertuples(index=False)
    ]
    return rows, total - len(df)


async def _read_upload(form, field: str, label: str) -> tuple[list[MetricRow], int, str]:
    f = form.get(field)
    if not isinstance(f, UploadFile):
        raise HTTPException(status_code=422, detail=f"Missing file field '{field}' ({label})")
    raw = await f.read(MAX_CSV_BYTES + 1)
    if len(raw) > MAX_CSV_BYTES:
        raise HTTPException(status_code=413, detail=f"{label}: file is larger than {MAX_CSV_BYTES // (1024 * 1024)} MB")
    rows, skipped = _parse_gsc_csv(raw, label)
    return rows, skipped, f.filename or field


def _form_number(form, key: str, default, cast, lo, hi):
    raw = form.get(key)
    if raw in (None, ""):
        return default
    try:
        value = cast(raw)
    except (TypeError, ValueError):
        raise HTTPException(status_code=422, detail=f"{key} must be a number")
    if not lo <= value <= hi:
        raise HTTPException(status_code=422, detail=f"{key} must be between {lo} and {hi}")
    return value


@router.post("/analyze-decay")
async def analyze_decay(request: Request):
    """Analyze decay from JSON {previous, current} or from multipart CSVs.

    Multipart fields: files `previous_period` and `current_period`, optional
    `min_prior_impressions` and `drop_threshold_pct`.
    """
    content_type = request.headers.get("content-type", "")

    if content_type.startswith("multipart/form-data"):
        form = await request.form()
        previous, prev_skipped, prev_name = await _read_upload(form, "previous_period", "Prior window CSV")
        current, cur_skipped, cur_name = await _read_upload(form, "current_period", "Current window CSV")
        data = DecayRequest(
            previous=previous,
            current=current,
            min_prior_impressions=_form_number(form, "min_prior_impressions", 500, int, 0, 10**9),
            drop_threshold_pct=_form_number(form, "drop_threshold_pct", 20.0, float, 0, 100),
        )
        result = await asyncio.to_thread(_run_decay, data)
        result["source"] = {
            "previous": {"filename": prev_name, "rows": len(previous), "skipped": prev_skipped},
            "current": {"filename": cur_name, "rows": len(current), "skipped": cur_skipped},
        }
        return result

    try:
        data = DecayRequest.model_validate(await request.json())
    except ValidationError as e:
        raise HTTPException(
            status_code=422,
            detail=[{"msg": err["msg"], "loc": list(err["loc"])} for err in e.errors()],
        )
    except ValueError:
        raise HTTPException(status_code=400, detail="Body must be JSON or multipart/form-data with CSV files")
    return _run_decay(data)


# ---------------------------------------------------------------------------
# Refresh brief (LLM)
# ---------------------------------------------------------------------------
class QueryDecay(BaseModel):
    query: str
    prior_impressions: int = Field(ge=0)
    current_impressions: int = Field(ge=0)
    impressions_drop_pct: float
    position_change: float | None = None


class RefreshBriefRequest(BaseModel):
    url: str = Field(min_length=1)
    prior_impressions: int = Field(ge=0)
    current_impressions: int = Field(ge=0)
    impressions_drop_pct: float
    clicks_drop_pct: float
    position_change: float | None = None
    top_queries: list[QueryDecay] = Field(default_factory=list, max_length=10)


REFRESH_SYSTEM_PROMPT = (
    "You are a Principal SEO Architect specialising in content decay recovery for B2B sites. "
    "You have NOT seen the page or the live search results: you only have the Search Console "
    "metrics provided. Therefore present outdated facts, intent shifts and gaps as specific "
    "hypotheses to verify, never as confirmed findings, and never invent statistics, dates, "
    "competitor names or product details. Be concrete and decisive about what to check and change. "
    "Answer in strictly structured Markdown following the user's template, with no preamble."
)


@router.post("/generate-refresh-brief")
async def generate_refresh_brief(data: RefreshBriefRequest):
    if data.top_queries:
        q_lines = "\n".join(
            f"- \"{q.query}\": impressions {q.prior_impressions} -> {q.current_impressions} "
            f"({q.impressions_drop_pct}% drop), position change "
            f"{'n/a' if q.position_change is None else f'{q.position_change:+}'}"
            for q in data.top_queries
        )
    else:
        q_lines = "- (no query-level data provided)"

    drift = "n/a" if data.position_change is None else f"{data.position_change:+} (positive = worse)"
    prompt = f"""
Create a Content Refresh Brief for a page that is losing search visibility.

- URL: {data.url}
- Impressions: {data.prior_impressions} -> {data.current_impressions} ({data.impressions_drop_pct}% drop)
- Click drop: {data.clicks_drop_pct}%
- Average position change: {drift}
- IMPORTANT: position change is current minus prior, so a POSITIVE number means rankings got WORSE (e.g. +3 = fell three places) and a negative number means they improved.
- Queries losing the most impressions:
{q_lines}

Respond in Markdown using EXACTLY these five H2 sections, in this order, with nothing before or after:

## 1. Decay Diagnosis
2-3 sentences: what the numbers suggest (ranking loss vs. demand loss vs. CTR loss) and the most likely cause.

## 2. Outdated Facts & Claims to Verify
Bullet list of the kinds of statements on this page likely to have aged (stats, tool names, pricing, versions, years, regulations), tied to the queries above. Each bullet starts with "Verify:".

## 3. Intent Shifts
For the top declining queries, how searcher intent or the SERP format may have shifted, and what the page must change to match.

## 4. Missing Subtopics & Content Gaps
Bullet list of specific sections, questions, examples or data points to add, each mapped to a declining query.

## 5. Refresh Action Plan
A numbered, prioritised checklist (title/H1 changes, sections to rewrite or add, internal links, schema, date/update signals) ordered by expected impact.
"""
    try:
        response = await asyncio.to_thread(
            lambda: client.chat.completions.create(
                model="openai/gpt-4o-mini",
                messages=[
                    {"role": "system", "content": REFRESH_SYSTEM_PROMPT},
                    {"role": "user", "content": prompt},
                ],
                temperature=0.3,
            )
        )
        return {"status": "success", "brief": response.choices[0].message.content}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

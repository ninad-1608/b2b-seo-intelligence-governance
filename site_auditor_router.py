"""Zero-Client-Data URL Auditor: inspect any live public URL (content, schema, Core Web Vitals)."""
import asyncio
import json
import os
import re

import requests
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator

from geo_router import WORD_RE, FetchError, _fetch, parse_html

router = APIRouter(prefix="/api/v1", tags=["Site Auditor"])

PSI_URL = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed"
PSI_TIMEOUT = 75  # Lighthouse runs can take a while
BODY_TEXT_CHARS = 20_000
MARKDOWN_CHARS = 60_000
RAW_SCHEMA_CHARS = 20_000


class LivePageRequest(BaseModel):
    url: str = Field(max_length=2000)

    @field_validator("url")
    @classmethod
    def _url(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Enter a URL to inspect")
        if re.match(r"^[a-z][a-z0-9+.-]*://", v, re.I):
            if not re.match(r"^https?://", v, re.I):
                raise ValueError("Only http(s) URLs are supported")
        else:
            v = "https://" + v
        return v


# ---------------------------------------------------------------------------
# Page content
# ---------------------------------------------------------------------------
def _markdown(doc) -> str:
    out: list[str] = []
    prev_li = False
    for b in doc.blocks:
        if b.kind == "h":
            line, is_li = f"{'#' * min(b.level, 6)} {b.text}", False
        elif b.kind == "li":
            line, is_li = f"- {b.text}", True
        else:
            line, is_li = b.text, False
        if out:
            out.append("\n" if (is_li and prev_li) else "\n\n")
        out.append(line)
        prev_li = is_li
    return "".join(out)


def _page_issues(page: dict) -> list[dict]:
    issues = []

    def add(sev: str, msg: str) -> None:
        issues.append({"severity": sev, "message": msg})

    t, d = page["title_length"], page["meta_description_length"]
    if t == 0:
        add("high", "Missing <title> tag.")
    elif t > 60:
        add("medium", f"Title is {t} characters; it will likely be truncated in results (aim for 30-60).")
    elif t < 30:
        add("low", f"Title is only {t} characters; consider a more descriptive title (30-60).")
    if d == 0:
        add("medium", "Missing meta description.")
    elif d > 160 or d < 70:
        add("low", f"Meta description is {d} characters (aim for 70-160).")
    if page["h1_count"] == 0:
        add("high", "No H1 found in the main content.")
    elif page["h1_count"] > 1:
        add("medium", f"{page['h1_count']} H1 headings found; use a single H1.")
    if not page["canonical"]:
        add("low", "No canonical URL declared.")
    if page["word_count"] < 300:
        add("medium", f"Only {page['word_count']} words of main content; this may be thin for ranking or AI citation.")
    return issues


# ---------------------------------------------------------------------------
# JSON-LD validation (structural check: not Google's Rich Results Test)
# ---------------------------------------------------------------------------
REQUIRED_PROPS = {
    "FAQPage": ["mainEntity"],
    "Question": ["name", "acceptedAnswer"],
    "Article": ["headline"],
    "BlogPosting": ["headline"],
    "NewsArticle": ["headline"],
    "TechArticle": ["headline"],
    "HowTo": ["name", "step"],
    "Product": ["name"],
    "Organization": ["name"],
    "LocalBusiness": ["name"],
    "Person": ["name"],
    "BreadcrumbList": ["itemListElement"],
    "VideoObject": ["name", "uploadDate", "thumbnailUrl"],
    "Event": ["name", "startDate"],
    "Recipe": ["name"],
}


def _has_schema_context(ctx) -> bool:
    if isinstance(ctx, str):
        return "schema.org" in ctx
    if isinstance(ctx, list):
        return any(_has_schema_context(c) for c in ctx)
    if isinstance(ctx, dict):
        return any("schema.org" in str(v) for v in ctx.values())
    return False


def _validate_block(index: int, raw: str) -> dict:
    block = {"index": index, "status": "valid", "types": [], "errors": [], "warnings": [], "raw": raw, "raw_truncated": False}
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, ValueError) as e:
        block["status"] = "invalid"
        block["errors"].append(f"Invalid JSON: {e}")
    else:
        block["raw"] = json.dumps(data, indent=2, ensure_ascii=False)
        top = data if isinstance(data, list) else [data]
        nodes: list[dict] = []
        for item in top:
            if not isinstance(item, dict):
                block["errors"].append("JSON-LD must be an object or an array of objects.")
                continue
            ctx_ok = _has_schema_context(item.get("@context"))
            if "@graph" in item and isinstance(item["@graph"], list):
                nodes.extend((n, ctx_ok) for n in item["@graph"] if isinstance(n, dict))
            else:
                nodes.append((item, ctx_ok))
        types: set[str] = set()
        for node, ctx_ok in nodes:
            if not ctx_ok:
                block["warnings"].append('Missing or non-schema.org "@context" (expected "https://schema.org").')
            t = node.get("@type")
            tlist = [x for x in (t if isinstance(t, list) else [t]) if isinstance(x, str)]
            if not tlist:
                block["warnings"].append('An entity is missing "@type".')
                continue
            types.update(tlist)
            for tname in tlist:
                missing = [p for p in REQUIRED_PROPS.get(tname, []) if not node.get(p)]
                if missing:
                    block["warnings"].append(f"{tname}: missing recommended/required propert{'y' if len(missing) == 1 else 'ies'}: {', '.join(missing)}.")
        block["types"] = sorted(types)
        block["warnings"] = list(dict.fromkeys(block["warnings"]))
        if block["errors"]:
            block["status"] = "invalid"
        elif block["warnings"]:
            block["status"] = "warnings"
    if len(block["raw"]) > RAW_SCHEMA_CHARS:
        block["raw"], block["raw_truncated"] = block["raw"][:RAW_SCHEMA_CHARS], True
    return block


# ---------------------------------------------------------------------------
# PageSpeed Insights
# ---------------------------------------------------------------------------
def _rating(value: float | None, good: float, poor: float) -> str | None:
    if value is None:
        return None
    return "good" if value <= good else "needs-improvement" if value <= poor else "poor"


def _psi_sync(url: str, strategy: str) -> dict:
    params: list[tuple[str, str]] = [("url", url), ("category", "performance"), ("category", "seo"), ("strategy", strategy)]
    key = os.getenv("PAGESPEED_API_KEY")
    if key:
        params.append(("key", key))
    try:
        resp = requests.get(PSI_URL, params=params, timeout=PSI_TIMEOUT)
    except requests.RequestException:
        # never echo the exception: it contains the request URL, which includes the API key
        return {"error": "The PageSpeed API request failed or timed out."}

    if resp.status_code == 429:
        return {"error": "PageSpeed API quota exceeded. Set PAGESPEED_API_KEY in .env for a higher limit, or retry later."}
    if resp.status_code != 200:
        try:
            msg = resp.json().get("error", {}).get("message", "")
        except ValueError:
            msg = ""
        msg = re.sub(r"key=[\w-]+", "key=…", msg)[:200]
        return {"error": f"PageSpeed could not analyze this URL (HTTP {resp.status_code}). {msg}".strip()}

    data = resp.json()
    lh = data.get("lighthouseResult") or {}
    cats, audits = lh.get("categories", {}), lh.get("audits", {})
    perf = (cats.get("performance") or {}).get("score")
    if perf is None:
        return {"error": (lh.get("runtimeError") or {}).get("message", "Lighthouse could not score this page.")}
    seo = (cats.get("seo") or {}).get("score")

    def audit(name: str) -> dict:
        return audits.get(name) or {}

    lcp, cls = audit("largest-contentful-paint"), audit("cumulative-layout-shift")
    tbt, fcp = audit("total-blocking-time"), audit("first-contentful-paint")
    metrics = {
        "lcp": {"value": lcp.get("numericValue"), "unit": "ms", "display": lcp.get("displayValue"), "rating": _rating(lcp.get("numericValue"), 2500, 4000)},
        "cls": {"value": cls.get("numericValue"), "unit": "", "display": cls.get("displayValue"), "rating": _rating(cls.get("numericValue"), 0.1, 0.25)},
        "tbt": {"value": tbt.get("numericValue"), "unit": "ms", "display": tbt.get("displayValue"), "rating": _rating(tbt.get("numericValue"), 200, 600)},
        "fcp": {"value": fcp.get("numericValue"), "unit": "ms", "display": fcp.get("displayValue"), "rating": _rating(fcp.get("numericValue"), 1800, 3000)},
    }

    field = None
    fm = (data.get("loadingExperience") or {}).get("metrics") or {}
    if fm:
        cls_pct = (fm.get("CUMULATIVE_LAYOUT_SHIFT_SCORE") or {}).get("percentile")
        field = {
            "overall": data["loadingExperience"].get("overall_category"),
            "lcp_ms": (fm.get("LARGEST_CONTENTFUL_PAINT_MS") or {}).get("percentile"),
            "cls": cls_pct / 100 if isinstance(cls_pct, (int, float)) else None,
        }

    return {
        "strategy": strategy,
        "performance_score": round(perf * 100),
        "seo_score": round(seo * 100) if seo is not None else None,
        "metrics": metrics,
        "field_data": field,
    }


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------
@router.post("/audit/live-page")
async def audit_live_page(data: LivePageRequest):
    """Fetch a public URL; return parsed content, JSON-LD schema and PageSpeed Insights metrics."""
    try:
        html, _headers, truncated = await asyncio.to_thread(_fetch, data.url)
    except FetchError as e:
        raise HTTPException(status_code=400, detail=str(e))

    doc = parse_html(html, data.url)
    text = doc.text
    headings = [{"level": b.level, "text": b.text} for b in doc.blocks if b.kind == "h" and b.level <= 3]
    page = {
        "title": doc.title,
        "title_length": len(doc.title),
        "meta_description": doc.meta_description,
        "meta_description_length": len(doc.meta_description),
        "canonical": doc.canonical,
        "lang": doc.lang,
        "robots_meta": doc.meta_robots.strip(),
        "word_count": len(WORD_RE.findall(text)),
        "h1_count": sum(1 for h in headings if h["level"] == 1),
        "headings": headings[:150],
        "body_text": text[:BODY_TEXT_CHARS],
        "body_truncated": len(text) > BODY_TEXT_CHARS,
        "content_markdown": _markdown(doc)[:MARKDOWN_CHARS],
        "html_truncated": truncated,
    }
    page["issues"] = _page_issues(page)

    blocks = [_validate_block(i, raw) for i, raw in enumerate(doc.jsonld_raw, start=1) if raw]
    schema = {
        "count": len(blocks),
        "valid": sum(b["status"] == "valid" for b in blocks),
        "with_warnings": sum(b["status"] == "warnings" for b in blocks),
        "invalid": sum(b["status"] == "invalid" for b in blocks),
        "types": sorted({t for b in blocks for t in b["types"]}),
        "has_microdata": doc.has_microdata,
        "blocks": blocks,
    }

    mobile, desktop = await asyncio.gather(
        asyncio.to_thread(_psi_sync, data.url, "mobile"),
        asyncio.to_thread(_psi_sync, data.url, "desktop"),
    )
    return {
        "status": "success",
        "url": data.url,
        "page": page,
        "schema": schema,
        "pagespeed": {"mobile": mobile, "desktop": desktop, "api_key_configured": bool(os.getenv("PAGESPEED_API_KEY"))},
    }

"""Automated Internal Link Opportunity Finder.

Scores source -> target link opportunities across a page inventory using TF-IDF topical similarity
(titles, target keywords and body text, plus two-word phrases), then boosts targets that are orphaned or
under-linked. Pure Python: no extra dependencies.
"""
import io
import math
import re
from collections import Counter, defaultdict
from urllib.parse import urlparse

import pandas as pd
from fastapi import APIRouter, File, HTTPException, Query, UploadFile

from internal_links_data import SANDBOX_PAGES

router = APIRouter(prefix="/api/v1", tags=["Internal Links"])

MAX_PAGES = 1000
MAX_CSV_BYTES = 5 * 1024 * 1024
MAX_CONTENT_CHARS = 20_000
MIN_SHARED_TERMS = 2
MAX_PER_TARGET = 3
MAX_PER_SOURCE = 4
REL_SATURATION = 0.35  # cosine at which topical relevance counts as 100%

STOPWORDS = set(
    "a about above after again all also am an and any are as at be because been before being below between both but by can "
    "could did do does doing down during each few for from further had has have having he her here hers him his how i if in into "
    "is it its just me more most my no nor not now of off on once only or other our ours out over own same she should so some "
    "such than that the their theirs them then there these they this those through to too under until up us very was we were "
    "what when where which while who whom why will with would you your yours get gets make makes made one two use used using "
    "every best new per".split()
)
TOKEN_RE = re.compile(r"[a-z][a-z0-9'-]*|\d+")


# ---------------------------------------------------------------------------
# Text helpers
# ---------------------------------------------------------------------------
def _stem(w: str) -> str:
    w = w.strip("'-")
    if len(w) > 4 and w.endswith("ies"):
        return w[:-3] + "y"
    if len(w) > 4 and w.endswith("sses"):
        return w[:-2]
    if len(w) > 3 and w.endswith("s") and not w.endswith(("ss", "us", "is")):
        return w[:-1]
    return w


def _terms(text: str) -> list[str]:
    """Stemmed unigrams plus bigrams of adjacent non-stopwords."""
    out: list[str] = []
    run: list[str] = []
    for raw in TOKEN_RE.findall(text.lower()):
        if raw in STOPWORDS or len(raw) < 2:
            run = []
            continue
        t = _stem(raw)
        out.append(t)
        if run:
            out.append(f"{run[-1]} {t}")
        run = [t]
    return out


def _key(url: str) -> str:
    """Comparable page key: lowercase path without query, fragment or trailing slash."""
    path = urlparse(url.strip()).path or "/"
    return (path.rstrip("/") or "/").lower()


def _split_phrases(s: str) -> list[str]:
    return [p.strip() for p in re.split(r"[,;|\n]", s or "") if p.strip()]


def _phrase_regex(phrase: str) -> re.Pattern:
    words = phrase.split()
    parts = [re.escape(w) + ("" if w.lower().endswith("s") else r"(?:e?s)?") for w in words]
    return re.compile(r"(?<![\w])" + r"\s+".join(parts) + r"(?![\w])", re.I)


def _short_title(title: str) -> str:
    t = re.split(r"\s[|\-–—:]\s|:\s", title)[0].strip()
    return " ".join(t.split()[:6])


def _sentence_around(text: str, start: int, end: int, limit: int = 220) -> str:
    left = max(text.rfind(". ", 0, start), text.rfind("\n", 0, start))
    left = 0 if left == -1 else left + 2
    right_candidates = [i for i in (text.find(". ", end), text.find("\n", end)) if i != -1]
    right = min(right_candidates) + 1 if right_candidates else len(text)
    sentence = " ".join(text[left:right].split())
    if len(sentence) > limit:
        mid = start - left
        lo = max(0, mid - limit // 2)
        sentence = ("…" if lo else "") + sentence[lo : lo + limit] + "…"
    return sentence


# ---------------------------------------------------------------------------
# Core analysis
# ---------------------------------------------------------------------------
def analyze_pages(pages: list[dict], limit: int, min_relevance: float, source: str, filename: str | None = None) -> dict:
    n = len(pages)
    if n < 2:
        raise HTTPException(status_code=422, detail="Need at least two pages to find internal link opportunities.")

    keys = [_key(p["url"]) for p in pages]
    index = {k: i for i, k in enumerate(keys)}

    # existing internal links -> inbound counts
    out_sets: list[set[str]] = [{_key(u) for u in p.get("outlinks", []) if u.strip()} for p in pages]
    link_data = any(out_sets)
    inbound = [0] * n
    for i, outs in enumerate(out_sets):
        for k in outs:
            j = index.get(k)
            if j is not None and j != i:
                inbound[j] += 1
    max_inbound = max(inbound) or 1

    # TF-IDF vectors (title and target keywords weigh 3x)
    counts: list[Counter] = []
    for p in pages:
        c: Counter = Counter()
        for field, weight in ((p.get("title", ""), 3), (p.get("keywords", ""), 3), (p.get("content", "")[:MAX_CONTENT_CHARS], 1)):
            for t in _terms(field):
                c[t] += weight
        counts.append(c)
    df: Counter = Counter()
    for c in counts:
        df.update(c.keys())
    vecs: list[dict[str, float]] = []
    for c in counts:
        v = {t: (1 + math.log(f)) * (math.log((n + 1) / (df[t] + 1)) + 1) for t, f in c.items()}
        norm = math.sqrt(sum(x * x for x in v.values())) or 1.0
        vecs.append({t: x / norm for t, x in v.items()})

    max_df = max(2, int(n * 0.6))
    postings: dict[str, list[tuple[int, float]]] = defaultdict(list)
    for j, v in enumerate(vecs):
        for t, w in v.items():
            if df[t] <= max_df:  # very common terms carry no topical signal
                postings[t].append((j, w))

    def status(j: int) -> str:
        if not link_data:
            return "unknown"
        return "orphan" if inbound[j] == 0 else "under-linked" if inbound[j] == 1 else "ok"

    candidates = []
    for i in range(n):
        scores: dict[int, float] = defaultdict(float)
        shared: dict[int, list[tuple[float, str]]] = defaultdict(list)
        for t, w in vecs[i].items():
            if df[t] > max_df:
                continue
            for j, wj in postings[t]:
                if j != i:
                    scores[j] += w * wj
                    shared[j].append((w * wj, t))
        for j, cos in scores.items():
            if keys[j] in out_sets[i] or len(shared[j]) < MIN_SHARED_TERMS:
                continue
            rel = min(1.0, cos / REL_SATURATION)
            if rel * 100 < min_relevance:
                continue

            # anchor: the longest phrase describing the target that already appears in the source copy
            tgt = pages[j]
            kw = _split_phrases(tgt.get("keywords", ""))
            title_words = [w for w in re.findall(r"[A-Za-z0-9'-]+", _short_title(tgt.get("title", ""))) if w]
            ngrams = [" ".join(title_words[a : a + L]) for L in (4, 3, 2) for a in range(0, max(0, len(title_words) - L + 1))]
            phrases = list(dict.fromkeys(kw + ngrams))
            src_text = pages[i].get("content", "")[:MAX_CONTENT_CHARS]
            best = None
            for ph in phrases:
                words = ph.split()
                if len(words) < 2 and ph not in kw:
                    continue
                if all(w.lower() in STOPWORDS for w in words):
                    continue
                m = _phrase_regex(ph).search(src_text)
                if m and (best is None or len(words) > best[0]):
                    best = (len(words), m)
            if best:
                m = best[1]
                anchor, in_source = m.group(0), True
                context = _sentence_around(src_text, m.start(), m.end())
            else:
                anchor = kw[0] if kw else _short_title(tgt.get("title", "")) or keys[j]
                in_source, context = False, ""

            # priority: topical fit + how much the target needs links + source strength + ready-made anchor
            need = 0.5 if not link_data else {0: 1.0, 1: 0.7, 2: 0.35}.get(inbound[j], 0.1)
            authority = 0.5 if not link_data else min(1.0, inbound[i] / max_inbound)
            priority = 100 * (0.50 * rel + 0.28 * need + 0.12 * authority + 0.10 * (1.0 if in_source else 0.0))

            top = sorted(shared[j], reverse=True)
            topics: list[str] = []
            for _, t in top:
                if any(t in chosen.split() for chosen in topics if " " in chosen):
                    continue  # unigram already covered by a chosen phrase
                topics.append(t)
                if len(topics) == 4:
                    break

            reasons = [f"Shares topics: {', '.join(topics)}"]
            st = status(j)
            if st == "orphan":
                reasons.append("target is an orphan page (0 internal links point to it)")
            elif st == "under-linked":
                reasons.append("target has only 1 internal link pointing to it")
            reasons.append("anchor phrase already appears in the source copy" if in_source else "no natural anchor in the source copy yet; add a sentence")

            candidates.append({
                "source_url": pages[i]["url"],
                "source_title": pages[i].get("title") or pages[i]["url"],
                "target_url": tgt["url"],
                "target_title": tgt.get("title") or tgt["url"],
                "anchor_text": anchor,
                "anchor_in_source": in_source,
                "context_snippet": context,
                "relevance_score": round(rel * 100),
                "priority_score": round(priority),
                "target_inbound_links": inbound[j] if link_data else None,
                "target_status": st,
                "shared_topics": topics,
                "reason": "; ".join(reasons) + ".",
            })

    candidates.sort(key=lambda c: (-c["priority_score"], -c["relevance_score"], c["source_url"], c["target_url"]))
    picked, per_target, per_source = [], Counter(), Counter()
    for c in candidates:
        if per_target[c["target_url"]] >= MAX_PER_TARGET or per_source[c["source_url"]] >= MAX_PER_SOURCE:
            continue
        per_target[c["target_url"]] += 1
        per_source[c["source_url"]] += 1
        picked.append(c)
        if len(picked) >= limit:
            break

    def brief(j: int) -> dict:
        return {"url": pages[j]["url"], "title": pages[j].get("title") or pages[j]["url"], "inbound_links": inbound[j]}

    return {
        "status": "success",
        "source": source,
        "filename": filename,
        "summary": {
            "pages_analyzed": n,
            "opportunities": len(picked),
            "link_data_available": link_data,
            "orphan_pages": [brief(j) for j in range(n) if status(j) == "orphan"],
            "under_linked_pages": [brief(j) for j in range(n) if status(j) == "under-linked"],
        },
        "opportunities": picked,
    }


# ---------------------------------------------------------------------------
# CSV inventory parsing
# ---------------------------------------------------------------------------
CSV_ALIASES = {
    "url": ("url", "page", "address", "landing page", "page url"),
    "title": ("title", "page title", "h1", "name"),
    "content": ("content", "body", "text", "main content", "page content", "excerpt", "description", "meta description"),
    "keywords": ("keywords", "target keyword", "target keywords", "primary keyword", "top query", "queries"),
    "outlinks": ("outlinks", "internal links", "links out", "linked urls", "outgoing links"),
}


def parse_inventory_csv(raw: bytes) -> list[dict]:
    if not raw.strip():
        raise HTTPException(status_code=400, detail="The uploaded file is empty")
    try:
        df = pd.read_csv(io.BytesIO(raw), encoding="utf-8-sig", dtype=str, sep=None, engine="python")
    except (UnicodeDecodeError, pd.errors.ParserError, pd.errors.EmptyDataError, ValueError) as e:
        raise HTTPException(status_code=400, detail=f"Could not parse CSV ({e})")
    df.columns = [" ".join(str(c).strip().lower().split()) for c in df.columns]

    renames: dict[str, str] = {}
    for target, aliases in CSV_ALIASES.items():
        found = next((a for a in aliases if a in df.columns), None)
        if found:
            renames[found] = target
    if "url" not in renames.values():
        raise HTTPException(status_code=400, detail=f"Missing required column: url (or page / address). Found: {', '.join(df.columns)}")
    if not ({"title", "content", "keywords"} & set(renames.values())):
        raise HTTPException(status_code=400, detail="Need at least one of: title, content, keywords columns to compare topics.")
    df = df.rename(columns=renames)
    for col in ("title", "content", "keywords", "outlinks"):
        if col not in df.columns:
            df[col] = ""
        df[col] = df[col].fillna("").astype(str)

    pages, seen = [], set()
    for r in df.itertuples(index=False):
        url = str(r.url).strip() if isinstance(r.url, str) else ""
        k = _key(url) if url else ""
        if not url or k in seen:
            continue
        seen.add(k)
        pages.append({
            "url": url,
            "title": r.title.strip(),
            "keywords": r.keywords.strip(),
            "content": r.content.strip(),
            "outlinks": [u for u in re.split(r"[|;\s]+", r.outlinks) if u],
        })
    if len(pages) > MAX_PAGES:
        raise HTTPException(status_code=413, detail=f"Too many pages ({len(pages)}); the limit is {MAX_PAGES}")
    return pages


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@router.get("/internal-link-opportunities")
async def internal_link_opportunities(
    limit: int = Query(50, ge=1, le=200),
    min_relevance: float = Query(20, ge=0, le=100),
):
    """Link recommendations for the built-in sandbox site."""
    return analyze_pages(SANDBOX_PAGES, limit, min_relevance, source="sandbox")


@router.post("/internal-link-opportunities")
async def internal_link_opportunities_upload(
    inventory: UploadFile = File(...),
    limit: int = Query(50, ge=1, le=200),
    min_relevance: float = Query(20, ge=0, le=100),
):
    """Link recommendations for an uploaded page inventory CSV.

    Columns: url (required); title, content, keywords (at least one); outlinks (optional, existing
    internal links separated by | or ;) so already-linked pairs are skipped and orphans can be found.
    """
    raw = await inventory.read(MAX_CSV_BYTES + 1)
    if len(raw) > MAX_CSV_BYTES:
        raise HTTPException(status_code=413, detail=f"File is larger than {MAX_CSV_BYTES // (1024 * 1024)} MB")
    pages = parse_inventory_csv(raw)
    return analyze_pages(pages, limit, min_relevance, source="upload", filename=inventory.filename or "inventory.csv")

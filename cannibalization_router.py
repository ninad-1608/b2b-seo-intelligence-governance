"""Cannibalization Quick Fix: pick the winning URL and generate redirect / canonical snippets."""
import asyncio
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator

from ai_router import FixCodeRequest, _check_url, _path_of, client, generate_fix_code

router = APIRouter(prefix="/api/v1", tags=["Cannibalization Fix"])

# Winner scoring weights. Content depth is only used when every URL supplies a word_count.
W_IMPRESSIONS, W_POSITION, W_DEPTH = 0.50, 0.35, 0.15


class CompetingUrl(BaseModel):
    url: str
    impressions: int = Field(ge=0)
    position: float = Field(gt=0)
    word_count: int | None = Field(default=None, ge=0)  # optional content-depth signal

    @field_validator("url")
    @classmethod
    def _safe(cls, v: str) -> str:
        return _check_url(v)


class CannibalizationFixRequest(BaseModel):
    query: str = Field(min_length=1, max_length=300)
    competing_urls: list[CompetingUrl] = Field(min_length=2, max_length=20)


def _rank(urls: list[CompetingUrl]) -> list[dict]:
    """Score every URL; best first. Deterministic, so the same data always picks the same winner."""
    max_imp = max(u.impressions for u in urls) or 1
    best_pos = min(u.position for u in urls)
    use_depth = all(u.word_count is not None for u in urls) and max(u.word_count or 0 for u in urls) > 0
    max_wc = max((u.word_count or 0) for u in urls) or 1
    total_w = W_IMPRESSIONS + W_POSITION + (W_DEPTH if use_depth else 0)

    scored = []
    for u in urls:
        imp = u.impressions / max_imp
        pos = best_pos / u.position
        depth = (u.word_count or 0) / max_wc if use_depth else 0.0
        score = (W_IMPRESSIONS * imp + W_POSITION * pos + (W_DEPTH * depth if use_depth else 0)) / total_w * 100
        scored.append({
            "url": u.url,
            "impressions": u.impressions,
            "position": u.position,
            "word_count": u.word_count,
            "score": round(score, 1),
        })
    # ties: better position, then more impressions, then the shorter (more canonical-looking) path
    scored.sort(key=lambda s: (-s["score"], s["position"], -s["impressions"], len(_path_of(s["url"]))))
    return scored


def _fallback_rationale(query: str, winner: dict, losers: list[dict]) -> str:
    parts = [
        f"{winner['url']} is the strongest page for \"{query}\": {winner['impressions']:,} impressions at an average position of {winner['position']:.1f}."
    ]
    for lo in losers:
        parts.append(f"{lo['url']} trails with {lo['impressions']:,} impressions at position {lo['position']:.1f}.")
    parts.append("Consolidating the weaker page(s) into the winner concentrates links and relevance signals on one URL.")
    return " ".join(parts)


RATIONALE_SYSTEM = (
    "You are a Principal SEO Architect. The winning URL has ALREADY been chosen by a scoring rule; do not "
    "change or question it. Write a concise rationale (3-5 sentences, plain text, no Markdown) explaining why "
    "consolidating into the winner resolves the cannibalization, and when keeping both URLs live with a "
    "canonical tag would be the better alternative. Use only the numbers provided. Never invent traffic, "
    "backlink, conversion or content facts, and do not claim to have seen the pages."
)


def _rationale_sync(query: str, ranked: list[dict]) -> str:
    lines = "\n".join(
        f"- {r['url']}: impressions={r['impressions']}, avg position={r['position']}, score={r['score']}"
        + (f", words={r['word_count']}" if r["word_count"] is not None else "")
        for r in ranked
    )
    prompt = (
        f"Query: {query}\n"
        f"Winning URL (decided): {ranked[0]['url']}\n"
        f"Ranked candidates (best first):\n{lines}\n"
        "Scoring basis: 50% impressions, 35% ranking position"
        + (", 15% content length." if all(r["word_count"] is not None for r in ranked) else "; content depth was not measured.")
    )
    resp = client.chat.completions.create(
        model="openai/gpt-4o-mini",
        messages=[{"role": "system", "content": RATIONALE_SYSTEM}, {"role": "user", "content": prompt}],
        temperature=0.3,
    )
    return (resp.choices[0].message.content or "").strip()


def _cloudflare(winner: str, losers: list[str]) -> str:
    host = next((urlparse(u).netloc for u in [winner, *losers] if urlparse(u).netloc), "")
    shown_host = host or "YOUR-DOMAIN.com"
    dest_base = f"https://{shown_host}"
    lines = ["# Cloudflare: Rules > Page Rules > Create Page Rule (Forwarding URL, 301 Permanent Redirect)"]
    if not host:
        lines.append("# Replace YOUR-DOMAIN.com with your site's domain.")
    for u in losers:
        lines += [
            "",
            f"# {_path_of(u)} -> {_path_of(winner)}",
            f"If the URL matches:  {shown_host}{_path_of(u)}",
            f"Forwarding URL:      301 - {dest_base}{_path_of(winner)}",
        ]
    lines += [
        "",
        "# Page Rules match the exact URL; append * to the pattern to also match query strings.",
        "# Newer accounts can use Rules > Redirect Rules > Single Redirect instead:",
        f'#   When: (http.request.uri.path eq "{_path_of(losers[0])}")  Then: Static, 301, {dest_base}{_path_of(winner)}',
    ]
    return "\n".join(lines) + "\n"


@router.post("/generate-cannibalization-fix")
async def generate_cannibalization_fix(data: CannibalizationFixRequest):
    # Collapse duplicate URL paths, keeping the row with the most impressions.
    by_path: dict[str, CompetingUrl] = {}
    for u in data.competing_urls:
        key = _path_of(u.url)
        if key not in by_path or u.impressions > by_path[key].impressions:
            by_path[key] = u
    urls = list(by_path.values())
    if len(urls) < 2:
        raise HTTPException(status_code=422, detail="Need at least two distinct competing URLs.")

    ranked = _rank(urls)
    winner, losers = ranked[0], ranked[1:]
    loser_urls = [r["url"] for r in losers]

    # Reuse the shared redirect / canonical generators (Next.js, Nginx, canonical tag).
    fix = await generate_fix_code(
        FixCodeRequest(winning_url=winner["url"], canonical_url=winner["url"], losing_urls=loser_urls)
    )
    base = fix["snippets"]

    canonical = base["html_meta"]
    if not any(urlparse(u["url"]).netloc for u in ranked):
        canonical += "<!-- Canonical URLs should be absolute: prefix the href with your https://your-domain.com origin. -->\n"

    try:
        rationale = await asyncio.to_thread(_rationale_sync, data.query, ranked)
        source = "ai"
        if not rationale:
            raise ValueError("empty rationale")
    except Exception:  # the redirect code is deterministic; never fail it because the LLM did
        rationale = _fallback_rationale(data.query, winner, losers)
        source = "rules"

    return {
        "status": "success",
        "query": data.query,
        "winning_url": winner["url"],
        "losing_urls": loser_urls,
        "ranking": ranked,
        "rationale": rationale,
        "rationale_source": source,
        "snippets": {
            "nextjs": base["nextjs"],
            "nginx": base["nginx"],
            "cloudflare": _cloudflare(winner["url"], loser_urls),
            "canonical": canonical,
        },
        "canonical_note": (
            "Use the canonical tag instead of the redirects only if you keep both URLs live "
            "and differentiate their intent (e.g. one commercial page, one educational guide)."
        ),
    }

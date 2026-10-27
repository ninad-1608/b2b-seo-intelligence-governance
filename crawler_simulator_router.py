"""Autonomous LLM Search Crawler Simulator.

Fetches a public URL the way several AI search crawlers would (their user-agent strings, no IP spoofing), evaluates
robots.txt per RFC 9309 (longest match, `*` and `$` wildcards), checks meta / X-Robots-Tag directives, estimates whether
the content survives without JavaScript (static heuristic: no JS is executed) and scores how well the page would be
split into retrieval chunks.
"""
import asyncio
import re
import statistics
from urllib.parse import urlparse

import requests
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator

from geo_router import MAX_PAGE_BYTES, MAX_REDIRECTS, WORD_RE, Doc, FetchError, _assert_public_url, parse_html

router = APIRouter(prefix="/api/v1", tags=["Crawler Simulator"])

FETCH_TIMEOUT = 10
ROBOTS_MAX_BYTES = 500 * 1024
BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

# role: "search" / "control" / "crawler" tokens decide the card's verdict; "training" tokens are shown but only warn,
# because blocking a training crawler while allowing the search crawler is a common, deliberate policy.
BOTS = [
    {
        "id": "chatgpt", "name": "ChatGPT Search", "vendor": "OpenAI", "fetch_as": "OAI-SearchBot",
        "ua": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot",
        "tokens": [
            ("OAI-SearchBot", "search", "Indexes pages for ChatGPT Search results"),
            ("GPTBot", "training", "OpenAI's model-training crawler"),
        ],
    },
    {
        "id": "perplexity", "name": "Perplexity", "vendor": "Perplexity AI", "fetch_as": "PerplexityBot",
        "ua": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
        "tokens": [("PerplexityBot", "search", "Builds Perplexity's search index")],
    },
    {
        "id": "claude", "name": "Claude", "vendor": "Anthropic", "fetch_as": "ClaudeBot",
        "ua": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
        "tokens": [
            ("Claude-SearchBot", "search", "Anthropic's search-quality crawler"),
            ("ClaudeBot", "training", "Anthropic's general web crawler"),
            ("anthropic-ai", "training", "Legacy Anthropic token"),
        ],
    },
    {
        "id": "gemini", "name": "Gemini / Other LLMs", "vendor": "Google, ByteDance", "fetch_as": "Bytespider",
        "ua": "Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)",
        "tokens": [
            ("Google-Extended", "control", "robots.txt-only control token for Gemini (it is not a separate crawler)"),
            ("Bytespider", "crawler", "ByteDance's crawler, used for its LLMs"),
        ],
    },
]
GATING_ROLES = {"search", "control", "crawler"}


class CrawlerRequest(BaseModel):
    url: str = Field(max_length=2000)

    @field_validator("url")
    @classmethod
    def _url(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Enter a URL")
        if re.match(r"^[a-z][a-z0-9+.-]*://", v, re.I):
            if not re.match(r"^https?://", v, re.I):
                raise ValueError("Only http(s) URLs are supported")
            return v
        return "https://" + v


# ---------------------------------------------------------------------------
# Fetching (SSRF-guarded, custom user agent, never raises on HTTP errors)
# ---------------------------------------------------------------------------
def fetch_as(url: str, user_agent: str, max_bytes: int = MAX_PAGE_BYTES) -> dict:
    out = {"status": None, "headers": {}, "text": "", "truncated": False, "error": None, "content_type": ""}
    headers = {"User-Agent": user_agent, "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5"}
    try:
        for _ in range(MAX_REDIRECTS + 1):
            _assert_public_url(url)
            resp = requests.get(url, headers=headers, timeout=FETCH_TIMEOUT, allow_redirects=False, stream=True)
            try:
                if resp.is_redirect and resp.headers.get("location"):
                    url = requests.compat.urljoin(url, resp.headers["location"])
                    continue
                body = b""
                for chunk in resp.iter_content(chunk_size=65536):
                    body += chunk
                    if len(body) > max_bytes:
                        body, out["truncated"] = body[:max_bytes], True
                        break
                out.update(
                    status=resp.status_code,
                    headers=dict(resp.headers),
                    content_type=resp.headers.get("content-type", "").lower(),
                    text=body.decode(resp.encoding or "utf-8", errors="replace"),
                )
                return out
            finally:
                resp.close()
        out["error"] = "Too many redirects."
    except FetchError as e:
        out["error"] = str(e)
    except requests.RequestException as e:
        out["error"] = f"Request failed ({type(e).__name__})."
    return out


# ---------------------------------------------------------------------------
# robots.txt (RFC 9309)
# ---------------------------------------------------------------------------
def parse_robots(text: str) -> list[dict]:
    groups: list[dict] = []
    cur: dict | None = None
    for lineno, raw in enumerate(text.splitlines(), start=1):
        line = raw.split("#", 1)[0].strip()
        if ":" not in line:
            continue
        field, value = (p.strip() for p in line.split(":", 1))
        field = field.lower()
        if field == "user-agent":
            if cur is None or cur["rules"]:
                cur = {"agents": [], "rules": []}
                groups.append(cur)
            cur["agents"].append(value.lower())
        elif field in ("allow", "disallow") and cur is not None and value:  # an empty Disallow allows everything
            cur["rules"].append({"allow": field == "allow", "pattern": value, "line": lineno, "text": f"{field.capitalize()}: {value}"})
    return groups


def _pattern_matches(pattern: str, target: str) -> bool:
    rx = re.escape(pattern).replace(r"\*", ".*")
    if rx.endswith(r"\$"):
        rx = rx[:-2] + "$"
    return re.match(rx, target) is not None


def evaluate_robots(groups: list[dict], token: str, target: str) -> dict:
    """Is `target` (path + query) allowed for the product token? Most specific group wins, then longest rule; Allow wins ties."""
    t = token.lower()
    matched = [g for g in groups if t in g["agents"]]
    group_name = token
    if not matched:
        matched = [g for g in groups if "*" in g["agents"]]
        group_name = "*"
    if not matched:
        return {"allowed": True, "rule": None, "line": None, "group": None}
    best = None
    for g in matched:
        for r in g["rules"]:
            if _pattern_matches(r["pattern"], target):
                key = (len(r["pattern"]), r["allow"])
                if best is None or key > best[0]:
                    best = (key, r)
    if best is None:
        return {"allowed": True, "rule": None, "line": None, "group": group_name}
    r = best[1]
    return {"allowed": r["allow"], "rule": r["text"], "line": r["line"], "group": group_name}


# ---------------------------------------------------------------------------
# Meta robots / X-Robots-Tag
# ---------------------------------------------------------------------------
_VALUED = re.compile(r"^(max-snippet|max-image-preview|max-video-preview|unavailable_after)\s*:", re.I)
_AGENT = re.compile(r"^([a-z0-9._-]+)\s*:\s*(.+)$", re.I)
FAIL_DIRECTIVES = {"noindex": "excludes the page from search indexes, so it cannot be cited", "none": "means noindex + nofollow"}
WARN_DIRECTIVES = {
    "nosnippet": "blocks text excerpts, which limits quoting in AI answers",
    "max-snippet:0": "blocks text excerpts, which limits quoting in AI answers",
    "noai": "non-standard; honoured by only a few crawlers",
    "noimageai": "non-standard; honoured by only a few crawlers",
}


def parse_x_robots(value: str) -> list[tuple[str | None, str]]:
    """X-Robots-Tag, possibly several headers merged with commas: [(agent|None, directive), ...]."""
    out: list[tuple[str | None, str]] = []
    agent: str | None = None
    for part in (p.strip() for p in value.split(",")):
        if not part:
            continue
        if _VALUED.match(part):
            out.append((agent, re.sub(r"\s+", "", part.lower())))
            continue
        m = _AGENT.match(part)
        if m:
            agent = m.group(1).lower()
            out.append((agent, m.group(2).strip().lower()))
        else:
            out.append((agent, part.lower()))
    return out


def find_directives(doc: Doc, headers: dict, tokens: list[str]) -> list[dict]:
    names = {"robots"} | {t.lower() for t in tokens}
    raw: list[tuple[str, str]] = []
    for name, content in doc.bot_metas:
        if name in names:
            for d in content.split(","):
                if d.strip():
                    raw.append((f'<meta name="{name}">', re.sub(r"\s+", "", d.strip().lower())))
    xrt = next((v for k, v in headers.items() if k.lower() == "x-robots-tag"), "")
    for agent, d in parse_x_robots(xrt) if xrt else []:
        if agent is None or agent in names:
            raw.append(("X-Robots-Tag header" + (f" ({agent})" if agent else ""), d))
    findings = []
    for source, d in raw:
        if d in FAIL_DIRECTIVES:
            findings.append({"source": source, "directive": d, "severity": "fail", "effect": FAIL_DIRECTIVES[d]})
        elif d in WARN_DIRECTIVES:
            findings.append({"source": source, "directive": d, "severity": "warn", "effect": WARN_DIRECTIVES[d]})
    return findings


# ---------------------------------------------------------------------------
# JS hydration heuristic
# ---------------------------------------------------------------------------
_SCRIPT_RE = re.compile(r"<script\b([^>]*)>(.*?)</script>", re.I | re.S)
_ROOT_RE = re.compile(r"<div[^>]+id=[\"'](root|app|__next|__nuxt|app-root|svelte)[\"'][^>]*>\s*</div>", re.I)
_NOSCRIPT_RE = re.compile(r"<noscript[^>]*>(.*?)</noscript>", re.I | re.S)
_NEEDS_JS = re.compile(r"enable javascript|requires javascript|javascript is (?:required|disabled)|without javascript", re.I)


def analyze_hydration(html: str, doc: Doc) -> dict:
    words = len(WORD_RE.findall(doc.text))
    html_bytes = len(html.encode("utf-8", errors="ignore")) or 1
    text_bytes = len(doc.text.encode("utf-8", errors="ignore"))
    scripts = _SCRIPT_RE.findall(html)
    external = sum(1 for attrs, _ in scripts if "src=" in attrs.lower())
    inline_bytes = sum(len(body.encode("utf-8", errors="ignore")) for attrs, body in scripts if "src=" not in attrs.lower())
    empty_root = bool(_ROOT_RE.search(html))
    noscript_needs_js = any(_NEEDS_JS.search(b) for b in _NOSCRIPT_RE.findall(html))
    ratio = text_bytes / html_bytes
    script_heavy = inline_bytes > 5 * max(text_bytes, 1) or external >= 8

    if words < 100 and (empty_root or noscript_needs_js or script_heavy):
        status, detail = "fail", f"Only {words} words in the raw HTML and the page looks JavaScript-rendered; crawlers that do not run JS see almost nothing."
    elif words < 200 and (empty_root or script_heavy):
        status, detail = "warn", f"Only {words} words in the raw HTML and the page is script-heavy; some content may load via JavaScript."
    else:
        status, detail = "pass", f"{words} words are present in the raw HTML ({ratio:.0%} of the markup is visible text)."
    return {
        "status": status, "detail": detail, "words": words, "html_bytes": html_bytes, "text_ratio": round(ratio, 3),
        "inline_script_bytes": inline_bytes, "external_scripts": external, "empty_app_root": empty_root, "noscript_requires_js": noscript_needs_js,
    }


# ---------------------------------------------------------------------------
# RAG chunkability
# ---------------------------------------------------------------------------
BAND_MIN, BAND_MAX, OVERSIZE, FRAGMENT = 40, 200, 250, 15  # words per paragraph-sized chunk
SECTION_MIN, SECTION_MAX = 50, 400  # words of body copy under one H2/H3
TOKENS_PER_WORD = 1.3


def chunkability(doc: Doc) -> dict:
    blocks = doc.blocks
    words_total = len(WORD_RE.findall(doc.text))
    if words_total < 50:
        return {"score": 0, "rating": "Poor", "components": [], "metrics": {}, "suggestions": ["Not enough text in the HTML to chunk (under 50 words)."]}

    heads = [b for b in blocks if b.kind == "h"]
    h1 = sum(1 for h in heads if h.level == 1)
    h2 = sum(1 for h in heads if h.level == 2)
    h23 = sum(1 for h in heads if h.level in (2, 3))
    skips, prev = 0, None
    for h in heads:
        if prev is not None and h.level > prev + 1:
            skips += 1
        prev = h.level
    wph = words_total / h23 if h23 else None

    paras = [len(WORD_RE.findall(b.text)) for b in blocks if b.kind == "p" and len(WORD_RE.findall(b.text)) >= 3]
    in_band = sum(1 for w in paras if BAND_MIN <= w <= BAND_MAX)
    oversize = sum(1 for w in paras if w > OVERSIZE)
    fragments = sum(1 for w in paras if w < FRAGMENT)
    list_items = sum(1 for b in blocks if b.kind == "li")

    sections, cur = [], {"title": "(intro)", "words": 0}
    for b in blocks:
        if b.kind == "h" and b.level in (2, 3):
            sections.append(cur)
            cur = {"title": b.text, "words": 0}
        elif b.kind != "h":
            cur["words"] += len(WORD_RE.findall(b.text))
    sections.append(cur)
    sections = [s for s in sections if not (s["title"] == "(intro)" and s["words"] < SECTION_MIN)]
    sec_ok = sum(1 for s in sections if SECTION_MIN <= s["words"] <= SECTION_MAX)

    # --- scoring (100): headings 30, paragraph chunks 35, lists/tables 15, section sizing 20
    s_h1 = 5 if h1 == 1 else 3 if h1 > 1 else 0
    s_h2 = min(1, h2 / 4) * 10
    s_hier = 5 * (1 - min(1, skips / max(1, len(heads)))) if heads else 0
    s_dens = 0.0 if wph is None else 10 * (min(wph, 100) / 100 if wph < 100 else min(1, 350 / wph))
    s_band = (in_band / len(paras) * 25) if paras else 0
    s_over = 10 * (1 - min(1, (oversize / len(paras)) * 3)) if paras else 0
    s_list = min(1, list_items / 6) * 9
    s_table = 6 if doc.tables >= 1 else 0
    s_sec = (sec_ok / len(sections) * 20) if sections and h23 else 0
    components = [
        {"key": "headings", "label": "Heading structure", "score": round(s_h1 + s_h2 + s_hier + s_dens, 1), "max": 30},
        {"key": "paragraphs", "label": "Paragraph chunk size", "score": round(s_band + s_over, 1), "max": 35},
        {"key": "lists", "label": "Lists & tables", "score": round(s_list + s_table, 1), "max": 15},
        {"key": "sections", "label": "Section sizing", "score": round(s_sec, 1), "max": 20},
    ]
    score = round(sum(c["score"] for c in components))

    suggestions: list[tuple[float, str]] = []
    if h1 != 1:
        suggestions.append((5 - s_h1, "Use exactly one H1 for the page topic." if h1 > 1 else "Add an H1 that states the page topic."))
    if h2 < 4:
        suggestions.append((10 - s_h2, f"Only {h2} H2 header(s): break the page into at least 4 topical sections so each can become its own retrieval chunk."))
    if skips:
        suggestions.append((5 - s_hier, f"{skips} heading level skip(s) (e.g. H2 straight to H4): keep a strict H1 > H2 > H3 hierarchy."))
    if wph is None:
        suggestions.append((10, "No H2/H3 headers: add descriptive subheadings, since chunkers split on them."))
    elif wph > 350:
        suggestions.append((10 - s_dens, f"About {wph:.0f} words between headings: add a descriptive subheading every 150-300 words."))
    elif wph < 100:
        suggestions.append((10 - s_dens, f"Headings appear every {wph:.0f} words, which fragments the content: merge thin sections."))
    if oversize:
        suggestions.append((10 - s_over, f"{oversize} paragraph(s) exceed {OVERSIZE} words (~{OVERSIZE * TOKENS_PER_WORD:.0f} tokens): split them at topic shifts so each chunk stays self-contained."))
    if paras and in_band / len(paras) < 0.6:
        suggestions.append((25 - s_band, f"Only {in_band / len(paras):.0%} of paragraphs are {BAND_MIN}-{BAND_MAX} words; aim for self-contained paragraphs in that range."))
    if fragments > max(3, len(paras) * 0.3):
        suggestions.append((3, f"{fragments} very short paragraphs (<{FRAGMENT} words): fold one-liners into the paragraph they support."))
    if list_items < 6:
        suggestions.append((9 - s_list, "Add bullet or numbered lists for steps, features and comparisons; lists chunk and quote cleanly."))
    if doc.tables == 0:
        suggestions.append((6, "Add a data or comparison table where it fits; tabular facts are easy for answer engines to lift."))
    big = [s for s in sections if s["words"] > SECTION_MAX]
    if big:
        suggestions.append((20 - s_sec, f"{len(big)} section(s) run over {SECTION_MAX} words (e.g. “{big[0]['title'][:50]}”, {big[0]['words']} words): split them with H3s."))
    suggestions.sort(key=lambda x: -x[0])

    avg = statistics.fmean(paras) if paras else 0
    return {
        "score": score,
        "rating": "Highly chunkable" if score >= 80 else "Moderate" if score >= 50 else "Poor",
        "components": components,
        "metrics": {
            "words": words_total,
            "headings": len(heads), "h1": h1, "h2": h2, "h3": sum(1 for h in heads if h.level == 3),
            "header_density_per_1k": round(len(heads) / words_total * 1000, 1),
            "words_per_heading": round(wph) if wph else None,
            "paragraphs": len(paras),
            "avg_block_words": round(avg), "avg_block_tokens": round(avg * TOKENS_PER_WORD),
            "ideal_band_share": round(in_band / len(paras), 2) if paras else 0,
            "oversize_paragraphs": oversize, "fragments": fragments,
            "list_items": list_items, "tables": doc.tables,
            "sections": len(sections), "sections_in_range": sec_ok,
            "token_note": "Tokens are estimated at ~1.3 per word.",
        },
        "suggestions": [t for _, t in suggestions[:6]],
    }


# ---------------------------------------------------------------------------
# Fix snippets
# ---------------------------------------------------------------------------
def robots_fix(blocked: list[dict]) -> str:
    lines = [
        "# Add to https://YOUR-DOMAIN/robots.txt",
        "# If a 'User-agent: <bot>' group for the same bot already exists, replace it (or delete its Disallow lines).",
    ]
    for t in blocked:
        lines += ["", f"# {t['token']}: {t['description']}", f"User-agent: {t['token']}", "Allow: /"]
    lines += [
        "", "# A dedicated group replaces the 'User-agent: *' rules for that bot, so it is allowed everywhere.",
        "# Re-add Disallow lines for any sections you still want hidden from it, e.g.:", "# Disallow: /admin/",
    ]
    return "\n".join(lines) + "\n"


def directive_fixes(findings: list[dict]) -> list[dict]:
    fixes = []
    meta = [f for f in findings if f["source"].startswith("<meta")]
    hdr = [f for f in findings if f["source"].startswith("X-Robots-Tag")]
    if meta:
        # f["source"] looks like '<meta name="robots">'; rebuild the offending tag with its directive
        tags = "\n".join(f'{f["source"][:-1]} content="{f["directive"]}"> <!-- remove -->' for f in meta)
        fixes.append({
            "id": "meta", "title": "HTML meta robots", "language": "html",
            "code": f"<!-- Remove these blocking directives from <head>: -->\n{tags}\n\n<!-- Recommended for pages you want cited: -->\n<meta name=\"robots\" content=\"index, follow, max-snippet:-1\">\n",
        })
    if hdr:
        fixes.append({
            "id": "headers", "title": "X-Robots-Tag header", "language": "nginx",
            "code": (
                "# The response sends: " + "; ".join(f"{f['source']}: {f['directive']}" for f in hdr) + "\n\n"
                "# Nginx: delete the add_header X-Robots-Tag line that sets it, or hide an upstream value:\n"
                "proxy_hide_header X-Robots-Tag;\n\n"
                "# Apache (.htaccess / vhost):\n"
                "Header unset X-Robots-Tag\n\n"
                "# If a CDN or framework adds it (Cloudflare Transform Rules, Next.js headers(), Vercel), remove it there.\n"
            ),
        })
    return fixes


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------
def _check(cid: str, label: str, status: str, detail: str) -> dict:
    return {"id": cid, "label": label, "status": status, "detail": detail}


@router.post("/simulate-llm-crawler")
async def simulate_llm_crawler(data: CrawlerRequest):
    url = data.url
    try:
        _assert_public_url(url)
    except FetchError as e:
        raise HTTPException(status_code=400, detail=str(e))
    parsed = urlparse(url)
    target = (parsed.path or "/") + (f"?{parsed.query}" if parsed.query else "")
    robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"

    results = await asyncio.gather(
        asyncio.to_thread(fetch_as, url, BROWSER_UA),
        asyncio.to_thread(fetch_as, robots_url, BROWSER_UA, ROBOTS_MAX_BYTES),
        *[asyncio.to_thread(fetch_as, url, b["ua"]) for b in BOTS],
    )
    base, robots_resp, bot_fetches = results[0], results[1], results[2:]

    if base["error"] or (base["status"] or 0) >= 400:
        why = base["error"] or f"HTTP {base['status']}"
        raise HTTPException(status_code=400, detail=f"The page could not be fetched with a normal browser user-agent ({why}).")
    base_doc = parse_html(base["text"], url)
    base_words = len(WORD_RE.findall(base_doc.text))

    # robots.txt state
    rs = robots_resp["status"]
    if rs == 200 and not robots_resp["error"]:
        robots_state, groups = "found", parse_robots(robots_resp["text"])
    elif rs is not None and 400 <= rs < 500:
        robots_state, groups = "missing", []  # RFC 9309: unavailable (4xx) means no restrictions
    else:
        robots_state, groups = "unverified", []

    rag = chunkability(base_doc)
    bots_out = []
    all_robots_blocked: dict[str, dict] = {}
    all_dir_findings: dict[tuple[str, str], dict] = {}

    for bot, fetched in zip(BOTS, bot_fetches):
        checks: list[dict] = []
        token_rows = []
        for token, role, desc in bot["tokens"]:
            ev = evaluate_robots(groups, token, target) if robots_state != "unverified" else None
            row = {
                "token": token, "role": role, "description": desc, "gating": role in GATING_ROLES,
                "allowed": None if ev is None else ev["allowed"],
                "rule": None if ev is None else ev["rule"], "rule_line": None if ev is None else ev["line"],
                "group": None if ev is None else ev["group"],
            }
            token_rows.append(row)

        blocked_gating = [r for r in token_rows if r["gating"] and r["allowed"] is False]
        blocked_other = [r for r in token_rows if not r["gating"] and r["allowed"] is False]
        if robots_state == "unverified":
            checks.append(_check("robots", "robots.txt compliance", "warn", "robots.txt could not be fetched (server error or timeout), so access is unverified."))
        elif blocked_gating:
            d = "; ".join(f"{r['token']} blocked by “{r['rule']}” in the “{r['group']}” group (line {r['rule_line']})" for r in blocked_gating)
            checks.append(_check("robots", "robots.txt compliance", "fail", d))
            for r in blocked_gating:
                all_robots_blocked.setdefault(r["token"], r)
        elif blocked_other:
            d = "; ".join(f"{r['token']} ({r['description']}) is blocked" for r in blocked_other) + ". The search crawler is allowed, which is a common deliberate setup."
            checks.append(_check("robots", "robots.txt compliance", "warn", d))
        else:
            note = "no robots.txt found, so nothing is restricted" if robots_state == "missing" else "all crawlers for this bot are allowed"
            checks.append(_check("robots", "robots.txt compliance", "pass", note))

        # HTTP access as this bot's user agent
        if fetched["error"]:
            checks.append(_check("http", f"HTTP access as {bot['fetch_as']}", "fail", fetched["error"]))
            bot_doc, bot_html = None, base["text"]
        else:
            st = fetched["status"]
            is_html = "html" in fetched["content_type"] or "xml" in fetched["content_type"]
            if st >= 400:
                checks.append(_check("http", f"HTTP access as {bot['fetch_as']}", "fail",
                                     f"HTTP {st} for this user-agent while a normal browser got {base['status']}: a firewall / WAF / CDN rule is probably blocking the bot."))
                bot_doc, bot_html = None, base["text"]
            elif not is_html:
                checks.append(_check("http", f"HTTP access as {bot['fetch_as']}", "fail", f"Got {fetched['content_type'] or 'an unknown content type'} instead of HTML."))
                bot_doc, bot_html = None, base["text"]
            else:
                bot_doc, bot_html = parse_html(fetched["text"], url), fetched["text"]
                bw = len(WORD_RE.findall(bot_doc.text))
                if base_words >= 100 and bw < base_words * 0.5:
                    checks.append(_check("http", f"HTTP access as {bot['fetch_as']}", "warn",
                                         f"HTTP {st}, but this user-agent received {bw} words versus {base_words} for a browser: the server may be serving bots reduced or challenge content."))
                else:
                    checks.append(_check("http", f"HTTP access as {bot['fetch_as']}", "pass", f"HTTP {st}, {bw} words received."))

        eff_doc = bot_doc or base_doc
        hyd = analyze_hydration(bot_html, eff_doc)
        checks.append(_check("rendering", "Content in raw HTML (no JS run)", hyd["status"], hyd["detail"]))

        headers = fetched["headers"] if not fetched["error"] and fetched["status"] and fetched["status"] < 400 else base["headers"]
        findings = find_directives(eff_doc, headers, [t for t, _, _ in bot["tokens"]])
        if any(f["severity"] == "fail" for f in findings):
            checks.append(_check("directives", "Meta robots & X-Robots-Tag", "fail", "; ".join(f"{f['source']}: {f['directive']} ({f['effect']})" for f in findings if f["severity"] == "fail")))
        elif findings:
            checks.append(_check("directives", "Meta robots & X-Robots-Tag", "warn", "; ".join(f"{f['source']}: {f['directive']} ({f['effect']})" for f in findings)))
        else:
            checks.append(_check("directives", "Meta robots & X-Robots-Tag", "pass", "No noindex, nosnippet, noai or noimageai directives found."))
        for f in findings:
            all_dir_findings[(f["source"], f["directive"])] = f

        failed = [c for c in checks if c["status"] == "fail"]
        warned = [c for c in checks if c["status"] == "warn"]
        status = "fail" if failed else "warn" if warned else "pass"
        if failed:
            label = "Unrendered" if all(c["id"] == "rendering" for c in failed) else "Blocked / Unrendered" if any(c["id"] == "rendering" for c in failed) else "Blocked"
        else:
            label = "Allowed with warnings" if warned else "Allowed & Parsable"
        bots_out.append({
            "id": bot["id"], "name": bot["name"], "vendor": bot["vendor"], "fetched_as": bot["fetch_as"],
            "http_status": fetched["status"], "status": status, "label": label,
            "checks": checks, "tokens": token_rows,
        })

    fixes: list[dict] = []
    if all_robots_blocked:
        fixes.append({"id": "robots", "title": "robots.txt", "language": "robots", "code": robots_fix(list(all_robots_blocked.values()))})
    fixes += directive_fixes(list(all_dir_findings.values()))
    if any(c["status"] == "fail" and c["id"] == "http" for b in bots_out for c in b["checks"]):
        fixes.append({
            "id": "waf", "title": "Firewall / CDN", "language": "text",
            "code": (
                "Some AI crawlers received an HTTP error while a browser did not.\n"
                "- Cloudflare: Security > Bots > allow verified AI crawlers (or add a WAF skip rule for their user-agents).\n"
                "- Other WAFs/CDNs: allowlist OAI-SearchBot, PerplexityBot, ClaudeBot / Claude-SearchBot by user-agent AND published IP ranges.\n"
                "Note: this test sends the user-agent strings only; sites that verify bots by IP may treat it as an unverified bot."
            ),
        })

    return {
        "status": "success",
        "url": url,
        "robots": {"url": robots_url, "state": robots_state, "http_status": rs, "bytes": len(robots_resp["text"].encode()) if robots_state == "found" else 0},
        "page": {"http_status": base["status"], "words": base_words, "html_truncated": base["truncated"]},
        "bots": bots_out,
        "summary": {
            "passing": sum(b["status"] == "pass" for b in bots_out),
            "warnings": sum(b["status"] == "warn" for b in bots_out),
            "failing": sum(b["status"] == "fail" for b in bots_out),
        },
        "rag": rag,
        "fixes": fixes,
        "disclaimer": (
            "Requests use each crawler's user-agent string but come from this server's IP, so IP-verified bot rules cannot be tested. "
            "JavaScript is not executed: rendering is a static-HTML heuristic. robots.txt is evaluated per RFC 9309."
        ),
    }

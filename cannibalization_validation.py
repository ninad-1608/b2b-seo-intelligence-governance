"""
Validation checks for cannibalization candidates.

A query that shows two or more URLs is only a CANDIDATE. Before it is called harmful it runs six checks, and every check reports
whether it dismisses the candidate, supports it, is neutral, or could not be tested with the evidence we have.

  low_volume       a. the weakest competing URL, or the query as a whole, is under the 20-impression floor: too little to call
  canonical        b. Google already treats the URLs as one page (same chosen canonical), or ignores a declared canonical (a real conflict)
  variant          c. the URLs are regional (en-gb / en-us, de.example.com) or audience (for-enterprise / for-smb) variants of one page
  country_overlap  d. different countries get different URLs (country split), the URLs never overlap on a day (a replacement), or they
                      overlap on the same day / swap the lead back and forth (flip-flopping)
  page_intent      e. the URLs are different page types serving different intents (a guide and a product page are not substitutes)
  serp_domination  f. SIXTH CHECK, added from the "winning SERP domination" wording of the brief: your pages hold the top results
                      together, or one URL takes nearly all the impressions, so there is nothing to consolidate

Verdicts:  harmful          "Harmful overlap": nothing explained it away
           false_positive   "False positive": b, c, d or e showed the URLs are not really competing
           cleared          "Cleared by validation checks": a or f, too little data or an overlap that is a win

Honest limits: the stored Search Console rows have no country, date or canonical data, so checks b and d are "not testable" until a deep
check fetches that evidence for the query (see gather_deep_evidence). Checks c and e read the URL text only (no page content, no
hreflang tags), so they are heuristics. A harmful verdict with untested checks says so (confidence "partial").
"""

import datetime
import json
import re
from collections import defaultdict
from contextlib import closing
from urllib.parse import parse_qs, urlparse

VOLUME_FLOOR = 20  # impressions
DOMINATION_TOP_POSITION = 5.0  # both leading URLs at or above this average position = they own the top of the results together
CONCENTRATION_SHARE = 0.80  # one URL with this share (and a top-5 position) leaves nothing worth consolidating
COUNTRY_MIN_IMPRESSIONS = 20  # a country needs this many impressions before it counts
COUNTRY_WINNER_SHARE = 0.80  # "one URL serves this country"
CONTESTED_SHARE = 0.20  # two URLs each over this share of a country's impressions = contested
PRESENT_MIN_IMPRESSIONS = 3  # a URL "appears" on a day with at least this many impressions
REPLACEMENT_MIN_DAYS = 3  # each URL must genuinely appear on this many days before 'one replaced the other' is believed
MIN_DAYS = 7  # distinct days before overlap / flip-flop can be judged
OVERLAP_DAY_SHARE = 0.30
FLIP_MIN_CHANGES = 3
FLIP_RATE = 0.30
MAX_DEEP_URLS = 6

VERDICTS = {
    "harmful": "Harmful overlap",
    "false_positive": "False positive",
    "cleared": "Cleared by validation checks",
}
CHECK_ORDER = ("low_volume", "canonical", "variant", "country_overlap", "page_intent", "serp_domination")
CHECK_LABELS = {
    "low_volume": "Low-volume floor",
    "canonical": "Canonical consistency",
    "variant": "Regional & audience variants",
    "country_overlap": "Country split & same-day overlap",
    "page_intent": "Page type & intent",
    "serp_domination": "SERP domination",
}
DISMISS_VERDICT = {"low_volume": "cleared", "canonical": "false_positive", "variant": "false_positive", "country_overlap": "false_positive", "page_intent": "false_positive", "serp_domination": "cleared"}


def _check(cid: str, outcome: str, summary: str, threshold: str, observed: str) -> dict:
    return {"id": cid, "label": CHECK_LABELS[cid], "outcome": outcome, "summary": summary, "threshold": threshold, "observed": observed}


def _short_url(u: str, n: int = 60) -> str:
    return u if len(u) <= n else u[: n - 1] + "…"


def norm_url(u: str) -> str:
    p = urlparse(u.strip())
    path = p.path.rstrip("/") or "/"
    return f"{p.scheme.lower()}://{p.netloc.lower()}{path}" + (f"?{p.query}" if p.query else "")


# ---------------------------------------------------------------------------
# a. low-volume floor
# ---------------------------------------------------------------------------
def check_low_volume(urls: list[dict]) -> dict:
    total = sum(u["impressions"] for u in urls)
    weakest = min(u["impressions"] for u in urls)
    thr = f"Set aside when the query has under {VOLUME_FLOOR} impressions, or its weakest competing URL does"
    obs = f"{total:,} impressions in total; weakest URL has {weakest:,}"
    if total < VOLUME_FLOOR or weakest < VOLUME_FLOOR:
        return _check("low_volume", "dismisses", f"Too little data to call this harmful: the weakest competing URL has only {weakest:,} impressions (floor {VOLUME_FLOOR}).", thr, obs)
    return _check("low_volume", "neutral", "Enough impressions on every competing URL to judge.", thr, obs)


# ---------------------------------------------------------------------------
# b. canonical consistency (needs deep evidence)
# ---------------------------------------------------------------------------
def check_canonical(urls: list[dict], evidence: dict | None) -> dict:
    thr = "Dismissed when Google picked the same canonical for every URL; flagged when Google ignores a declared canonical"
    canon = (evidence or {}).get("canonicals") or {}
    known = {}
    for u in urls:
        c = canon.get(u["url"]) or canon.get(norm_url(u["url"]))
        if c and (c.get("google") or c.get("declared")):
            known[u["url"]] = c
    if len(known) < 2:
        why = "no canonical data has been fetched for this query yet" if not canon else "canonical data could not be read for enough of these URLs"
        return _check("canonical", "not_testable", f"Not tested: {why}. Run the deep check to compare the declared canonical with the one Google chose.", thr, "no canonical data")
    eff = {u: norm_url(c.get("google") or c.get("declared")) for u, c in known.items()}
    obs = "; ".join(f"{_short_url(u, 40)} → {_short_url(e, 40)}" for u, e in list(eff.items())[:4])
    conflicts = [u for u, c in known.items() if c.get("google") and c.get("declared") and norm_url(c["google"]) != norm_url(c["declared"])]
    if len(eff) == len(urls) and len(set(eff.values())) == 1:
        return _check("canonical", "dismisses", f"Google treats all {len(urls)} URLs as one page (canonical {_short_url(next(iter(eff.values())))}), so they are not competing.", thr, obs)
    if conflicts:
        u = conflicts[0]
        return _check("canonical", "supports", f"Google ignores the declared canonical on {_short_url(u)}: you declared {_short_url(known[u]['declared'])} but Google chose {_short_url(known[u]['google'])}. Fixing that is part of the cure.", thr, obs)
    return _check("canonical", "neutral", "Each URL is its own canonical in Google's index, so they really are separate pages.", thr, obs)


# ---------------------------------------------------------------------------
# c. regional and audience variants (URL text only)
# ---------------------------------------------------------------------------
_LANGS = set("en de fr es it pt nl sv da no nb fi pl cs sk hu ro bg el tr ru uk ja ko zh ar he hi id th vi ms".split())
_REGIONS = {"us", "uk", "gb", "ca", "au", "nz", "ie", "in", "sg", "za", "eu"}
_GENERIC_TLDS = {"com", "org", "net", "io", "co", "ai", "app", "dev", "info", "biz", "edu", "gov"}
_AUDIENCE = r"enterprise|smb|small-business|mid-market|midmarket|startups?|agency|agencies|nonprofits?|government|education|healthcare"
_AUDIENCE_SEG = re.compile(rf"(?:(?P<pre>.+?)-)?(?:for-)?(?P<aud>{_AUDIENCE})(?:-(?P<post>.+))?", re.I)
_LOCALE_RE = re.compile(r"^([a-z]{2})(?:[-_]([a-z]{2}))?$", re.I)
_LOCALE_PARAMS = ("lang", "hl", "locale", "language", "country", "gl")


def _locale_token(seg: str) -> str | None:
    seg = seg.lower()
    if seg in _REGIONS:
        return seg
    m = _LOCALE_RE.match(seg)
    if m and m.group(1) in _LANGS and (m.group(2) is None or len(m.group(2)) == 2):
        return seg.replace("_", "-")
    return None


def variant_signature(url: str) -> tuple[str, tuple, tuple]:
    """(base key with locale and audience removed, locale markers, audience markers)."""
    p = urlparse(url.strip())
    labels = p.netloc.lower().split(":")[0].split(".")
    locales: list[str] = []
    if len(labels) >= 3 and _locale_token(labels[0]) and labels[0] != "www":
        locales.append(f"sub:{labels[0]}")
        labels = labels[1:]
    if len(labels) >= 3 and labels[-2] in ("co", "com", "org", "net") and len(labels[-1]) == 2:
        locales.append(f"tld:{labels[-2]}.{labels[-1]}")
        labels = labels[:-2] + ["*"]
    elif len(labels) >= 2 and len(labels[-1]) == 2 and labels[-1] not in _GENERIC_TLDS:
        locales.append(f"tld:{labels[-1]}")
        labels = labels[:-1] + ["*"]
    elif len(labels) >= 2:
        labels = labels[:-1] + ["*"]  # .com / .io / ...: compared with country domains as the same site
    segs = [s for s in p.path.split("/") if s]
    kept = []
    for i, s in enumerate(segs):
        tok = _locale_token(s) if i < 2 else None
        if tok:
            locales.append(f"path:{tok}")
        else:
            kept.append(s)
    for k, v in parse_qs(p.query).items():
        if k.lower() in _LOCALE_PARAMS and v:
            locales.append(f"param:{k.lower()}={v[0].lower()}")
    audience: list[str] = []
    cleaned = []
    for seg in kept:
        m = _AUDIENCE_SEG.fullmatch(seg.lower())
        if m:
            audience.append(m.group("aud").lower())
            rest = "-".join(x for x in (m.group("pre"), m.group("post")) if x)
            if rest:
                cleaned.append(rest)
        else:
            cleaned.append(seg.lower())
    path = "/" + "/".join(cleaned)
    return f"{'.'.join(labels)}{path}", tuple(sorted(locales)), tuple(sorted(audience))


def check_variant(urls: list[dict]) -> dict:
    thr = "Dismissed when every URL is the same page in a different locale or for a different audience"
    sigs = [variant_signature(u["url"]) for u in urls]
    bases = {s[0] for s in sigs}
    markers = [(s[1], s[2]) for s in sigs]
    obs = "; ".join(f"{_short_url(u['url'], 38)} → locale {'/'.join(s[1]) or '—'}, audience {'/'.join(s[2]) or '—'}" for u, s in list(zip(urls, sigs))[:4])
    unmarked = sum(1 for m in markers if m == ((), ()))
    has_audience = any(m[1] for m in markers)
    # one unmarked URL is fine for locales (the default-language page) but not for audiences, where it would be a different page
    if len(bases) == 1 and len(set(markers)) == len(urls) and unmarked <= (0 if has_audience else 1) and any(m != ((), ()) for m in markers):
        kind = "regional" if any(s[1] for s in sigs) and not any(s[2] for s in sigs) else "audience" if any(s[2] for s in sigs) and not any(s[1] for s in sigs) else "regional and audience"
        return _check("variant", "dismisses", f"These are {kind} variants of one page ({_short_url(next(iter(bases)))}): each serves its own market or audience, so they are not competing.", thr, obs)
    return _check("variant", "neutral", "The URLs are not locale or audience copies of one another.", thr, obs)


# ---------------------------------------------------------------------------
# d. country split, same-day overlap, flip-flopping (needs deep evidence)
# ---------------------------------------------------------------------------
def check_country_overlap(urls: list[dict], evidence: dict | None) -> dict:
    thr = (f"Country split: each country (≥{COUNTRY_MIN_IMPRESSIONS} impressions) is {COUNTRY_WINNER_SHARE:.0%}+ served by one URL and the winners differ. "
           f"Harm: ≥{OVERLAP_DAY_SHARE:.0%} of days with 2+ URLs showing, or ≥{FLIP_MIN_CHANGES} lead changes at ≥{FLIP_RATE:.0%} of days (needs {MIN_DAYS}+ days)")
    daily = (evidence or {}).get("daily") or []
    wanted = {norm_url(u["url"]) for u in urls}
    daily = [d for d in daily if norm_url(d["url"]) in wanted]
    prev = (evidence or {}).get("previous")
    period_note = ""
    if prev:
        cur_lead = min(urls, key=lambda u: u["position"])["url"]
        prev_lead = min(prev.items(), key=lambda kv: kv[1][1])[0] if prev else None
        if prev_lead and norm_url(prev_lead) != norm_url(cur_lead):
            period_note = f" Period totals alone show the lead moving from {_short_url(prev_lead, 36)} to {_short_url(cur_lead, 36)}; daily data is needed to tell a flip-flop from a one-off change."
    if not daily:
        return _check("country_overlap", "not_testable", "Not tested: Search Console rows are stored without country or date. Run the deep check to fetch the per-day, per-country data for this query." + period_note, thr, "no country or daily data")

    # country split
    by_country: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for d in daily:
        by_country[d["country"]][norm_url(d["url"])] += d["impressions"]
    big = {c: v for c, v in by_country.items() if sum(v.values()) >= COUNTRY_MIN_IMPRESSIONS}
    winners, contested = {}, []
    for c, v in big.items():
        tot = sum(v.values())
        top_url, top_imps = max(v.items(), key=lambda kv: kv[1])
        winners[c] = (top_url, top_imps / tot)
        if sum(1 for x in v.values() if x / tot >= CONTESTED_SHARE) >= 2:
            contested.append(c)
    # per (country, day)
    present: dict[tuple, set] = defaultdict(set)
    days_present: dict[str, set] = defaultdict(set)
    lead_by: dict[tuple, dict] = defaultdict(dict)
    days = set()
    for d in daily:
        days.add(d["date"])
        if d["impressions"] >= PRESENT_MIN_IMPRESSIONS:
            present[(d["country"], d["date"])].add(norm_url(d["url"]))
            days_present[norm_url(d["url"])].add(d["date"])
            lead_by[d["country"]].setdefault(d["date"], []).append((d["position"], norm_url(d["url"])))
    overlap_days = sum(1 for s in present.values() if len(s) >= 2)
    day_total = len(present)
    share = overlap_days / day_total if day_total else 0.0
    # flip-flopping: per country, the lead URL changing from one day to the next
    worst_changes, worst_rate, worst_country = 0, 0.0, None
    for c, per_day in lead_by.items():
        seq = [min(per_day[dt])[1] for dt in sorted(per_day)]
        if len(seq) < MIN_DAYS:
            continue
        changes = sum(1 for a, b in zip(seq, seq[1:]) if a != b)
        rate = changes / (len(seq) - 1)
        if changes > worst_changes:
            worst_changes, worst_rate, worst_country = changes, rate, c
    n_days = len(days)
    obs = f"{len(big)} countries with enough data, {len(contested)} contested; {n_days} days, URLs overlapped on {overlap_days} of {day_total} country-days ({share:.0%}); most lead changes {worst_changes}" + (f" in {worst_country}" if worst_country else "")

    if len(big) >= 2 and not contested and all(w[1] >= COUNTRY_WINNER_SHARE for w in winners.values()) and len({w[0] for w in winners.values()}) >= 2:
        who = ", ".join(f"{c}: {_short_url(w[0], 30)}" for c, w in list(winners.items())[:4])
        return _check("country_overlap", "dismisses", f"Country split: different countries are served by different URLs ({who}), so they are not competing for the same searches.", thr, obs)
    real = [u for u, ds in days_present.items() if len(ds) >= REPLACEMENT_MIN_DAYS]  # a URL that barely shows is noise, not a replaced page
    if n_days >= MIN_DAYS and overlap_days == 0 and len(real) >= 2:
        return _check("country_overlap", "dismisses", f"The URLs never appear on the same day across {n_days} days: one replaced the other rather than competing.", thr, obs)
    if worst_changes >= FLIP_MIN_CHANGES and worst_rate >= FLIP_RATE:
        return _check("country_overlap", "supports", f"Flip-flopping: the leading URL changed {worst_changes} times ({worst_rate:.0%} of days) in {worst_country}, which splits ranking signals and makes results unstable.", thr, obs)
    if n_days >= MIN_DAYS and share >= OVERLAP_DAY_SHARE:
        return _check("country_overlap", "supports", f"Same-day overlap: two or more of your URLs showed together on {share:.0%} of days ({overlap_days} of {day_total} country-days).", thr, obs)
    if n_days < MIN_DAYS:
        return _check("country_overlap", "neutral", f"Only {n_days} day(s) of data (need {MIN_DAYS}) so overlap and flip-flopping cannot be judged; no country split found.", thr, obs)
    return _check("country_overlap", "neutral", "No country split, no sustained same-day overlap and no flip-flopping.", thr, obs)


# ---------------------------------------------------------------------------
# e. page type and intent (URL text only)
# ---------------------------------------------------------------------------
_INFO_SEGS = {"blog", "blogs", "articles", "article", "news", "insights", "learn", "guides", "guide", "academy", "docs", "documentation", "help", "support", "kb", "glossary", "faq", "tutorials", "tutorial", "how-to", "resources", "case-studies", "ebooks", "webinars"}
_COMM_SEGS = {"products", "product", "solutions", "solution", "services", "service", "features", "feature", "pricing", "plans", "integrations", "integration", "demo", "request-demo", "platform", "industries", "compare", "alternatives", "customers", "partners", "software"}
_LISTING_SEGS = {"category", "categories", "tag", "tags", "archive", "topics", "topic"}
_INFO_SLUG = re.compile(r"(^|/)(what-is|how-to|how-do|guide-to|ultimate-guide|why-|beginners?-guide|[a-z0-9-]*-guide$|[a-z0-9-]*-examples?$|[a-z0-9-]*-template)", re.I)
_Q_INFO = re.compile(r"\b(what|how|why|when|guide|examples?|tutorial|template|meaning|definition|vs|versus|tips|ideas|checklist)\b", re.I)
_Q_COMM = re.compile(r"\b(best|top|software|platform|tools?|services?|pricing|price|cost|buy|alternatives?|reviews?|demo|solutions?|vendors?|companies|providers?)\b", re.I)


def page_type(url: str) -> tuple[str, str]:
    """(type label, family) read from the URL path: informational, commercial, listing, home or unknown."""
    segs = [s.lower() for s in urlparse(url).path.split("/") if s]
    if not segs:
        return "home page", "home"
    for s in segs[:3]:
        if s in _LISTING_SEGS:
            return "listing", "listing"
    for s in segs[:3]:
        if s in _INFO_SEGS:
            return {"blog": "blog post", "docs": "documentation", "documentation": "documentation", "glossary": "glossary entry", "case-studies": "case study"}.get(s, "guide / article"), "informational"
        if s in _COMM_SEGS:
            return {"pricing": "pricing page", "integrations": "integration page", "integration": "integration page", "solutions": "solution page", "solution": "solution page", "services": "service page", "service": "service page"}.get(s, "product / solution page"), "commercial"
    if _INFO_SLUG.search("/".join(segs)):
        return "guide / article", "informational"
    return "unclassified page", "unknown"


def query_intent(q: str) -> str:
    info, comm = bool(_Q_INFO.search(q)), bool(_Q_COMM.search(q))
    return "mixed" if info and comm else "informational" if info else "commercial" if comm else "unclear"


def check_page_intent(query: str, urls: list[dict]) -> dict:
    thr = "Dismissed when the competing URLs are different page types serving different intents (informational vs commercial vs listing)"
    types = [page_type(u["url"]) for u in urls]
    fams = {f for _t, f in types if f != "unknown"}
    obs = f"query reads as {query_intent(query)}; " + "; ".join(f"{_short_url(u['url'], 34)} = {t}" for u, (t, _f) in list(zip(urls, types))[:4])
    if len(fams) >= 2:
        names = " and ".join(sorted({t for t, f in types if f != "unknown"})[:3])
        return _check("page_intent", "dismisses", f"These are different kinds of page ({names}) that serve different intents, so consolidating them would remove one intent from the results.", thr, obs)
    if not fams:
        return _check("page_intent", "neutral", "The page types could not be told from the URLs, so this check cannot dismiss anything.", thr, obs)
    return _check("page_intent", "neutral", f"All the URLs look like the same kind of page ({types[0][0]}), serving the same intent.", thr, obs)


# ---------------------------------------------------------------------------
# f. SERP domination (sixth check)
# ---------------------------------------------------------------------------
def check_serp_domination(urls: list[dict]) -> dict:
    thr = f"Cleared when your two best URLs both average position ≤ {DOMINATION_TOP_POSITION:g}, or one URL has ≥ {CONCENTRATION_SHARE:.0%} of impressions at position ≤ {DOMINATION_TOP_POSITION:g}"
    by_pos = sorted(urls, key=lambda u: (u["position"], -u["impressions"]))
    total = sum(u["impressions"] for u in urls) or 1
    top = max(urls, key=lambda u: u["impressions"])
    share = top["impressions"] / total
    obs = f"best two positions {by_pos[0]['position']:.1f} and {by_pos[1]['position']:.1f}; top URL has {share:.0%} of impressions"
    if by_pos[1]["position"] <= DOMINATION_TOP_POSITION:
        return _check("serp_domination", "dismisses", f"Winning SERP domination: your pages hold positions {by_pos[0]['position']:.1f} and {by_pos[1]['position']:.1f} together. Owning more of the top results is a win, not a problem.", thr, obs)
    if share >= CONCENTRATION_SHARE and top["position"] <= DOMINATION_TOP_POSITION:
        return _check("serp_domination", "dismisses", f"One URL takes {share:.0%} of the impressions at position {top['position']:.1f}; the rest is too small to be worth consolidating.", thr, obs)
    return _check("serp_domination", "neutral", f"Not dominating: the second-best URL averages position {by_pos[1]['position']:.1f}, so the URLs are splitting a result neither holds firmly.", thr, obs)


# ---------------------------------------------------------------------------
def validate_query(query: str, urls: list[dict], evidence: dict | None = None) -> dict:
    """urls: [{url, impressions, position}] for the competing URLs (at least two)."""
    checks = [
        check_low_volume(urls),
        check_canonical(urls, evidence),
        check_variant(urls),
        check_country_overlap(urls, evidence),
        check_page_intent(query, urls),
        check_serp_domination(urls),
    ]
    by_id = {c["id"]: c for c in checks}
    decider = next((cid for cid in CHECK_ORDER if by_id[cid]["outcome"] == "dismisses"), None)
    verdict = DISMISS_VERDICT[decider] if decider else "harmful"
    untested = [c["id"] for c in checks if c["outcome"] == "not_testable"]
    supports = [c["id"] for c in checks if c["outcome"] == "supports"]
    if decider:
        headline = by_id[decider]["summary"]
    else:
        n = len(urls)
        headline = f"{n} URLs compete for this query and none of the checks explains it away."
        if supports:
            headline += " " + " ".join(by_id[s]["summary"] for s in supports)
    return {
        "verdict": verdict,
        "label": VERDICTS[verdict],
        "headline": headline,
        "decided_by": decider,
        "domination": decider == "serp_domination" and "Winning SERP domination" in by_id[decider]["summary"],
        "supporting": supports,
        "checks": checks,
        "untested": untested,
        "tested": len(checks) - len(untested),
        "total": len(checks),
        "confidence": "full" if not untested else "partial",
    }


# ---------------------------------------------------------------------------
# shared by the alert engine and the "needs attention" strip, which work on raw synced rows
# ---------------------------------------------------------------------------
def validate_split_map(split: dict[str, dict], previous_rows: list[tuple] | None = None) -> dict[str, dict]:
    """split: alerting_engine_router._split_map output. Returns {query key: validation}, using any stored deep evidence."""
    prev_by_q: dict[str, dict] = defaultdict(dict)
    for q, page, _c, imps, _ctr, pos in previous_rows or []:
        a = prev_by_q[q.lower()].setdefault(page, [0, 0.0])
        a[0] += imps
        a[1] += pos * imps
    out = {}
    for key, v in split.items():
        urls = [{"url": u, "impressions": d["imps"], "position": (d["pos_w"] / d["imps"]) if d["imps"] else 0.0} for u, d in v["urls"].items()]
        urls.sort(key=lambda x: (x["position"], -x["impressions"]))
        ev = stored_evidence(v["query"]) or {}
        if prev_by_q.get(key):
            ev = {**ev, "previous": {u: (a[0], (a[1] / a[0]) if a[0] else 0.0) for u, a in prev_by_q[key].items()}}
        out[key] = validate_query(v["query"], urls, ev or None)
    return out


# ---------------------------------------------------------------------------
# deep evidence: the data the stored rows do not have
# ---------------------------------------------------------------------------
def _db():
    import gsc_connector_router as gsc

    conn = gsc._db()
    conn.execute("CREATE TABLE IF NOT EXISTS cannibal_evidence (query_key TEXT PRIMARY KEY, evidence_json TEXT NOT NULL, fetched_at TEXT NOT NULL)")
    return conn


def stored_evidence(query: str) -> dict | None:
    try:
        with closing(_db()) as db:
            row = db.execute("SELECT evidence_json FROM cannibal_evidence WHERE query_key = ?", (query.strip().lower(),)).fetchone()
    except Exception:  # noqa: BLE001 - validation must still work if the evidence table cannot be read
        return None
    return json.loads(row[0]) if row else None


def store_evidence(query: str, evidence: dict) -> None:
    with closing(_db()) as db, db:
        db.execute(
            "INSERT INTO cannibal_evidence VALUES (?, ?, ?) ON CONFLICT(query_key) DO UPDATE SET evidence_json = excluded.evidence_json, fetched_at = excluded.fetched_at",
            (query.strip().lower(), json.dumps(evidence), evidence["fetched_at"]),
        )


def clear_evidence() -> None:
    """Called when a new sync replaces the rows: evidence gathered for the old rows no longer describes them."""
    with closing(_db()) as db, db:
        db.execute("DELETE FROM cannibal_evidence")


_CANON_RE = re.compile(r"<link\b[^>]*\brel=[\"']?canonical[\"']?[^>]*>", re.I)
_HREF_RE = re.compile(r"\bhref=[\"']([^\"']+)[\"']", re.I)


def declared_canonical(html: str, base_url: str) -> str | None:
    from urllib.parse import urljoin

    m = _CANON_RE.search(html)
    h = _HREF_RE.search(m.group(0)) if m else None
    return urljoin(base_url, h.group(1).strip()) if h else None


def gather_deep_evidence(site_url: str, query: str, urls: list[str], start: datetime.date, end: datetime.date) -> dict:
    """Network: declared canonicals (page fetch), Google's chosen canonical (URL Inspection API) and per-day per-country rows for the query.
    Each source fails on its own and the failure is recorded, so a partial result is never mistaken for a complete one."""
    import gsc_connector_router as gsc
    from crawler_simulator_router import BROWSER_UA, fetch_as

    errors: list[str] = []
    canon: dict[str, dict] = {}
    for url in urls[:MAX_DEEP_URLS]:
        entry: dict = {"declared": None, "google": None}
        page = fetch_as(url, BROWSER_UA)
        if page["error"] or (page["status"] or 0) >= 400:
            errors.append(f"Could not fetch {url} ({page['error'] or 'HTTP ' + str(page['status'])}) to read its canonical tag.")
        else:
            entry["declared"] = declared_canonical(page["text"], url)
        try:
            res = gsc._gpost("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", "URL inspection", {"inspectionUrl": url, "siteUrl": site_url})
            idx = (res.get("inspectionResult") or {}).get("indexStatusResult") or {}
            entry["google"] = idx.get("googleCanonical") or None
            entry["declared"] = entry["declared"] or idx.get("userCanonical") or None
        except Exception as e:  # noqa: BLE001 - HTTPException from the connector or a network error
            errors.append(f"Google's canonical for {url} could not be read: {getattr(e, 'detail', e)}")
        canon[url] = entry

    daily: list[dict] = []
    try:
        body = {
            "startDate": start.isoformat(), "endDate": end.isoformat(), "dimensions": ["date", "page", "country"], "rowLimit": 25000, "dataState": "final",
            "dimensionFilterGroups": [{"filters": [{"dimension": "query", "operator": "equals", "expression": query}]}],
        }
        from urllib.parse import quote

        data = gsc._gpost(f"https://www.googleapis.com/webmasters/v3/sites/{quote(site_url, safe='')}/searchAnalytics/query", "per-day, per-country data", body)
        wanted = {norm_url(u) for u in urls}
        for r in data.get("rows", []):
            k = r.get("keys", [])
            if len(k) == 3 and norm_url(str(k[1])) in wanted:
                daily.append({"date": str(k[0]), "url": str(k[1]), "country": str(k[2]), "impressions": int(r.get("impressions", 0)), "position": float(r.get("position", 0.0))})
    except Exception as e:  # noqa: BLE001
        errors.append(f"Per-day, per-country data could not be fetched: {getattr(e, 'detail', e)}")
    return {"canonicals": canon, "daily": daily, "errors": errors, "fetched_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"), "window": f"{start} to {end}"}


# ---------------------------------------------------------------------------
# Endpoint: fetch the missing evidence for one query on demand
# ---------------------------------------------------------------------------
import asyncio  # noqa: E402

from fastapi import APIRouter, HTTPException  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

router = APIRouter(prefix="/cannibalization", tags=["Cannibalization validation"])  # app.py mounts it under /api/v1
COMPETING_MIN = 10  # same line as app.MIN_IMPRESSIONS: a URL counts as competing above this


class DeepCheckIn(BaseModel):
    query: str = Field(min_length=1, max_length=300)


@router.post("/deep-check")
async def deep_check(data: DeepCheckIn):
    """Fetch what the stored rows lack for one flagged query (declared and Google-chosen canonicals, per-day per-country data),
    store it until the next sync, and re-run the six checks with it. Uses the URL Inspection API (2,000 calls a day per property)."""
    import gsc_connector_router as gsc

    sync = gsc._status().get("last_sync")
    if not sync:
        raise HTTPException(status_code=404, detail="No synced Search Console data yet. Run a sync first.")
    key = data.query.strip().lower()
    merged: dict[str, list[float]] = {}
    for q, page, _c, imps, _ctr, pos in gsc.load_rows("current"):
        if q.strip().lower() == key:
            a = merged.setdefault(page, [0, 0.0])
            a[0] += imps
            a[1] += pos * imps
    urls = [{"url": u, "impressions": int(a[0]), "position": round(a[1] / a[0], 2) if a[0] else 0.0} for u, a in merged.items() if a[0] > COMPETING_MIN]
    if len(urls) < 2:
        raise HTTPException(status_code=422, detail="That query does not have two competing URLs in the synced data, so there is nothing to check.")
    urls.sort(key=lambda u: (u["position"], -u["impressions"]))
    gsc._require_scope(gsc.SCOPE_GSC, "Search Console")
    evidence = await asyncio.to_thread(gather_deep_evidence, sync["site_url"], data.query.strip(), [u["url"] for u in urls], datetime.date.fromisoformat(sync["start_date"]), datetime.date.fromisoformat(sync["end_date"]))
    store_evidence(data.query, evidence)
    prev: dict[str, list[float]] = {}
    for q, page, _c, imps, _ctr, pos in gsc.load_rows("previous"):
        if q.strip().lower() == key:
            a = prev.setdefault(page, [0, 0.0])
            a[0] += imps
            a[1] += pos * imps
    ev = {**evidence, "previous": {u: (a[0], (a[1] / a[0]) if a[0] else 0.0) for u, a in prev.items()}}
    return {
        "query": data.query.strip(),
        "validation": validate_query(data.query.strip(), urls, ev),
        "evidence": {"errors": evidence["errors"], "fetched_at": evidence["fetched_at"], "window": evidence["window"], "days": len({d["date"] for d in evidence["daily"]}), "urls_checked": len(evidence["canonicals"])},
    }

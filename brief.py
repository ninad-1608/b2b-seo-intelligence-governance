"""Generate a 3-section SEO content brief for a B2B keyword with Claude.

Setup:  pip install anthropic
        set ANTHROPIC_API_KEY=...   (PowerShell: $env:ANTHROPIC_API_KEY="...")
"""
import os

import anthropic

DEFAULT_MODEL = "claude-sonnet-5-5"

PROMPT_TEMPLATE = """\
You are a senior B2B SEO content strategist. Write a content brief for the \
target keyword below.

<keyword>{keyword}</keyword>

<search_performance>
Historical impressions: {impressions:,}
Historical clicks: {clicks:,}
Click-through rate: {ctr:.2%}
</search_performance>

Use the performance data to judge how well the current content satisfies the \
searcher (a low CTR on high impressions suggests a weak title/intent match). \
Do not invent other statistics.

Return only a Markdown document with exactly these three sections, in this \
order, using these headings:

# Content Brief: {keyword}

## 1. Target Audience
Who is searching this (roles, seniority, company type) and what situation \
prompts the search.

## 2. Core Intent
The primary search intent, the job the reader wants done, and what they must \
be able to decide or do after reading. Note what the CTR suggests, if anything.

## 3. Outline
A proposed page structure as a list of H2 headings (write each as `### H2: ...`), \
each followed by 1-2 bullets on what it must cover.
"""


class BriefGenerationError(Exception):
    """Raised when a brief cannot be generated."""


def generate_content_brief(
    keyword: str,
    impressions: int,
    clicks: int,
    *,
    model: str = DEFAULT_MODEL,
    max_tokens: int = 1500,
) -> str:
    """Return a Markdown content brief for `keyword`.

    Raises ValueError for invalid inputs and BriefGenerationError for a missing
    API key or any failure talking to the API.
    """
    keyword = (keyword or "").strip()
    if not keyword:
        raise ValueError("keyword must be a non-empty string")
    if impressions < 0 or clicks < 0:
        raise ValueError("impressions and clicks must be non-negative")
    if clicks > impressions:
        raise ValueError("clicks cannot exceed impressions")

    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        raise BriefGenerationError(
            "ANTHROPIC_API_KEY is not set. Export it before calling generate_content_brief."
        )

    prompt = PROMPT_TEMPLATE.format(
        keyword=keyword,
        impressions=impressions,
        clicks=clicks,
        ctr=clicks / impressions if impressions else 0.0,
    )

    client = anthropic.Anthropic(api_key=api_key)
    try:
        response = client.messages.create(
            model=model,
            max_tokens=max_tokens,
            messages=[{"role": "user", "content": prompt}],
        )
    except anthropic.AuthenticationError as e:
        raise BriefGenerationError("The Anthropic API key was rejected; check ANTHROPIC_API_KEY.") from e
    except anthropic.RateLimitError as e:
        raise BriefGenerationError("Rate limited by the Anthropic API; retry shortly.") from e
    except anthropic.APIConnectionError as e:
        raise BriefGenerationError("Could not reach the Anthropic API; check your network.") from e
    except anthropic.APIStatusError as e:
        raise BriefGenerationError(f"Anthropic API error {e.status_code}: {e.message}") from e

    brief = "".join(b.text for b in response.content if b.type == "text").strip()
    if not brief:
        raise BriefGenerationError("The model returned an empty response.")
    return brief


if __name__ == "__main__":
    print(generate_content_brief("B2B SaaS Demand Generation", impressions=12400, clicks=186))

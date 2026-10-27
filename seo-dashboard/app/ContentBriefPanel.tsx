"use client";

import { useEffect, useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8010";

export type Intent = "Informational" | "Commercial" | "Transactional";

type Section = {
  h2: string;
  talking_points: string[];
  h3: { heading: string; talking_points: string[] }[];
};

type Brief = {
  target_keyword: string;
  search_intent: Intent;
  target_audience: string;
  audience_profile: { summary: string; knowledge_level: string; pain_points: string[] };
  title: string;
  title_length: number;
  h1: string;
  meta_description: string;
  meta_description_length: number;
  outline: Section[];
  semantic_entities: string[];
  keywords_to_include: string[];
  schema_type: string;
  schema_rationale: string;
  internal_links: { url: string; anchor_text: string; reason: string }[];
};

const intentStyles: Record<Intent, string> = {
  Informational: "bg-sky-50 text-sky-700 ring-sky-600/20",
  Commercial: "bg-violet-50 text-violet-700 ring-violet-600/20",
  Transactional: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
};

async function errorMessage(res: Response): Promise<string> {
  const data = await res.json().catch(() => ({}));
  const detail = Array.isArray(data.detail) ? data.detail[0]?.msg : data.detail;
  return typeof detail === "string" ? detail.replace(/^Value error, /, "") : `Request failed (${res.status})`;
}

function toMarkdown(b: Brief): string {
  const bullets = (items: string[], indent = "") => items.map((t) => `${indent}- ${t}`).join("\n");
  const lines: string[] = [
    `# Content Brief: ${b.target_keyword}`,
    "",
    `- **Search intent:** ${b.search_intent}`,
    `- **Audience:** ${b.target_audience}`,
    "",
    "## Audience Profile",
    b.audience_profile.summary,
    "",
    `**Knowledge level:** ${b.audience_profile.knowledge_level}`,
    "",
    "**Pain points**",
    bullets(b.audience_profile.pain_points),
    "",
    "## SEO Metadata",
    `- **Title tag** (${b.title_length} chars): ${b.title}`,
    `- **H1:** ${b.h1}`,
    `- **Meta description** (${b.meta_description_length} chars): ${b.meta_description}`,
    "",
    "## Outline",
  ];
  b.outline.forEach((s, i) => {
    lines.push("", `### ${i + 1}. ${s.h2}`, bullets(s.talking_points));
    s.h3.forEach((h) => lines.push("", `#### ${h.heading}`, bullets(h.talking_points)));
  });
  lines.push(
    "",
    "## Semantic Entities to Include",
    b.semantic_entities.join(", "),
    "",
    "## Keywords to Include",
    b.keywords_to_include.join(", "),
    "",
    "## Recommended Schema",
    `**${b.schema_type}**${b.schema_rationale ? `: ${b.schema_rationale}` : ""}`,
  );
  if (b.internal_links.length > 0) {
    lines.push("", "## Suggested Internal Links", ...b.internal_links.map((l) => `- [${l.anchor_text}](${l.url})${l.reason ? `: ${l.reason}` : ""}`));
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

function Chips({ items, tone }: { items: string[]; tone: string }) {
  return (
    <ul className="flex flex-wrap gap-2">
      {items.map((t) => (
        <li key={t} className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${tone}`}>
          {t}
        </li>
      ))}
    </ul>
  );
}

function Points({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-relaxed text-slate-600">
      {items.map((t) => (
        <li key={t}>{t}</li>
      ))}
    </ul>
  );
}

/** A brief request handed over from another tab (e.g. a Topic Clusters subtopic); generated automatically on mount. */
export type BriefSeed = { keyword: string; audience: string; intent: Intent; opportunityId?: number };

async function requestBrief(body: { keyword: string; target_audience: string; intent: Intent; opportunity_id?: number }, signal?: AbortSignal): Promise<Brief> {
  const res = await fetch(`${API_URL}/api/v1/generate-content-brief`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

const API_DOWN = "Could not reach the analysis API. Is the FastAPI server running?";

export default function ContentBriefPanel({ seed }: { seed?: BriefSeed }) {
  const [keyword, setKeyword] = useState(seed?.keyword ?? "");
  const [audience, setAudience] = useState(seed?.audience ?? "");
  const [intent, setIntent] = useState<Intent>(seed?.intent ?? "Informational");
  const [loading, setLoading] = useState(Boolean(seed));
  const [error, setError] = useState<string | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [openSections, setOpenSections] = useState<Set<number>>(new Set());
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!seed) return;
    const controller = new AbortController();
    (async () => {
      try {
        const data = await requestBrief({ keyword: seed.keyword, target_audience: seed.audience, intent: seed.intent, opportunity_id: seed.opportunityId }, controller.signal);
        setBrief(data);
        setOpenSections(new Set(data.outline.map((_, i) => i)));
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : API_DOWN);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [seed]);

  async function generate(e: React.FormEvent) {
    e.preventDefault();
    if (keyword.trim().length < 2 || audience.trim().length < 2) {
      setError("Enter a target keyword and an audience.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await requestBrief({ keyword: keyword.trim(), target_audience: audience.trim(), intent });
      setBrief(data);
      setOpenSections(new Set(data.outline.map((_, i) => i))); // start expanded
      setCopied(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : API_DOWN);
    } finally {
      setLoading(false);
    }
  }

  function toggleSection(i: number) {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  async function copyMarkdown() {
    if (!brief) return;
    try {
      await navigator.clipboard.writeText(toMarkdown(brief));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  const allOpen = brief ? openSections.size === brief.outline.length : false;

  return (
    <section aria-labelledby="brief-heading" className="space-y-4">
      <form onSubmit={generate} className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div>
          <h2 id="brief-heading" className="text-lg font-semibold text-slate-900">
            AI Content Brief &amp; Outline Generator
          </h2>
          <p className="text-sm text-slate-500">Turn a keyword, audience and search intent into a structured SEO brief your writers can start from.</p>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          <label className="block text-sm font-medium text-slate-700">
            Target Keyword
            <input
              type="text"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              maxLength={150}
              placeholder="e.g. lead scoring model"
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Audience
            <input
              type="text"
              value={audience}
              onChange={(e) => setAudience(e.target.value)}
              maxLength={300}
              placeholder="e.g. B2B marketing directors at SaaS companies"
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Search Intent
            <select
              value={intent}
              onChange={(e) => setIntent(e.target.value as Intent)}
              className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            >
              <option value="Informational">Informational</option>
              <option value="Commercial">Commercial</option>
              <option value="Transactional">Transactional</option>
            </select>
          </label>
        </div>
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={loading}
            className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-60"
          >
            {loading ? "Generating brief…" : "✨ Generate AI Content Brief"}
          </button>
        </div>
        {error && (
          <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-600">
            ⚠️ {error}
          </p>
        )}
      </form>

      {brief && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-indigo-200 bg-indigo-50/50 p-5">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-indigo-700">Content brief</p>
              <h3 className="truncate text-xl font-semibold tracking-tight text-slate-900">{brief.target_keyword}</h3>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-600">
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${intentStyles[brief.search_intent]}`}>
                  {brief.search_intent}
                </span>
                <span className="truncate">{brief.target_audience}</span>
              </div>
            </div>
            <button
              type="button"
              onClick={copyMarkdown}
              className="shrink-0 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2"
            >
              {copied ? "Copied ✓" : "Copy Brief as Markdown"}
            </button>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <h3 className="font-semibold text-slate-900">SEO metadata</h3>
              <dl className="mt-3 space-y-3 text-sm">
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
                    Title tag{" "}
                    <span className={brief.title_length > 60 ? "text-amber-600" : "text-slate-400"}>({brief.title_length} chars)</span>
                  </dt>
                  <dd className="font-medium text-slate-900">{brief.title}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">H1</dt>
                  <dd className="text-lg font-semibold leading-snug text-slate-900">{brief.h1}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
                    Meta description{" "}
                    <span className={brief.meta_description_length > 160 ? "text-amber-600" : "text-slate-400"}>
                      ({brief.meta_description_length} chars)
                    </span>
                  </dt>
                  <dd className="text-slate-700">{brief.meta_description}</dd>
                </div>
              </dl>
            </article>

            <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <h3 className="font-semibold text-slate-900">Audience profile</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-700">{brief.audience_profile.summary}</p>
              {brief.audience_profile.knowledge_level && (
                <p className="mt-2 text-sm text-slate-500">
                  Knowledge level: <span className="font-medium text-slate-700">{brief.audience_profile.knowledge_level}</span>
                </p>
              )}
              {brief.audience_profile.pain_points.length > 0 && (
                <>
                  <p className="mt-3 text-xs font-medium uppercase tracking-wide text-slate-400">Pain points</p>
                  <Points items={brief.audience_profile.pain_points} />
                </>
              )}
            </article>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
              <h3 className="font-semibold text-slate-900">
                Outline <span className="text-sm font-normal text-slate-400">({brief.outline.length} sections)</span>
              </h3>
              <button
                type="button"
                onClick={() => setOpenSections(allOpen ? new Set() : new Set(brief.outline.map((_, i) => i)))}
                className="text-sm font-medium text-indigo-600 hover:text-indigo-800"
              >
                {allOpen ? "Collapse all" : "Expand all"}
              </button>
            </div>
            <ol className="divide-y divide-slate-100">
              {brief.outline.map((s, i) => {
                const open = openSections.has(i);
                return (
                  <li key={`${i}-${s.h2}`}>
                    <h4>
                      <button
                        type="button"
                        onClick={() => toggleSection(i)}
                        aria-expanded={open}
                        className="flex w-full items-start gap-3 px-5 py-3 text-left hover:bg-slate-50 focus:outline-none focus-visible:bg-slate-50"
                      >
                        <span className="mt-0.5 shrink-0 rounded bg-indigo-50 px-1.5 py-0.5 font-mono text-xs font-semibold text-indigo-700">H2</span>
                        <span className="flex-1 font-medium text-slate-900">{s.h2}</span>
                        <span className="shrink-0 text-xs text-slate-400" aria-hidden="true">
                          {open ? "▲" : "▼"}
                        </span>
                      </button>
                    </h4>
                    {open && (
                      <div className="px-5 pb-4 pl-14">
                        <Points items={s.talking_points} />
                        {s.h3.length > 0 && (
                          <ul className="mt-3 space-y-3 border-l-2 border-slate-100 pl-4">
                            {s.h3.map((h) => (
                              <li key={h.heading}>
                                <p className="text-sm font-medium text-slate-800">
                                  <span className="mr-2 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-600">H3</span>
                                  {h.heading}
                                </p>
                                <Points items={h.talking_points} />
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <article className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <div>
                <h3 className="mb-2 font-semibold text-slate-900">Semantic entities to include</h3>
                <Chips items={brief.semantic_entities} tone="bg-indigo-50 text-indigo-700 ring-indigo-600/20" />
              </div>
              <div>
                <h3 className="mb-2 font-semibold text-slate-900">Keywords to include</h3>
                <Chips items={brief.keywords_to_include} tone="bg-slate-100 text-slate-700 ring-slate-500/20" />
              </div>
            </article>

            <article className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <div>
                <h3 className="font-semibold text-slate-900">Recommended schema</h3>
                <p className="mt-1 text-sm text-slate-700">
                  <span className="rounded bg-slate-900 px-2 py-0.5 font-mono text-xs text-white">{brief.schema_type}</span>
                  {brief.schema_rationale && <span className="ml-2 text-slate-500">{brief.schema_rationale}</span>}
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-slate-900">Suggested internal links</h3>
                {brief.internal_links.length === 0 ? (
                  <p className="mt-1 text-sm text-slate-500">No closely related pages found in the site inventory.</p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {brief.internal_links.map((l) => (
                      <li key={l.url} className="text-sm">
                        <p className="font-mono text-xs text-slate-500">{l.url}</p>
                        <p className="font-medium text-indigo-700">“{l.anchor_text}”</p>
                        {l.reason && <p className="text-xs text-slate-500">{l.reason}</p>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </article>
          </div>
        </>
      )}
    </section>
  );
}

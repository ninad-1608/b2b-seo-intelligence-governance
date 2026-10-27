"use client";

import { useState } from "react";
import { ScoreDisclaimer } from "./Guardrails";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8010";

const DECAY_REASONS = [
  "Traffic drop",
  "Outdated statistics",
  "Low AI citation rate",
  "Rankings slipped",
  "Click-through rate fell",
  "Competitors outrank us",
  "Content feels thin",
];

type Action = "KEEP" | "UPDATE" | "EXPAND" | "DELETE";
type Severity = "high" | "medium" | "low";

type Weakness = { title: string; detail: string; severity: Severity; type: string };

type PlanItem = {
  section_title: string;
  action_type: Action;
  reason: string;
  recommended_rewrite: string;
  exists_on_page: boolean;
  current_words: number;
};

type Result = {
  url: string;
  target_keyword: string;
  decay_reason: string;
  page: { title: string; meta_description: string; h1: string; word_count: number; sections: number };
  signals: {
    today: string;
    newest_year_mentioned: number | null;
    years_in_headings_older_than_cutoff: number[];
    has_updated_date: boolean;
    has_published_date: boolean;
    stat_count: number;
    external_citations: number;
    schema_types: string[];
    keyword_in_title: boolean;
    keyword_in_h1: boolean;
    keyword_in_meta_description: boolean;
    keyword_in_intro: boolean;
    thin_sections: string[];
    oversized_sections: string[];
  };
  audit: { summary: string; weaknesses: Weakness[]; outdated_angles: string[]; entity_gaps: string[] };
  meta: { title: string; title_length: number; description: string; description_length: number; current_title: string; current_description: string };
  intro_hook: { rewritten: string; word_count: number; current: string };
  plan: PlanItem[];
  plan_counts: Record<Action, number>;
  entities: string[];
  faqs: { question: string; answer: string }[];
};

async function errorMessage(res: Response): Promise<string> {
  const data = await res.json().catch(() => ({}));
  const detail = Array.isArray(data.detail) ? data.detail[0]?.msg : data.detail;
  return typeof detail === "string" ? detail.replace(/^Value error, /, "") : `Request failed (${res.status})`;
}

const actionStyles: Record<Action, string> = {
  KEEP: "bg-slate-100 text-slate-600 ring-slate-500/20",
  UPDATE: "bg-amber-50 text-amber-700 ring-amber-600/20",
  EXPAND: "bg-indigo-50 text-indigo-700 ring-indigo-600/20",
  DELETE: "bg-rose-50 text-rose-700 ring-rose-600/20",
};

const severityStyles: Record<Severity, { border: string; badge: string }> = {
  high: { border: "border-l-rose-500", badge: "bg-rose-50 text-rose-700 ring-rose-600/20" },
  medium: { border: "border-l-amber-500", badge: "bg-amber-50 text-amber-700 ring-amber-600/20" },
  low: { border: "border-l-slate-400", badge: "bg-slate-100 text-slate-600 ring-slate-500/20" },
};

/** Highlights [placeholders] the model left where a sourced figure must be added by a human. */
function WithPlaceholders({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\[[^\]]+\])/g).map((part, i) =>
        part.startsWith("[") && part.endsWith("]") ? (
          <mark key={i} className="rounded bg-yellow-100 px-0.5 text-slate-800">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className={`flex items-center gap-1.5 text-xs ${ok ? "text-emerald-700" : "text-rose-700"}`}>
      <span aria-hidden="true" className="font-bold">
        {ok ? "✓" : "✗"}
      </span>
      {label}
    </li>
  );
}

function CopyBtn({ id, text, label = "Copy", copied, onCopy }: { id: string; text: string; label?: string; copied: string | null; onCopy: (id: string, text: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onCopy(id, text)}
      className="shrink-0 rounded bg-white px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
    >
      {copied === id ? "Copied ✓" : label}
    </button>
  );
}

function planMarkdown(r: Result): string {
  const lines = [`# Content refresh plan: ${r.target_keyword}`, "", `URL: ${r.url}`, `Reason: ${r.decay_reason}`, ""];
  r.plan
    .filter((p) => p.action_type !== "KEEP")
    .forEach((p) => {
      lines.push(`## ${p.action_type}: ${p.section_title}${p.exists_on_page ? "" : " (new section)"}`, "", `_${p.reason}_`, "");
      if (p.recommended_rewrite) lines.push(p.recommended_rewrite, "");
    });
  return lines.join("\n");
}

export default function ContentRefreshPanel({ initialKeyword = "", initialUrl = "" }: { initialKeyword?: string; initialUrl?: string }) {
  const [url, setUrl] = useState(initialUrl);
  const [keyword, setKeyword] = useState(initialKeyword);
  const [reason, setReason] = useState(DECAY_REASONS[0]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [previewTab, setPreviewTab] = useState<"meta" | "intro">("meta");
  const [filter, setFilter] = useState<Action | "ALL">("ALL");
  const [copied, setCopied] = useState<string | null>(null);

  async function generate(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim() || keyword.trim().length < 2) {
      setError("Enter the page URL and a target keyword.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/v1/generate-content-refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), target_keyword: keyword.trim(), decay_reason: reason }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      setResult(await res.json());
      setFilter("ALL");
      setPreviewTab("meta");
      setCopied(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reach the analysis API. Is the FastAPI server running?");
    } finally {
      setLoading(false);
    }
  }

  async function copy(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
    } catch {
      setCopied(null);
    }
  }

  const cp = { copied, onCopy: copy };

  const s = result?.signals;
  const visiblePlan = result ? result.plan.filter((p) => filter === "ALL" || p.action_type === filter) : [];

  return (
    <section aria-labelledby="refresh-heading" className="space-y-4">
      <ScoreDisclaimer />
      <form onSubmit={generate} className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div>
          <h2 id="refresh-heading" className="text-lg font-semibold text-slate-900">
            Content Refresh Engine
          </h2>
          <p className="text-sm text-slate-500">Audit a decaying page and get a section-by-section rewrite plan, new meta tags and an AI-citable intro.</p>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          <label className="block text-sm font-medium text-slate-700 md:col-span-1">
            Page URL
            <input
              type="text"
              inputMode="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/blog/article"
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Target Keyword
            <input
              type="text"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              maxLength={150}
              placeholder="e.g. lead scoring"
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Decay Reason
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            >
              {DECAY_REASONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex items-center justify-end gap-3">
          {loading && <span className="text-sm text-slate-500">Reading the page and drafting the plan…</span>}
          <button
            type="submit"
            disabled={loading}
            className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-60"
          >
            {loading ? "Generating…" : "🔄 Generate Refresh Plan"}
          </button>
        </div>
        {error && (
          <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-600">
            ⚠️ {error}
          </p>
        )}
      </form>

      {result && s && (
        <>
          {/* audit */}
          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h3 className="font-semibold text-slate-900">Content audit</h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-700">{result.audit.summary}</p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">Measured on the page</p>
                <ul className="grid grid-cols-2 gap-x-4 gap-y-1">
                  <Check ok={s.keyword_in_title} label="Keyword in title" />
                  <Check ok={s.keyword_in_h1} label="Keyword in H1" />
                  <Check ok={s.keyword_in_meta_description} label="Keyword in meta description" />
                  <Check ok={s.keyword_in_intro} label="Keyword in intro" />
                  <Check ok={s.has_updated_date} label="Shows an updated date" />
                  <Check ok={s.years_in_headings_older_than_cutoff.length === 0} label="No stale year in headings" />
                </ul>
              </div>
              <p className="self-end text-xs text-slate-500">
                {result.page.word_count.toLocaleString("en-US")} words · {result.page.sections} sections · {s.stat_count} statistics · {s.external_citations} external citation(s)
                {s.newest_year_mentioned && ` · newest year mentioned: ${s.newest_year_mentioned}`}
                {s.years_in_headings_older_than_cutoff.length > 0 && ` · old year in headings: ${s.years_in_headings_older_than_cutoff.join(", ")}`}
              </p>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            {result.audit.weaknesses.map((w) => (
              <article key={w.title} className={`rounded-lg border border-slate-200 border-l-4 bg-white p-4 shadow-sm ${severityStyles[w.severity].border}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="font-medium text-slate-900">{w.title}</h4>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${severityStyles[w.severity].badge}`}>{w.severity}</span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">{w.type.replace("_", " ")}</span>
                </div>
                <p className="mt-1 text-sm leading-relaxed text-slate-600">{w.detail}</p>
              </article>
            ))}
          </div>

          {(result.audit.outdated_angles.length > 0 || result.audit.entity_gaps.length > 0) && (
            <div className="grid gap-3 md:grid-cols-2">
              {result.audit.outdated_angles.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-4">
                  <p className="text-sm font-semibold text-amber-900">Outdated angles</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-amber-900">
                    {result.audit.outdated_angles.map((a) => (
                      <li key={a}>{a}</li>
                    ))}
                  </ul>
                </div>
              )}
              {result.audit.entity_gaps.length > 0 && (
                <div className="rounded-lg border border-indigo-200 bg-indigo-50/50 p-4">
                  <p className="text-sm font-semibold text-indigo-900">Missing entities</p>
                  <ul className="mt-2 flex flex-wrap gap-1.5">
                    {result.audit.entity_gaps.map((g) => (
                      <li key={g} className="rounded-full bg-white px-2 py-0.5 text-xs text-indigo-700 ring-1 ring-inset ring-indigo-200">
                        {g}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* meta + intro preview */}
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            <div role="tablist" className="flex border-b border-slate-200 bg-slate-50">
              {(
                [
                  ["meta", "Meta Title & Description"],
                  ["intro", "Intro Hook"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={previewTab === key}
                  onClick={() => setPreviewTab(key)}
                  className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition ${
                    previewTab === key ? "border-indigo-600 bg-white text-indigo-700" : "border-transparent text-slate-500 hover:text-slate-800"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {previewTab === "meta" ? (
              <div className="grid gap-4 p-5 md:grid-cols-2">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Current</p>
                  <p className="mt-2 text-sm font-medium text-slate-800">{result.meta.current_title || <span className="text-rose-600">No title</span>}</p>
                  <p className="text-xs text-slate-400">{result.meta.current_title.length} chars</p>
                  <p className="mt-3 text-sm text-slate-600">{result.meta.current_description || <span className="text-rose-600">No meta description</span>}</p>
                  <p className="text-xs text-slate-400">{result.meta.current_description.length} chars</p>
                </div>
                <div className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Recommended</p>
                  <div className="mt-2 rounded-md bg-white p-3 ring-1 ring-slate-200">
                    <p className="truncate text-xs text-emerald-800">{result.url}</p>
                    <p className="text-base font-medium leading-snug text-blue-700">{result.meta.title}</p>
                    <p className="mt-0.5 text-sm leading-snug text-slate-600">{result.meta.description}</p>
                  </div>
                  <div className="mt-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className={`text-xs ${result.meta.title_length > 60 ? "text-amber-700" : "text-slate-500"}`}>Title: {result.meta.title_length} chars</span>
                      <CopyBtn {...cp} id="meta-title" text={result.meta.title} label="Copy Title" />
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className={`text-xs ${result.meta.description_length > 160 || result.meta.description_length < 100 ? "text-amber-700" : "text-slate-500"}`}>
                        Description: {result.meta.description_length} chars
                      </span>
                      <CopyBtn {...cp} id="meta-desc" text={result.meta.description} label="Copy Description" />
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="grid gap-4 p-5 md:grid-cols-2">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Current intro</p>
                  <p className="mt-2 text-sm leading-relaxed text-slate-600">{result.intro_hook.current || <span className="text-rose-600">No introduction text found</span>}</p>
                </div>
                <div className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Rewritten hook · {result.intro_hook.word_count} words</p>
                    <CopyBtn {...cp} id="intro" text={result.intro_hook.rewritten} label="Copy Intro" />
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-900">
                    <WithPlaceholders text={result.intro_hook.rewritten} />
                  </p>
                  <p className="mt-2 text-xs text-slate-500">The opening sentences are written as a standalone answer so an AI engine can quote them directly.</p>
                </div>
              </div>
            )}
          </div>

          {/* action plan */}
          <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3">
              <h3 className="font-semibold text-slate-900">Section-by-section action plan</h3>
              <CopyBtn {...cp} id="plan" text={planMarkdown(result)} label="Copy plan as Markdown" />
            </div>
            <div className="flex flex-wrap gap-2 border-b border-slate-100 px-5 py-3">
              {(["ALL", "UPDATE", "EXPAND", "DELETE", "KEEP"] as const).map((f) => {
                const n = f === "ALL" ? result.plan.length : result.plan_counts[f];
                return (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFilter(f)}
                    aria-pressed={filter === f}
                    className={`rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset transition ${
                      filter === f ? "bg-slate-900 text-white ring-slate-900" : "bg-white text-slate-600 ring-slate-300 hover:bg-slate-50"
                    }`}
                  >
                    {f === "ALL" ? "All" : f} ({n})
                  </button>
                );
              })}
            </div>
            <ol className="divide-y divide-slate-100">
              {visiblePlan.length === 0 && <li className="p-5 text-sm text-slate-500">No sections in this filter.</li>}
              {visiblePlan.map((p, i) => {
                const id = `sec-${result.plan.indexOf(p)}`;
                return (
                  <li key={`${i}-${p.section_title}`} className="p-5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${actionStyles[p.action_type]}`}>{p.action_type}</span>
                      {!p.exists_on_page && <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-600/20">NEW SECTION</span>}
                      <h4 className="font-medium text-slate-900">{p.section_title}</h4>
                      {p.exists_on_page && <span className="text-xs text-slate-400">{p.current_words} words now</span>}
                    </div>
                    {p.reason && <p className="mt-1 text-sm text-slate-600">{p.reason}</p>}
                    {p.recommended_rewrite && (
                      <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                            {p.action_type === "DELETE" ? "What to do with the content" : "Recommended rewrite"}
                          </span>
                          <CopyBtn {...cp} id={id} text={p.recommended_rewrite} label="Copy Rewrite" />
                        </div>
                        <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-800">
                          <WithPlaceholders text={p.recommended_rewrite} />
                        </p>
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>

          {/* entities + FAQs */}
          <div className="grid gap-4 lg:grid-cols-2">
            <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-semibold text-slate-900">Entities to add</h3>
                <CopyBtn {...cp} id="entities" text={result.entities.join(", ")} label="Copy" />
              </div>
              <ul className="mt-3 flex flex-wrap gap-2">
                {result.entities.map((e) => (
                  <li key={e} className="rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700 ring-1 ring-inset ring-indigo-600/20">
                    {e}
                  </li>
                ))}
              </ul>
            </article>
            <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-semibold text-slate-900">FAQs to append</h3>
                <CopyBtn {...cp} id="faqs" text={result.faqs.map((f) => `**${f.question}**\n${f.answer}`).join("\n\n")} label="Copy all" />
              </div>
              <ul className="mt-3 space-y-3">
                {result.faqs.map((f, i) => (
                  <li key={f.question} className="text-sm">
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-medium text-slate-900">{f.question}</p>
                      <CopyBtn {...cp} id={`faq-${i}`} text={`${f.question}\n${f.answer}`} />
                    </div>
                    <p className="mt-0.5 text-slate-600">
                      <WithPlaceholders text={f.answer} />
                    </p>
                  </li>
                ))}
              </ul>
            </article>
          </div>

          <p className="text-xs text-slate-400">
            The audit and rewrites are AI-generated from the page text and the measured signals above. Fill in every highlighted [placeholder] with a sourced figure and
            fact-check time-sensitive claims before publishing.
          </p>
        </>
      )}
    </section>
  );
}

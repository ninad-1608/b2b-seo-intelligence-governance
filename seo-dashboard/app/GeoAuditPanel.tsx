"use client";

import { useEffect, useState } from "react";
import { ScoreDisclaimer } from "./Guardrails";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8010";

type CheckStatus = "pass" | "partial" | "fail" | "n/a";

type Check = {
  id: string;
  label: string;
  status: CheckStatus;
  points: number;
  max_points: number;
  assessed: boolean;
  detail: string;
};

type Pillar = {
  id: string;
  name: string;
  max_score: number;
  assessable_max: number;
  score: number;
  checks: Check[];
};

type Recommendation = {
  pillar: string;
  check: string;
  priority: "High" | "Medium" | "Low";
  points_available: number;
  action: string;
};

type GeoResult = {
  score: number;
  rating: string;
  mode: "url" | "content";
  source: string;
  word_count: number;
  assessed_points: number;
  coverage_note?: string;
  pillars: Pillar[];
  extracted_stats: { value: string; kind: string; context: string }[];
  stat_total: number;
  warnings: string[];
  recommendations: Recommendation[];
  content_excerpt: string;
};

type Rewrite = {
  answer_box: string;
  word_count: number;
  within_range: boolean;
  metrics_used: string[];
  missing_data: string[];
  ungrounded_numbers: string[];
  target_query: string | null;
};

async function errorMessage(res: Response): Promise<string> {
  const data = await res.json().catch(() => ({}));
  const detail = Array.isArray(data.detail) ? data.detail[0]?.msg : data.detail;
  return typeof detail === "string" ? detail : `Request failed (${res.status})`;
}

function tone(score: number) {
  if (score >= 80) return { stroke: "stroke-emerald-500", badge: "bg-emerald-50 text-emerald-700 ring-emerald-600/20", bar: "bg-emerald-500" };
  if (score >= 50) return { stroke: "stroke-amber-500", badge: "bg-amber-50 text-amber-700 ring-amber-600/20", bar: "bg-amber-500" };
  return { stroke: "stroke-rose-500", badge: "bg-rose-50 text-rose-700 ring-rose-600/20", bar: "bg-rose-500" };
}

function Gauge({ score }: { score: number }) {
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const t = tone(score);
  return (
    <div className="relative h-36 w-36 shrink-0">
      <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90" role="img" aria-label={`GEO readiness score ${score} out of 100`}>
        <circle cx="60" cy="60" r={radius} fill="none" strokeWidth="10" className="stroke-slate-100" />
        <circle
          cx="60"
          cy="60"
          r={radius}
          fill="none"
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - score / 100)}
          className={`${t.stroke} transition-all duration-700`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-4xl font-semibold tracking-tight text-slate-900">{score}</span>
        <span className="text-xs text-slate-400">/ 100</span>
      </div>
    </div>
  );
}

const statusIcon: Record<CheckStatus, { icon: string; cls: string }> = {
  pass: { icon: "✓", cls: "text-emerald-600" },
  partial: { icon: "◐", cls: "text-amber-600" },
  fail: { icon: "✗", cls: "text-rose-600" },
  "n/a": { icon: "–", cls: "text-slate-400" },
};

const priorityStyles: Record<Recommendation["priority"], string> = {
  High: "bg-rose-50 text-rose-700 ring-rose-600/20",
  Medium: "bg-amber-50 text-amber-700 ring-amber-600/20",
  Low: "bg-slate-100 text-slate-600 ring-slate-500/20",
};

function CheckRow({ check }: { check: Check }) {
  const s = statusIcon[check.status];
  return (
    <li className="flex gap-2 text-sm">
      <span className={`mt-0.5 w-4 shrink-0 text-center font-bold ${s.cls}`} aria-hidden="true">
        {s.icon}
      </span>
      <div className="min-w-0">
        <p className={check.status === "n/a" ? "text-slate-400" : "text-slate-800"}>
          {check.label}
          {check.assessed && (
            <span className="ml-1.5 text-xs text-slate-400">
              {check.points}/{check.max_points}
            </span>
          )}
        </p>
        <p className="text-xs text-slate-500">{check.detail}</p>
      </div>
    </li>
  );
}

function PillarCard({ pillar }: { pillar: Pillar }) {
  const passed = pillar.checks.filter((c) => c.status === "pass");
  const missing = pillar.checks.filter((c) => c.status === "partial" || c.status === "fail");
  const skipped = pillar.checks.filter((c) => c.status === "n/a");
  const pct = pillar.assessable_max ? (pillar.score / pillar.assessable_max) * 100 : 0;
  const t = tone(pct);

  return (
    <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <header className="flex items-baseline justify-between gap-3">
        <h3 className="font-semibold text-slate-900">{pillar.name}</h3>
        <span className="shrink-0 text-sm tabular-nums text-slate-600">
          <span className="font-semibold text-slate-900">{pillar.score}</span> / {pillar.assessable_max}
          {pillar.assessable_max < pillar.max_score && (
            <span className="text-xs text-slate-400"> (of {pillar.max_score})</span>
          )}
        </span>
      </header>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
        <div className={`h-full rounded-full ${t.bar}`} style={{ width: `${pct}%` }} />
      </div>

      {passed.length > 0 && (
        <div className="mt-4">
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-emerald-700">Passed</p>
          <ul className="space-y-2">
            {passed.map((c) => (
              <CheckRow key={c.id} check={c} />
            ))}
          </ul>
        </div>
      )}
      {missing.length > 0 && (
        <div className="mt-4">
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-rose-700">Missing signals</p>
          <ul className="space-y-2">
            {missing.map((c) => (
              <CheckRow key={c.id} check={c} />
            ))}
          </ul>
        </div>
      )}
      {skipped.length > 0 && (
        <div className="mt-4">
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">Not assessed</p>
          <ul className="space-y-2">
            {skipped.map((c) => (
              <CheckRow key={c.id} check={c} />
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

/** Content handed over from another tab (e.g. the Live Site Inspector); audited automatically on mount. */
export type GeoSeed = { content: string; label: string };

async function requestGeo(body: { url?: string; content?: string; target_queries: string[] }, signal?: AbortSignal): Promise<GeoResult> {
  const res = await fetch(`${API_URL}/api/v1/analyze-geo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

const API_DOWN = "Could not reach the analysis API. Is the FastAPI server running?";

export default function GeoAuditPanel({ seed, initialQueries = "" }: { seed?: GeoSeed; initialQueries?: string }) {
  const [url, setUrl] = useState("");
  const [content, setContent] = useState(seed?.content ?? "");
  const [queries, setQueries] = useState(initialQueries);
  const [loading, setLoading] = useState(Boolean(seed));
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GeoResult | null>(null);

  useEffect(() => {
    if (!seed) return;
    const controller = new AbortController();
    (async () => {
      try {
        const data = await requestGeo({ content: seed.content, target_queries: [] }, controller.signal);
        setResult(data);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : API_DOWN);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [seed]);

  const [rewriting, setRewriting] = useState(false);
  const [rewriteError, setRewriteError] = useState<string | null>(null);
  const [rewrite, setRewrite] = useState<Rewrite | null>(null);
  const [copied, setCopied] = useState(false);

  const targetQueries = queries
    .split(/[\n,]/)
    .map((q) => q.trim())
    .filter(Boolean);

  async function analyze(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim() && !content.trim()) {
      setError("Enter a URL or paste the article content.");
      return;
    }
    setLoading(true);
    setError(null);
    setRewrite(null);
    setRewriteError(null);
    try {
      setResult(
        await requestGeo({
          url: url.trim() || undefined,
          content: content.trim() || undefined,
          target_queries: targetQueries,
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : API_DOWN);
    } finally {
      setLoading(false);
    }
  }

  async function generateRewrite() {
    if (!result) return;
    setRewriting(true);
    setRewriteError(null);
    try {
      const res = await fetch(`${API_URL}/api/v1/generate-geo-rewrite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: result.content_excerpt, target_queries: targetQueries }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      setRewrite(await res.json());
      setCopied(false);
    } catch (err) {
      setRewriteError(err instanceof Error ? err.message : "Could not generate the answer box.");
    } finally {
      setRewriting(false);
    }
  }

  async function copyAnswer() {
    if (!rewrite) return;
    try {
      await navigator.clipboard.writeText(rewrite.answer_box);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  const t = result ? tone(result.score) : null;

  return (
    <section aria-labelledby="geo-heading" className="space-y-4">
      <ScoreDisclaimer />
      <form onSubmit={analyze} className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div>
          <h2 id="geo-heading" className="text-lg font-semibold text-slate-900">
            GEO &amp; LLM Citation Audit
          </h2>
          <p className="text-sm text-slate-500">
            Score how easily ChatGPT, Perplexity and Gemini can extract and cite a page. Enter a URL, or paste the article text. If both
            are given, the URL is used.
          </p>
          {seed && (
            <p className="mt-2 rounded-md bg-indigo-50 p-2.5 text-xs text-indigo-700">
              Content extracted from {seed.label} was loaded and audited. Pasted content can&apos;t show crawler or schema signals; enter the
              URL above for the full 100-point audit.
            </p>
          )}
        </div>

        <label className="block text-sm font-medium text-slate-700">
          Page URL
          <input
            type="text"
            inputMode="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/blog/your-article"
            className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
          />
        </label>

        <label className="block text-sm font-medium text-slate-700">
          …or paste article content (Markdown, plain text or HTML)
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={6}
            placeholder="# Your article title&#10;&#10;Paste the full article here…"
            className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
          />
        </label>

        <label className="block text-sm font-medium text-slate-700">
          Target queries (comma or line separated)
          <input
            type="text"
            value={queries}
            onChange={(e) => setQueries(e.target.value)}
            placeholder="what is lead scoring, lead scoring models"
            className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
          />
        </label>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={loading}
            className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-60"
          >
            {loading ? "Auditing…" : "Run GEO Audit"}
          </button>
        </div>

        {error && (
          <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-600">
            ⚠️ {error}
          </p>
        )}
      </form>

      {result && t && (
        <>
          <div className="flex flex-col items-center gap-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm sm:flex-row">
            <Gauge score={result.score} />
            <div className="min-w-0 flex-1 space-y-2 text-center sm:text-left">
              <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
                <h3 className="text-base font-semibold text-slate-900">GEO Readiness Score</h3>
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${t.badge}`}>{result.rating}</span>
              </div>
              <p className="truncate text-sm text-slate-500" title={result.source}>
                {result.mode === "url" ? "Audited URL" : "Audited"}: {result.source} · {result.word_count.toLocaleString("en-US")} words
              </p>
              {result.coverage_note && (
                <p className="rounded-md bg-slate-50 p-2.5 text-xs text-slate-600">ℹ️ {result.coverage_note}</p>
              )}
              <p className="text-xs text-slate-400">Green 80+ highly extractable · Yellow 50–79 moderate · Red under 50 poor</p>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {result.pillars.map((p) => (
              <PillarCard key={p.id} pillar={p} />
            ))}
          </div>

          <div className="rounded-xl border border-indigo-200 bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-semibold text-slate-900">LLM-Quotable Answer Box</h3>
                <p className="text-sm text-slate-500">
                  A 40–60 word, self-contained answer built only from facts in your content
                  {targetQueries[0] ? ` for “${targetQueries[0]}”` : ""}.
                </p>
              </div>
              <button
                type="button"
                onClick={generateRewrite}
                disabled={rewriting}
                className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-60"
              >
                {rewriting ? "Generating…" : rewrite ? "✨ Regenerate" : "✨ Generate LLM-Quotable Answer Box"}
              </button>
            </div>

            {rewriteError && (
              <p role="alert" className="mt-3 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
                {rewriteError}
              </p>
            )}

            {rewrite && (
              <div className="mt-4 space-y-3">
                <div className="rounded-lg border border-indigo-100 bg-indigo-50/50 p-4">
                  <p className="text-sm leading-relaxed text-slate-900">{rewrite.answer_box}</p>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${
                        rewrite.within_range
                          ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20"
                          : "bg-amber-50 text-amber-700 ring-amber-600/20"
                      }`}
                    >
                      {rewrite.word_count} words{rewrite.within_range ? "" : " (outside 40–60)"}
                    </span>
                    <button
                      type="button"
                      onClick={copyAnswer}
                      className="rounded bg-white px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
                    >
                      {copied ? "Copied ✓" : "Copy Answer"}
                    </button>
                  </div>
                </div>

                {rewrite.ungrounded_numbers.length > 0 && (
                  <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                    ⚠️ These numbers were not found in your content, so verify or remove them before publishing:{" "}
                    <span className="font-mono">{rewrite.ungrounded_numbers.join(", ")}</span>
                  </p>
                )}
                {rewrite.missing_data.length > 0 && (
                  <div>
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Data that would strengthen it</p>
                    <ul className="list-disc space-y-0.5 pl-5 text-sm text-slate-600">
                      {rewrite.missing_data.map((m) => (
                        <li key={m}>{m}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>

          {result.recommendations.length > 0 && (
            <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
              <h3 className="font-semibold text-slate-900">Recommendations</h3>
              <ol className="mt-3 space-y-3">
                {result.recommendations.map((r) => (
                  <li key={`${r.pillar}-${r.check}`} className="flex gap-3 text-sm">
                    <span
                      className={`mt-0.5 h-fit shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${priorityStyles[r.priority]}`}
                    >
                      {r.priority}
                    </span>
                    <div>
                      <p className="text-slate-800">{r.action}</p>
                      <p className="text-xs text-slate-400">
                        {r.pillar} · up to +{r.points_available} pts
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {result.warnings.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-5">
              <h3 className="text-sm font-semibold text-amber-900">Structural warnings</h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-800">
                {result.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <h3 className="font-semibold text-slate-900">
              Extracted statistics{" "}
              <span className="text-sm font-normal text-slate-400">
                ({result.stat_total} found{result.stat_total > result.extracted_stats.length ? `, showing ${result.extracted_stats.length}` : ""})
              </span>
            </h3>
            {result.extracted_stats.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500">No quotable statistics detected. AI engines favor pages with concrete numbers.</p>
            ) : (
              <ul className="mt-3 flex flex-wrap gap-2">
                {result.extracted_stats.map((s, i) => (
                  <li
                    key={`${s.value}-${i}`}
                    title={s.context}
                    className="rounded-full bg-slate-100 px-2.5 py-1 font-mono text-xs text-slate-700"
                  >
                    {s.value}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}

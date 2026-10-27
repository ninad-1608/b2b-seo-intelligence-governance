"use client";

import { useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8010";

type Rating = "good" | "needs-improvement" | "poor" | null;

type Metric = { value: number | null; unit: string; display: string | null; rating: Rating };

type PsiOk = {
  strategy: "mobile" | "desktop";
  performance_score: number;
  seo_score: number | null;
  metrics: { lcp: Metric; cls: Metric; tbt: Metric; fcp: Metric };
  field_data: { overall: string | null; lcp_ms: number | null; cls: number | null } | null;
};
type PsiResult = PsiOk | { error: string };

type SchemaBlock = {
  index: number;
  status: "valid" | "warnings" | "invalid";
  types: string[];
  errors: string[];
  warnings: string[];
  raw: string;
  raw_truncated: boolean;
};

type Audit = {
  url: string;
  page: {
    title: string;
    title_length: number;
    meta_description: string;
    meta_description_length: number;
    canonical: string;
    lang: string;
    robots_meta: string;
    word_count: number;
    h1_count: number;
    headings: { level: number; text: string }[];
    body_text: string;
    body_truncated: boolean;
    content_markdown: string;
    html_truncated: boolean;
    issues: { severity: "high" | "medium" | "low"; message: string }[];
  };
  schema: {
    count: number;
    valid: number;
    with_warnings: number;
    invalid: number;
    types: string[];
    has_microdata: boolean;
    blocks: SchemaBlock[];
  };
  pagespeed: { mobile: PsiResult; desktop: PsiResult; api_key_configured: boolean };
};

type TabKey = "performance" | "content" | "schema";

async function errorMessage(res: Response): Promise<string> {
  const data = await res.json().catch(() => ({}));
  const detail = Array.isArray(data.detail) ? data.detail[0]?.msg : data.detail;
  return typeof detail === "string" ? detail.replace(/^Value error, /, "") : `Request failed (${res.status})`;
}

const ratingStyles: Record<string, string> = {
  good: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  "needs-improvement": "bg-amber-50 text-amber-700 ring-amber-600/20",
  poor: "bg-rose-50 text-rose-700 ring-rose-600/20",
};

const ratingLabel: Record<string, string> = { good: "Good", "needs-improvement": "Needs work", poor: "Poor" };

function scoreTone(score: number) {
  if (score >= 90) return { stroke: "stroke-emerald-500", text: "text-emerald-600" };
  if (score >= 50) return { stroke: "stroke-amber-500", text: "text-amber-600" };
  return { stroke: "stroke-rose-500", text: "text-rose-600" };
}

function ScoreRing({ score, label }: { score: number; label: string }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const t = scoreTone(score);
  return (
    <div className="relative h-24 w-24 shrink-0">
      <svg viewBox="0 0 80 80" className="h-full w-full -rotate-90" role="img" aria-label={`${label} ${score} out of 100`}>
        <circle cx="40" cy="40" r={r} fill="none" strokeWidth="7" className="stroke-slate-100" />
        <circle
          cx="40"
          cy="40"
          r={r}
          fill="none"
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - score / 100)}
          className={t.stroke}
        />
      </svg>
      <span className={`absolute inset-0 flex items-center justify-center text-2xl font-semibold ${t.text}`}>{score}</span>
    </div>
  );
}

function MetricTile({ label, metric }: { label: string; metric: Metric }) {
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-slate-900">{metric.display ?? "—"}</p>
      {metric.rating && (
        <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${ratingStyles[metric.rating]}`}>
          {ratingLabel[metric.rating]}
        </span>
      )}
    </div>
  );
}

function PsiCard({ title, result }: { title: string; result: PsiResult }) {
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h3 className="font-semibold text-slate-900">{title}</h3>
      {"error" in result ? (
        <p role="alert" className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          {result.error}
        </p>
      ) : (
        <>
          <div className="mt-3 flex items-center gap-4">
            <ScoreRing score={result.performance_score} label={`${title} performance`} />
            <div className="text-sm">
              <p className="font-medium text-slate-800">Lighthouse Performance</p>
              {result.seo_score !== null && <p className="text-slate-500">SEO score: {result.seo_score}</p>}
            </div>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <MetricTile label="LCP (Largest Contentful Paint)" metric={result.metrics.lcp} />
            <MetricTile label="CLS (Layout Shift)" metric={result.metrics.cls} />
            <MetricTile label="TBT (Total Blocking Time)" metric={result.metrics.tbt} />
            <MetricTile label="FCP (First Contentful Paint)" metric={result.metrics.fcp} />
          </div>
          {result.field_data && (
            <p className="mt-3 text-xs text-slate-500">
              Real-user data (CrUX, 75th percentile): {result.field_data.overall ?? "n/a"}
              {result.field_data.lcp_ms !== null && ` · LCP ${(result.field_data.lcp_ms / 1000).toFixed(1)} s`}
              {result.field_data.cls !== null && ` · CLS ${result.field_data.cls.toFixed(2)}`}
            </p>
          )}
        </>
      )}
    </article>
  );
}

const severityStyles = {
  high: "bg-rose-50 text-rose-700 ring-rose-600/20",
  medium: "bg-amber-50 text-amber-700 ring-amber-600/20",
  low: "bg-slate-100 text-slate-600 ring-slate-500/20",
};

const schemaStatus = {
  valid: { label: "Valid", cls: "bg-emerald-50 text-emerald-700 ring-emerald-600/20" },
  warnings: { label: "Warnings", cls: "bg-amber-50 text-amber-700 ring-amber-600/20" },
  invalid: { label: "Invalid", cls: "bg-rose-50 text-rose-700 ring-rose-600/20" },
};

export default function LiveSiteInspector({ onRunGeo }: { onRunGeo: (content: string, label: string) => void }) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audit, setAudit] = useState<Audit | null>(null);
  const [tab, setTab] = useState<TabKey>("performance");

  async function inspect(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) {
      setError("Enter a live URL to inspect.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/v1/audit/live-page`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      setAudit(await res.json());
      setTab("performance");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reach the analysis API. Is the FastAPI server running?");
    } finally {
      setLoading(false);
    }
  }

  const tabs: { key: TabKey; label: string }[] = [
    { key: "performance", label: "Performance & Core Web Vitals" },
    { key: "content", label: "Extracted Content & Headers" },
    { key: "schema", label: `Detected Schema Markup${audit ? ` (${audit.schema.count})` : ""}` },
  ];

  return (
    <section aria-labelledby="inspector-heading" className="space-y-4">
      <form onSubmit={inspect} className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 id="inspector-heading" className="text-lg font-semibold text-slate-900">
          Live Site Inspector
        </h2>
        <p className="text-sm text-slate-500">Audit any public page, with no Search Console access needed. Core Web Vitals come from Google PageSpeed Insights.</p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <label className="sr-only" htmlFor="inspector-url">
            Enter any live URL
          </label>
          <input
            id="inspector-url"
            type="text"
            inputMode="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Enter any live URL, e.g. https://example.com/article"
            className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
          />
          <button
            type="submit"
            disabled={loading}
            className="shrink-0 rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-60"
          >
            {loading ? "Inspecting…" : "Inspect Page"}
          </button>
        </div>
        {loading && <p className="mt-3 text-sm text-slate-500">Fetching the page and running Lighthouse for mobile and desktop. This can take up to a minute.</p>}
        {error && (
          <p role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-600">
            ⚠️ {error}
          </p>
        )}
      </form>

      {audit && (
        <>
          <div role="tablist" aria-label="Inspector sections" className="flex flex-wrap gap-1 border-b border-slate-200">
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition ${
                  tab === t.key ? "border-indigo-600 text-indigo-700" : "border-transparent text-slate-500 hover:text-slate-800"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === "performance" && (
            <div className="space-y-3">
              <div className="grid gap-4 lg:grid-cols-2">
                <PsiCard title="Mobile" result={audit.pagespeed.mobile} />
                <PsiCard title="Desktop" result={audit.pagespeed.desktop} />
              </div>
              {!audit.pagespeed.api_key_configured && (
                <p className="text-xs text-slate-400">
                  Running without a PageSpeed API key, which has a very small shared quota. Add <span className="font-mono">PAGESPEED_API_KEY</span> to the
                  backend <span className="font-mono">.env</span> for reliable results.
                </p>
              )}
            </div>
          )}

          {tab === "content" && (
            <div className="space-y-4">
              <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Title ({audit.page.title_length} chars)</dt>
                    <dd className="text-slate-900">{audit.page.title || <span className="text-rose-600">Missing</span>}</dd>
                  </div>
                  <div className="sm:col-span-2">
                    <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
                      Meta description ({audit.page.meta_description_length} chars)
                    </dt>
                    <dd className="text-slate-900">{audit.page.meta_description || <span className="text-rose-600">Missing</span>}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Word count</dt>
                    <dd className="text-lg font-semibold tabular-nums text-slate-900">{audit.page.word_count.toLocaleString("en-US")}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Canonical</dt>
                    <dd className="break-all font-mono text-xs text-slate-700">{audit.page.canonical || "—"}</dd>
                  </div>
                </dl>

                {audit.page.issues.length > 0 && (
                  <ul className="mt-4 space-y-1.5 border-t border-slate-100 pt-4">
                    {audit.page.issues.map((i) => (
                      <li key={i.message} className="flex items-start gap-2 text-sm text-slate-700">
                        <span className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${severityStyles[i.severity]}`}>
                          {i.severity}
                        </span>
                        {i.message}
                      </li>
                    ))}
                  </ul>
                )}
                {audit.page.html_truncated && <p className="mt-3 text-xs text-amber-700">The page was larger than 2 MB and was truncated.</p>}
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                <h3 className="font-semibold text-slate-900">
                  Headings <span className="text-sm font-normal text-slate-400">(H1–H3, {audit.page.headings.length})</span>
                </h3>
                {audit.page.headings.length === 0 ? (
                  <p className="mt-2 text-sm text-slate-500">No H1–H3 headings found in the main content.</p>
                ) : (
                  <ul className="mt-3 space-y-1">
                    {audit.page.headings.map((h, i) => (
                      <li key={i} className="flex gap-2 text-sm" style={{ paddingLeft: `${(h.level - 1) * 1.25}rem` }}>
                        <span className="w-6 shrink-0 font-mono text-xs text-indigo-600">H{h.level}</span>
                        <span className="text-slate-800">{h.text}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="rounded-xl border border-indigo-200 bg-white p-5 shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="font-semibold text-slate-900">Body text</h3>
                    <p className="text-sm text-slate-500">Check how extractable this content is for ChatGPT, Perplexity and Gemini.</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onRunGeo(audit.page.content_markdown, audit.url)}
                    disabled={audit.page.word_count < 50}
                    className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-700 disabled:opacity-50"
                  >
                    ✨ Run GEO Audit with this Content
                  </button>
                </div>
                <details className="mt-3">
                  <summary className="cursor-pointer text-sm font-medium text-slate-600 hover:text-slate-900">Preview extracted text</summary>
                  <p className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-xs leading-relaxed text-slate-700">
                    {audit.page.body_text.slice(0, 3000)}
                    {audit.page.body_text.length > 3000 || audit.page.body_truncated ? "…" : ""}
                  </p>
                </details>
              </div>
            </div>
          )}

          {tab === "schema" && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                {audit.schema.count === 0 ? (
                  <p className="text-sm text-slate-600">
                    No JSON-LD schema found on this page.
                    {audit.schema.has_microdata && " Microdata attributes were detected, but they are not validated here."}
                  </p>
                ) : (
                  <>
                    <span className="text-sm font-medium text-slate-800">{audit.schema.count} JSON-LD block(s)</span>
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${schemaStatus.valid.cls}`}>{audit.schema.valid} valid</span>
                    {audit.schema.with_warnings > 0 && (
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${schemaStatus.warnings.cls}`}>
                        {audit.schema.with_warnings} with warnings
                      </span>
                    )}
                    {audit.schema.invalid > 0 && (
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${schemaStatus.invalid.cls}`}>
                        {audit.schema.invalid} invalid
                      </span>
                    )}
                    <span className="text-xs text-slate-400">Types: {audit.schema.types.join(", ") || "none"}</span>
                  </>
                )}
              </div>

              {audit.schema.blocks.map((b) => (
                <article key={b.index} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold text-slate-900">Block {b.index}</h3>
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${schemaStatus[b.status].cls}`}>
                      {schemaStatus[b.status].label}
                    </span>
                    {b.types.map((t) => (
                      <span key={t} className="rounded bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-700">
                        {t}
                      </span>
                    ))}
                  </div>
                  {(b.errors.length > 0 || b.warnings.length > 0) && (
                    <ul className="mt-3 space-y-1 text-sm">
                      {b.errors.map((m) => (
                        <li key={m} className="text-rose-700">
                          ✗ {m}
                        </li>
                      ))}
                      {b.warnings.map((m) => (
                        <li key={m} className="text-amber-700">
                          ⚠ {m}
                        </li>
                      ))}
                    </ul>
                  )}
                  <details className="mt-3">
                    <summary className="cursor-pointer text-sm font-medium text-slate-600 hover:text-slate-900">View JSON-LD</summary>
                    <pre className="mt-2 max-h-80 overflow-auto rounded-md bg-slate-900 p-3 text-xs leading-relaxed text-slate-100">
                      <code className="font-mono">{b.raw}</code>
                    </pre>
                    {b.raw_truncated && <p className="mt-1 text-xs text-slate-400">Truncated for display.</p>}
                  </details>
                </article>
              ))}
              {audit.schema.count > 0 && (
                <p className="text-xs text-slate-400">
                  This is a structural check (valid JSON, schema.org context, key properties), not Google&apos;s Rich Results Test. Use that tool to confirm eligibility for rich results.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

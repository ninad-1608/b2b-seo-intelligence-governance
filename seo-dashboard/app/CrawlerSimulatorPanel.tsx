"use client";

import { useState } from "react";
import { ScoreDisclaimer } from "./Guardrails";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8010";

type Status = "pass" | "warn" | "fail";

type Check = { id: string; label: string; status: Status; detail: string };

type TokenRow = {
  token: string;
  role: string;
  description: string;
  gating: boolean;
  allowed: boolean | null;
  rule: string | null;
  rule_line: number | null;
  group: string | null;
};

type Bot = {
  id: string;
  name: string;
  vendor: string;
  fetched_as: string;
  http_status: number | null;
  status: Status;
  label: string;
  checks: Check[];
  tokens: TokenRow[];
};

type Fix = { id: string; title: string; language: string; code: string };

type Rag = {
  score: number;
  rating: string;
  components: { key: string; label: string; score: number; max: number }[];
  metrics: Record<string, number | string | null>;
  suggestions: string[];
};

type Result = {
  url: string;
  robots: { url: string; state: "found" | "missing" | "unverified"; http_status: number | null; bytes: number };
  page: { http_status: number; words: number; html_truncated: boolean };
  bots: Bot[];
  summary: { passing: number; warnings: number; failing: number };
  rag: Rag;
  fixes: Fix[];
  disclaimer: string;
};

async function errorMessage(res: Response): Promise<string> {
  const data = await res.json().catch(() => ({}));
  const detail = Array.isArray(data.detail) ? data.detail[0]?.msg : data.detail;
  return typeof detail === "string" ? detail.replace(/^Value error, /, "") : `Request failed (${res.status})`;
}

const statusStyles: Record<Status, { card: string; badge: string; icon: string }> = {
  pass: { card: "border-emerald-200", badge: "bg-emerald-600 text-white", icon: "✓" },
  warn: { card: "border-amber-300", badge: "bg-amber-500 text-white", icon: "!" },
  fail: { card: "border-rose-300", badge: "bg-rose-600 text-white", icon: "✗" },
};

const checkIcon: Record<Status, { icon: string; cls: string }> = {
  pass: { icon: "✓", cls: "text-emerald-600" },
  warn: { icon: "!", cls: "text-amber-600" },
  fail: { icon: "✗", cls: "text-rose-600" },
};

function scoreTone(score: number) {
  if (score >= 80) return { stroke: "stroke-emerald-500", bar: "bg-emerald-500", badge: "bg-emerald-50 text-emerald-700 ring-emerald-600/20" };
  if (score >= 50) return { stroke: "stroke-amber-500", bar: "bg-amber-500", badge: "bg-amber-50 text-amber-700 ring-amber-600/20" };
  return { stroke: "stroke-rose-500", bar: "bg-rose-500", badge: "bg-rose-50 text-rose-700 ring-rose-600/20" };
}

function Gauge({ score }: { score: number }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const t = scoreTone(score);
  return (
    <div className="relative h-36 w-36 shrink-0">
      <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90" role="img" aria-label={`RAG chunkability ${score} out of 100`}>
        <circle cx="60" cy="60" r={r} fill="none" strokeWidth="10" className="stroke-slate-100" />
        <circle
          cx="60"
          cy="60"
          r={r}
          fill="none"
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - score / 100)}
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

function tokenChip(t: TokenRow) {
  if (t.allowed === null) return { cls: "bg-slate-100 text-slate-600 ring-slate-500/20", text: "unverified" };
  if (t.allowed) return { cls: "bg-emerald-50 text-emerald-700 ring-emerald-600/20", text: "allowed" };
  return t.gating
    ? { cls: "bg-rose-50 text-rose-700 ring-rose-600/20", text: "blocked" }
    : { cls: "bg-amber-50 text-amber-700 ring-amber-600/20", text: "blocked (training)" };
}

function BotCard({ bot }: { bot: Bot }) {
  const s = statusStyles[bot.status];
  return (
    <article className={`flex flex-col rounded-xl border-2 bg-white p-5 shadow-sm ${s.card}`}>
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-semibold text-slate-900">{bot.name}</h3>
          <p className="text-xs text-slate-500">{bot.vendor}</p>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${s.badge}`}>
          {s.icon} {bot.label}
        </span>
      </header>

      <ul className="mt-3 flex flex-wrap gap-1.5">
        {bot.tokens.map((t) => {
          const chip = tokenChip(t);
          return (
            <li key={t.token} title={`${t.description}${t.rule ? ` · ${t.rule} (${t.group} group, line ${t.rule_line})` : ""}`} className="text-xs">
              <span className="font-mono text-slate-700">{t.token}</span>{" "}
              <span className={`rounded-full px-1.5 py-0.5 font-medium ring-1 ring-inset ${chip.cls}`}>{chip.text}</span>
            </li>
          );
        })}
      </ul>

      <ul className="mt-4 space-y-2.5">
        {bot.checks.map((c) => (
          <li key={c.id} className="flex gap-2 text-sm">
            <span className={`mt-0.5 w-4 shrink-0 text-center font-bold ${checkIcon[c.status].cls}`} aria-hidden="true">
              {checkIcon[c.status].icon}
            </span>
            <div className="min-w-0">
              <p className="font-medium text-slate-800">{c.label}</p>
              <p className="text-xs leading-snug text-slate-500">{c.detail}</p>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-auto pt-3 text-xs text-slate-400">
        Fetched as {bot.fetched_as}: {bot.http_status !== null ? `HTTP ${bot.http_status}` : "no response"}
      </p>
    </article>
  );
}

export default function CrawlerSimulatorPanel({ initialUrl = "" }: { initialUrl?: string }) {
  const [url, setUrl] = useState(initialUrl);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [fixTab, setFixTab] = useState(0);
  const [copied, setCopied] = useState(false);

  async function audit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) {
      setError("Enter a URL to audit.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/v1/simulate-llm-crawler`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      setResult(await res.json());
      setFixTab(0);
      setCopied(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reach the analysis API. Is the FastAPI server running?");
    } finally {
      setLoading(false);
    }
  }

  async function copy(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  const rag = result?.rag;
  const m = rag?.metrics ?? {};
  const t = rag ? scoreTone(rag.score) : null;
  const fix = result?.fixes[fixTab];

  return (
    <section aria-labelledby="crawler-heading" className="space-y-4">
      <ScoreDisclaimer />
      <form onSubmit={audit} className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 id="crawler-heading" className="text-lg font-semibold text-slate-900">
          LLM Crawler Simulator
        </h2>
        <p className="text-sm text-slate-500">Check whether ChatGPT Search, Perplexity, Claude and Gemini-era crawlers can reach, read and cleanly chunk a page.</p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <label className="sr-only" htmlFor="crawler-url">
            Page URL
          </label>
          <input
            id="crawler-url"
            type="text"
            inputMode="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/blog/article"
            className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
          />
          <button
            type="submit"
            disabled={loading}
            className="shrink-0 rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-60"
          >
            {loading ? "Auditing…" : "🤖 Audit LLM Crawlability"}
          </button>
        </div>
        {loading && <p className="mt-3 text-sm text-slate-500">Requesting the page as each crawler and reading robots.txt…</p>}
        {error && (
          <p role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-600">
            ⚠️ {error}
          </p>
        )}
      </form>

      {result && rag && t && (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-600">
            <span>
              <span className="font-semibold text-emerald-700">{result.summary.passing}</span> passing ·{" "}
              <span className="font-semibold text-amber-700">{result.summary.warnings}</span> warnings ·{" "}
              <span className="font-semibold text-rose-700">{result.summary.failing}</span> failing
            </span>
            <span className="text-xs text-slate-400">
              robots.txt:{" "}
              {result.robots.state === "found"
                ? `found (${(result.robots.bytes / 1024).toFixed(1)} KB)`
                : result.robots.state === "missing"
                  ? "not found: nothing is restricted"
                  : "could not be fetched"}
            </span>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {result.bots.map((b) => (
              <BotCard key={b.id} bot={b} />
            ))}
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-6 md:flex-row">
              <div className="flex flex-col items-center gap-2">
                <Gauge score={rag.score} />
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${t.badge}`}>{rag.rating}</span>
              </div>
              <div className="min-w-0 flex-1 space-y-4">
                <div>
                  <h3 className="font-semibold text-slate-900">RAG Chunkability Index</h3>
                  <p className="text-sm text-slate-500">How cleanly the page splits into self-contained passages for vector embedding and retrieval.</p>
                </div>

                <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                  {rag.components.map((c) => (
                    <div key={c.key}>
                      <div className="flex justify-between text-xs text-slate-600">
                        <span>{c.label}</span>
                        <span className="tabular-nums">
                          {c.score} / {c.max}
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
                        <div className={`h-full rounded-full ${scoreTone((c.score / c.max) * 100).bar}`} style={{ width: `${(c.score / c.max) * 100}%` }} />
                      </div>
                    </div>
                  ))}
                </div>

                {rag.components.length > 0 && (
                  <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {[
                      ["Header density", `${m.header_density_per_1k ?? "—"} / 1k words`],
                      ["Avg block length", `${m.avg_block_words ?? "—"} words (~${m.avg_block_tokens ?? "—"} tokens)`],
                      ["Oversize paragraphs", String(m.oversize_paragraphs ?? "—")],
                      ["Lists / tables", `${m.list_items ?? 0} items / ${m.tables ?? 0}`],
                    ].map(([k, v]) => (
                      <div key={k} className="rounded-lg bg-slate-50 p-3">
                        <dt className="text-xs text-slate-500">{k}</dt>
                        <dd className="mt-0.5 text-sm font-semibold text-slate-900">{v}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            </div>

            {rag.suggestions.length > 0 && (
              <div className="mt-5 border-t border-slate-100 pt-4">
                <h4 className="text-sm font-semibold text-slate-900">Structural suggestions</h4>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
                  {rag.suggestions.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 px-5 py-3">
              <h3 className="font-semibold text-slate-900">Fix recommendations</h3>
            </div>
            {result.fixes.length === 0 || !fix ? (
              <p className="p-5 text-sm text-emerald-700">✓ No fixes needed: no crawler was blocked by robots.txt, headers or your firewall.</p>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-1 bg-slate-100 pr-2">
                  <div role="tablist" className="flex flex-wrap">
                    {result.fixes.map((f, i) => (
                      <button
                        key={f.id}
                        type="button"
                        role="tab"
                        aria-selected={fixTab === i}
                        onClick={() => {
                          setFixTab(i);
                          setCopied(false);
                        }}
                        className={`px-3 py-2 text-xs font-medium transition ${fixTab === i ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-200 hover:text-slate-900"}`}
                      >
                        {f.title}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => copy(fix.code)}
                    className="rounded bg-white px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
                  >
                    {copied ? "Copied ✓" : "Copy Snippet"}
                  </button>
                </div>
                <pre className="max-h-80 overflow-auto bg-slate-900 p-4 text-xs leading-relaxed text-slate-100">
                  <code className="font-mono">{fix.code}</code>
                </pre>
              </>
            )}
          </div>

          <p className="text-xs text-slate-400">{result.disclaimer}</p>
        </>
      )}
    </section>
  );
}

"use client";

import { useState } from "react";
import { ScoreDisclaimer, ThirdPartyBadge } from "./Guardrails";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8010";

type Side = "your" | "competitor" | "tie";

type Row = {
  key: string;
  label: string;
  your: number;
  competitor: number;
  leader: Side;
  basis: "measured" | "ai-judged" | "unavailable";
  note: string;
  your_detail: string;
  competitor_detail: string;
};

type PageSummary = {
  url: string;
  title: string;
  geo_score: number;
  geo_rating: string;
  word_count: number;
  schema_detail: string;
  top_entities: string[];
  answer_summary: string;
};

type Fix = { title: string; action: string; why: string };

type Result = {
  query: string;
  winner: { side: Side; url: string | null; title: string | null; your_score: number; competitor_score: number };
  rationale: string;
  rationale_source: "ai" | "rules";
  pages: { your: PageSummary; competitor: PageSummary };
  comparison: Row[];
  recommendations: Fix[];
  disclaimer: string;
};

async function errorMessage(res: Response): Promise<string> {
  const data = await res.json().catch(() => ({}));
  const detail = Array.isArray(data.detail) ? data.detail[0]?.msg : data.detail;
  return typeof detail === "string" ? detail.replace(/^Value error, /, "") : `Request failed (${res.status})`;
}

function barTone(score: number) {
  if (score >= 70) return "bg-emerald-500";
  if (score >= 40) return "bg-amber-500";
  return "bg-rose-500";
}

function ScoreCell({ score, detail, leads }: { score: number; detail: string; leads: boolean }) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className={`w-9 text-lg font-semibold tabular-nums ${leads ? "text-slate-900" : "text-slate-500"}`}>{score}</span>
        <div className="h-2 w-24 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={score} aria-valuemin={0} aria-valuemax={100}>
          <div className={`h-full rounded-full ${barTone(score)}`} style={{ width: `${score}%` }} />
        </div>
      </div>
      {detail && <p className="mt-1 max-w-[16rem] text-xs leading-snug text-slate-500">{detail}</p>}
    </div>
  );
}

const basisStyles = {
  measured: "bg-slate-100 text-slate-600",
  "ai-judged": "bg-indigo-50 text-indigo-700",
  unavailable: "bg-amber-50 text-amber-700",
};

function winnerBanner(r: Result) {
  const { side, your_score, competitor_score } = r.winner;
  const scores = `${your_score} vs ${competitor_score}`;
  if (side === "your") {
    return {
      cls: "border-emerald-300 bg-emerald-50",
      badge: "bg-emerald-600 text-white",
      icon: "🏆",
      label: "Your page wins",
      text: `An AI answer engine would most likely cite your page for “${r.query}” (citation probability ${scores}).`,
    };
  }
  if (side === "competitor") {
    return {
      cls: "border-orange-300 bg-orange-50",
      badge: "bg-orange-600 text-white",
      icon: "⚠️",
      label: "Competitor wins",
      text: `The competitor is more likely to be cited for “${r.query}” (citation probability ${scores}). See the fixes below.`,
    };
  }
  return {
    cls: "border-amber-300 bg-amber-50",
    badge: "bg-amber-600 text-white",
    icon: "⚖️",
    label: "Too close to call",
    text: `Both pages have a similar chance of being cited for “${r.query}” (citation probability ${scores}).`,
  };
}

export default function GeoSimulatorPanel({ initialQuery = "" }: { initialQuery?: string }) {
  const [query, setQuery] = useState(initialQuery);
  const [yourUrl, setYourUrl] = useState("");
  const [competitorUrl, setCompetitorUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [done, setDone] = useState<Set<number>>(new Set());
  const [copied, setCopied] = useState<string | null>(null);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim() || !yourUrl.trim() || !competitorUrl.trim()) {
      setError("Enter a target query and both page URLs.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/v1/simulate-geo-benchmark`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: query.trim(), your_url: yourUrl.trim(), competitor_url: competitorUrl.trim() }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      setResult(await res.json());
      setDone(new Set());
      setCopied(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reach the analysis API. Is the FastAPI server running?");
    } finally {
      setLoading(false);
    }
  }

  function toggleDone(i: number) {
    setDone((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
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

  const fixText = (f: Fix, i: number) => `${i + 1}. ${f.title}\n${f.action}${f.why ? `\nWhy: ${f.why}` : ""}`;
  const banner = result ? winnerBanner(result) : null;

  return (
    <section aria-labelledby="sim-heading" className="space-y-4">
      <ScoreDisclaimer />
      <form onSubmit={run} className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div>
          <h2 id="sim-heading" className="text-lg font-semibold text-slate-900">
            AI Search Engine Simulator
          </h2>
          <p className="text-sm text-slate-500">
            Compare your page with a competitor for a query and see which one an AI answer engine (Perplexity, ChatGPT Search) is more likely to cite.
          </p>
        </div>
        <label className="block text-sm font-medium text-slate-700">
          Target Query
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            maxLength={300}
            placeholder="e.g. what is lead scoring"
            className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
          />
        </label>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block text-sm font-medium text-slate-700">
            Your Page URL
            <input
              type="text"
              inputMode="url"
              value={yourUrl}
              onChange={(e) => setYourUrl(e.target.value)}
              placeholder="https://yoursite.com/blog/lead-scoring"
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Competitor Page URL
            <input
              type="text"
              inputMode="url"
              value={competitorUrl}
              onChange={(e) => setCompetitorUrl(e.target.value)}
              placeholder="https://competitor.com/lead-scoring-guide"
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            />
          </label>
        </div>
        <div className="flex items-center justify-end gap-3">
          {loading && <span className="text-sm text-slate-500">Fetching both pages and judging…</span>}
          <button
            type="submit"
            disabled={loading}
            className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-60"
          >
            {loading ? "Running…" : "⚡ Run GEO Head-to-Head"}
          </button>
        </div>
        {error && (
          <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-600">
            ⚠️ {error}
          </p>
        )}
      </form>

      {result && banner && (
        <>
          <div className={`flex flex-col gap-3 rounded-xl border-2 p-5 sm:flex-row sm:items-center ${banner.cls}`}>
            <span className={`w-fit shrink-0 rounded-full px-3.5 py-1.5 text-sm font-semibold ${banner.badge}`}>
              {banner.icon} {banner.label}
            </span>
            <div className="min-w-0">
              <p className="text-sm text-slate-800">{banner.text}</p>
              {result.winner.url && (
                <p className="mt-0.5 truncate font-mono text-xs text-slate-500" title={result.winner.url}>
                  {result.winner.title} · {result.winner.url}
                </p>
              )}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            {(
              [
                ["Your page", result.pages.your, "border-indigo-200"],
                ["Competitor page", result.pages.competitor, "border-slate-200"],
              ] as const
            ).map(([label, p, border]) => (
              <article key={label} className={`rounded-xl border bg-white p-5 shadow-sm ${border}`}>
                <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  {label}
                  {label === "Competitor page" && <ThirdPartyBadge title="A page you do not own, fetched from the web. Its score is a model estimate, not a measured ranking or citation.">Estimated · Third-party</ThirdPartyBadge>}
                </p>
                <h3 className="mt-0.5 truncate font-semibold text-slate-900" title={p.title}>
                  {p.title}
                </h3>
                <p className="truncate font-mono text-xs text-slate-500" title={p.url}>
                  {p.url}
                </p>
                <p className="mt-2 text-xs text-slate-500">
                  GEO readiness <span className="font-semibold text-slate-700">{p.geo_score}</span> ({p.geo_rating}) · {p.word_count.toLocaleString("en-US")} words
                </p>
                {p.answer_summary && (
                  <p className="mt-2 rounded-md bg-slate-50 p-2.5 text-xs leading-relaxed text-slate-600">
                    <span className="font-semibold text-slate-700">Answer an AI would extract: </span>
                    {p.answer_summary}
                  </p>
                )}
              </article>
            ))}
          </div>

          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-5 py-3">GEO factor</th>
                  <th className="px-5 py-3">Your page</th>
                  <th className="px-5 py-3">Competitor <ThirdPartyBadge>Estimated · Third-party</ThirdPartyBadge></th>
                  <th className="px-5 py-3">Leader</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 align-top">
                {result.comparison.map((r) => (
                  <tr key={r.key}>
                    <td className="px-5 py-4">
                      <p className="font-medium text-slate-900">{r.label}</p>
                      <p className="max-w-[14rem] text-xs text-slate-500">{r.note}</p>
                      <span className={`mt-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${basisStyles[r.basis]}`}>
                        {r.basis === "ai-judged" ? "AI-judged" : r.basis}
                      </span>
                    </td>
                    <td className="px-5 py-4">
                      <ScoreCell score={r.your} detail={r.your_detail} leads={r.leader === "your"} />
                    </td>
                    <td className="px-5 py-4">
                      <ScoreCell score={r.competitor} detail={r.competitor_detail} leads={r.leader === "competitor"} />
                    </td>
                    <td className="px-5 py-4">
                      {r.leader === "tie" ? (
                        <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">Tie</span>
                      ) : (
                        <span
                          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${
                            r.leader === "your" ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20" : "bg-orange-50 text-orange-700 ring-orange-600/20"
                          }`}
                        >
                          {r.leader === "your" ? "You" : "Competitor"}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-slate-900">{result.winner.side === "tie" ? "Why it’s too close to call" : "Why the winner won"}</h3>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
                {result.rationale_source === "ai" ? "AI rationale" : "Measured signals only"}
              </span>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-slate-700">{result.rationale}</p>
          </div>

          <div className="rounded-xl border border-indigo-200 bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold text-slate-900">
                {result.recommendations.length} Actionable Fixes to Outrank{" "}
                <span className="text-sm font-normal text-slate-400">
                  ({done.size}/{result.recommendations.length} done)
                </span>
              </h3>
              <button
                type="button"
                onClick={() => copy("all", result.recommendations.map(fixText).join("\n\n"))}
                className="rounded bg-white px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
              >
                {copied === "all" ? "Copied ✓" : "Copy all fixes"}
              </button>
            </div>
            <ol className="mt-3 space-y-3">
              {result.recommendations.map((f, i) => (
                <li key={`${i}-${f.title}`} className="flex gap-3 rounded-lg border border-slate-200 p-4">
                  <input
                    type="checkbox"
                    checked={done.has(i)}
                    onChange={() => toggleDone(i)}
                    aria-label={`Mark fix ${i + 1} as done`}
                    className="mt-1 h-4 w-4 shrink-0 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                  />
                  <div className="min-w-0 flex-1">
                    <p className={`font-medium ${done.has(i) ? "text-slate-400 line-through" : "text-slate-900"}`}>
                      {i + 1}. {f.title}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{f.action}</p>
                    {f.why && <p className="mt-1 text-xs text-slate-500">Why: {f.why}</p>}
                  </div>
                  <button
                    type="button"
                    onClick={() => copy(`fix-${i}`, fixText(f, i))}
                    className="h-fit shrink-0 rounded bg-white px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
                  >
                    {copied === `fix-${i}` ? "Copied ✓" : "Copy"}
                  </button>
                </li>
              ))}
            </ol>
          </div>

          <p className="text-xs text-slate-400">{result.disclaimer}</p>
        </>
      )}
    </section>
  );
}

"use client";

import { useState } from "react";
import type { BriefSeed, Intent } from "./ContentBriefPanel";
import { ScoreDisclaimer, ThirdPartyBadge } from "./Guardrails";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8010";
const numberFormat = new Intl.NumberFormat("en-US");

type BriefRequest = { keyword: string; target_audience: string; intent: Intent };
type Kw = { keyword: string; volume: number | null };

type Subtopic = {
  id: string;
  title: string;
  primary_keyword: string;
  keywords: Kw[];
  intent: Intent;
  content_type: string;
  total_volume: number | null;
  brief_request: BriefRequest;
};

type Cluster = {
  id: string;
  name: string;
  keyword_count: number;
  pillar: {
    title: string;
    keyword: string;
    in_list: boolean;
    intent: Intent;
    content_type: string;
    volume: number | null;
    brief_request: BriefRequest;
  };
  subtopics: Subtopic[];
};

type Result = {
  seed_topic: string;
  target_audience: string;
  has_volume: boolean;
  summary: {
    keywords_in: number;
    clusters: number;
    subtopics: number;
    unclustered: number;
    duplicates_removed: number;
    dropped_over_limit: number;
    max_keywords: number;
  };
  clusters: Cluster[];
  unclustered: Kw[];
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

/** Keywords one per line; a single line containing commas is treated as a comma-separated list. */
function parseKeywords(text: string): string[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const parts = lines.length === 1 && lines[0].includes(",") ? lines[0].split(",") : lines;
  return parts.map((p) => p.trim()).filter(Boolean);
}

function IntentBadge({ intent }: { intent: Intent }) {
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${intentStyles[intent]}`}>{intent}</span>;
}

function TypeTag({ type }: { type: string }) {
  return <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">{type}</span>;
}

export default function TopicClusterPanel({ onGenerateBrief, initialSeed = "" }: { onGenerateBrief: (seed: BriefSeed) => void; initialSeed?: string }) {
  const [seed, setSeed] = useState(initialSeed);
  const [audience, setAudience] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  function acceptFile(f: File | undefined) {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith(".csv")) {
      setError(`“${f.name}” is not a .csv file.`);
      return;
    }
    setFile(f);
    setError(null);
  }

  async function run(e: React.FormEvent) {
    e.preventDefault();
    const typed = parseKeywords(text);
    if (seed.trim().length < 2) {
      setError("Enter a seed topic.");
      return;
    }
    if (!file && typed.length < 3) {
      setError("Enter at least 3 keywords, or upload a CSV.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      let res: Response;
      if (file) {
        const form = new FormData();
        form.append("file", file);
        form.append("seed_topic", seed.trim());
        if (audience.trim()) form.append("target_audience", audience.trim());
        res = await fetch(`${API_URL}/api/v1/generate-topic-clusters`, { method: "POST", body: form });
      } else {
        res = await fetch(`${API_URL}/api/v1/generate-topic-clusters`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keywords: typed, seed_topic: seed.trim(), target_audience: audience.trim() }),
        });
      }
      if (!res.ok) throw new Error(await errorMessage(res));
      setResult(await res.json());
      setCollapsed(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reach the analysis API. Is the FastAPI server running?");
    } finally {
      setLoading(false);
    }
  }

  function toggle(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function send(req: BriefRequest) {
    onGenerateBrief({ keyword: req.keyword, audience: req.target_audience, intent: req.intent });
  }

  const s = result?.summary;

  return (
    <section aria-labelledby="clusters-heading" className="space-y-4">
      <ScoreDisclaimer />
      <form onSubmit={run} className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div>
          <h2 id="clusters-heading" className="text-lg font-semibold text-slate-900">
            Topic Cluster Mapper
          </h2>
          <p className="text-sm text-slate-500">
            Group a batch of keywords into pillar pages and supporting cluster articles, each with a search intent and content type.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <label className="block text-sm font-medium text-slate-700">
            Seed Topic
            <input
              type="text"
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
              maxLength={150}
              placeholder="e.g. lead scoring"
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Target audience <span className="font-normal text-slate-400">(optional, used for briefs)</span>
            <input
              type="text"
              value={audience}
              onChange={(e) => setAudience(e.target.value)}
              maxLength={300}
              placeholder="e.g. B2B marketing directors at SaaS companies"
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            />
          </label>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <label className="block text-sm font-medium text-slate-700">
            Keywords <span className="font-normal text-slate-400">(one per line, up to {s?.max_keywords ?? 250})</span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={7}
              disabled={Boolean(file)}
              placeholder={"lead scoring model\nwhat is lead scoring\nbest lead scoring software"}
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 disabled:bg-slate-50 disabled:text-slate-400"
            />
          </label>

          <div className="flex flex-col">
            <span className="text-sm font-medium text-slate-700">…or upload a keyword CSV</span>
            <label
              htmlFor="cluster-csv"
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                acceptFile(e.dataTransfer.files[0]);
              }}
              className={`mt-1 flex flex-1 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-4 py-6 text-center transition ${
                dragging ? "border-indigo-500 bg-indigo-50" : file ? "border-emerald-300 bg-emerald-50/50" : "border-slate-300 bg-slate-50 hover:border-slate-400"
              }`}
            >
              <span className="max-w-full truncate text-sm font-medium text-slate-700">{file ? `✓ ${file.name}` : "Drag & drop a .csv here, or click to browse"}</span>
              <span className="text-xs text-slate-500">A “keyword” column; an optional “volume” column ranks the results.</span>
              <input
                id="cluster-csv"
                type="file"
                accept=".csv"
                className="sr-only"
                onChange={(e) => {
                  acceptFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </label>
            {file && (
              <button type="button" onClick={() => setFile(null)} className="mt-1 self-start text-xs font-medium text-slate-500 hover:text-slate-800">
                Remove file and use the text box instead
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-3">
          {loading && <span className="text-sm text-slate-500">Clustering keywords…</span>}
          <button
            type="submit"
            disabled={loading}
            className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-60"
          >
            {loading ? "Mapping…" : "🗺️ Map Topic Clusters"}
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
          <div className="grid gap-4 sm:grid-cols-4">
            {[
              { label: "Keywords mapped", value: s.keywords_in - s.unclustered, accent: "text-slate-900" },
              { label: "Topic clusters", value: s.clusters, accent: "text-indigo-600" },
              { label: "Cluster articles", value: s.subtopics, accent: "text-violet-600" },
              { label: "Unclustered", value: s.unclustered, accent: s.unclustered > 0 ? "text-amber-600" : "text-slate-400" },
            ].map((m) => (
              <div key={m.label} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <p className="text-sm font-medium text-slate-500">{m.label}</p>
                <p className={`mt-1 text-2xl font-semibold tracking-tight ${m.accent}`}>{m.value}</p>
              </div>
            ))}
          </div>
          {(s.duplicates_removed > 0 || s.dropped_over_limit > 0) && (
            <p className="text-xs text-amber-700">
              {s.duplicates_removed > 0 && `${s.duplicates_removed} duplicate keyword(s) removed. `}
              {s.dropped_over_limit > 0 && `${s.dropped_over_limit} keyword(s) over the ${s.max_keywords} limit were skipped${result.has_volume ? " (lowest volume first)" : ""}.`}
            </p>
          )}

          {result.clusters.map((c) => {
            const open = !collapsed.has(c.id);
            return (
              <article key={c.id} className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
                <button
                  type="button"
                  onClick={() => toggle(c.id)}
                  aria-expanded={open}
                  className="flex w-full items-center justify-between gap-3 bg-slate-50 px-5 py-3 text-left hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-semibold text-slate-900">{c.name}</span>
                    <span className="text-xs text-slate-500">
                      {c.keyword_count} keywords · {c.subtopics.length} cluster article{c.subtopics.length === 1 ? "" : "s"}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-slate-400" aria-hidden="true">
                    {open ? "▲" : "▼"}
                  </span>
                </button>

                {open && (
                  <div className="space-y-4 p-5">
                    <div className="rounded-lg border-2 border-indigo-300 bg-indigo-50/50 p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded bg-indigo-600 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-white">Pillar page</span>
                        <IntentBadge intent={c.pillar.intent} />
                        <TypeTag type={c.pillar.content_type} />
                      </div>
                      <h3 className="mt-2 text-base font-semibold text-slate-900">{c.pillar.title}</h3>
                      <p className="text-sm text-slate-600">
                        Core keyword: <span className="font-mono text-xs text-indigo-700">{c.pillar.keyword}</span>
                        {c.pillar.volume !== null && (
                          <span className="text-slate-400">
                            {" "}
                            · vol {numberFormat.format(c.pillar.volume)} <ThirdPartyBadge title="Taken from the volume column of your file. Keyword tools estimate this; it is not Search Console data.">Estimated · from your file</ThirdPartyBadge>
                          </span>
                        )}
                        {!c.pillar.in_list && <span className="ml-1 text-xs text-slate-400">(concept; not in your list)</span>}
                      </p>
                      <button
                        type="button"
                        onClick={() => send(c.pillar.brief_request)}
                        className="mt-3 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-700"
                      >
                        ✨ Generate Brief for this Pillar
                      </button>
                    </div>

                    {c.subtopics.length > 0 && (
                      <div className="ml-3 border-l-2 border-indigo-200 pl-4">
                        <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">Supporting cluster articles</p>
                        <div className="grid gap-3 lg:grid-cols-2">
                          {c.subtopics.map((st) => (
                            <div key={st.id} className="flex flex-col rounded-lg border border-slate-200 p-4">
                              <div className="flex flex-wrap items-center gap-2">
                                <IntentBadge intent={st.intent} />
                                <TypeTag type={st.content_type} />
                                {st.total_volume !== null && (
                                  <span className="ml-auto text-xs text-slate-400">{numberFormat.format(st.total_volume)} total vol</span>
                                )}
                              </div>
                              <h4 className="mt-2 font-semibold text-slate-900">{st.title}</h4>
                              <p className="text-xs text-slate-500">
                                Primary: <span className="font-mono text-indigo-700">{st.primary_keyword}</span>
                              </p>
                              <ul className="mt-2 flex flex-wrap gap-1.5">
                                {st.keywords.map((k) => (
                                  <li
                                    key={k.keyword}
                                    className={`rounded-full px-2 py-0.5 text-xs ${
                                      k.keyword === st.primary_keyword ? "bg-indigo-100 font-medium text-indigo-800" : "bg-slate-100 text-slate-600"
                                    }`}
                                  >
                                    {k.keyword}
                                    {k.volume !== null && <span className="ml-1 text-slate-400">{numberFormat.format(k.volume)}</span>}
                                  </li>
                                ))}
                              </ul>
                              <button
                                type="button"
                                onClick={() => send(st.brief_request)}
                                className="mt-3 self-start rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-slate-700"
                              >
                                ✨ Generate Brief for this Subtopic
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </article>
            );
          })}

          {result.unclustered.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-4">
              <p className="text-sm font-semibold text-amber-900">Unclustered keywords</p>
              <p className="text-xs text-amber-800">These didn’t fit any cluster. Try re-running with a more specific seed topic, or treat them as standalone pages.</p>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {result.unclustered.map((k) => (
                  <li key={k.keyword} className="rounded-full bg-white px-2 py-0.5 text-xs text-slate-700 ring-1 ring-inset ring-amber-200">
                    {k.keyword}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

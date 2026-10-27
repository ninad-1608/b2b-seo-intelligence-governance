"use client";

import { useState } from "react";
import SchemaViewer, { type SchemaResult } from "./SchemaViewer";
import FixCodeViewer, { type FixSnippets } from "./FixCodeViewer";
import ReactMarkdown from "react-markdown";
import { markdownComponents } from "./markdownComponents";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8010";

type Props = { query: string; competingUrls: string[] };

export default function AlertBriefButton({ query, competingUrls }: Props) {
  const [loading, setLoading] = useState(false);
  const [brief, setBrief] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const [winner, setWinner] = useState(competingUrls[0] ?? "");
  const [fixLoading, setFixLoading] = useState(false);
  const [fixError, setFixError] = useState<string | null>(null);
  const [snippets, setSnippets] = useState<FixSnippets | null>(null);

  const [schemaType, setSchemaType] = useState("auto");
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [schema, setSchema] = useState<SchemaResult | null>(null);

  async function generateSchema() {
    setSchemaLoading(true);
    setSchemaError(null);
    try {
      const res = await fetch(`${API_URL}/api/v1/generate-schema`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          target_url: winner,
          brief_content: brief ?? undefined,
          schema_type: schemaType,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = Array.isArray(data.detail) ? data.detail[0]?.msg : data.detail;
        throw new Error(typeof detail === "string" ? detail : `Request failed (${res.status})`);
      }
      setSchema(data);
    } catch (err) {
      setSchemaError(err instanceof Error ? err.message : "Could not generate schema.");
    } finally {
      setSchemaLoading(false);
    }
  }

  async function generateFix() {
    setFixLoading(true);
    setFixError(null);
    try {
      const res = await fetch(`${API_URL}/api/v1/generate-fix-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          winning_url: winner,
          canonical_url: winner,
          losing_urls: competingUrls.filter((u) => u !== winner),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = Array.isArray(data.detail) ? data.detail[0]?.msg : data.detail;
        throw new Error(typeof detail === "string" ? detail : `Request failed (${res.status})`);
      }
      setSnippets(data.snippets);
    } catch (err) {
      setFixError(err instanceof Error ? err.message : "Could not generate fix code.");
    } finally {
      setFixLoading(false);
    }
  }

  async function generate() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/v1/generate-brief`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, competing_urls: competingUrls, target_keyword: query }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof data.detail === "string" ? data.detail : `Request failed (${res.status})`);
      }
      setBrief(data.brief ?? "");
      setOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate the brief.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {competingUrls.length > 1 && (
          <label className="flex items-center gap-1.5 text-xs text-slate-500">
            Winner
            <select
              value={winner}
              onChange={(e) => {
                setWinner(e.target.value);
                setSnippets(null);
                setSchema(null);
              }}
              className="max-w-40 truncate rounded border border-slate-300 bg-white px-1.5 py-1 font-mono text-xs text-slate-700"
            >
              {competingUrls.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </label>
        )}
        {brief && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-sm font-medium text-slate-600 hover:text-slate-900"
          >
            {open ? "Hide brief" : "Show brief"}
          </button>
        )}
        <button
          type="button"
          onClick={generate}
          disabled={loading}
          aria-label={`Generate AI brief for ${query}`}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
        >
          {loading ? "Generating…" : brief ? "Regenerate Brief" : "Generate Brief"}
        </button>
        <button
          type="button"
          onClick={generateFix}
          disabled={fixLoading || competingUrls.length < 2}
          className="rounded-md bg-amber-500 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-amber-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
        >
          {fixLoading ? "Generating…" : "⚡ Generate Fix Code"}
        </button>
        <select
          value={schemaType}
          onChange={(e) => setSchemaType(e.target.value)}
          aria-label="Schema type"
          className="rounded border border-slate-300 bg-white px-1.5 py-1.5 text-xs text-slate-700"
        >
          <option value="auto">Schema: Auto</option>
          <option value="FAQPage">FAQPage</option>
          <option value="Article">Article</option>
          <option value="HowTo">HowTo</option>
        </select>
        <button
          type="button"
          onClick={generateSchema}
          disabled={schemaLoading}
          className="rounded-md bg-teal-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-teal-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
        >
          {schemaLoading ? "Generating…" : "📋 Generate Schema"}
        </button>
      </div>

      {fixError && (
        <p role="alert" className="mt-3 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {fixError}
        </p>
      )}
      {snippets && <FixCodeViewer snippets={snippets} />}

      {schemaError && (
        <p role="alert" className="mt-3 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {schemaError}
        </p>
      )}
      {schema && <SchemaViewer result={schema} />}

      {error && (
        <p role="alert" className="mt-3 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {error}
        </p>
      )}

      {brief && open && (
        <div className="mt-3 max-h-96 overflow-y-auto rounded-md border border-slate-200 bg-slate-50 p-4 text-sm leading-relaxed text-slate-800">
          <ReactMarkdown components={markdownComponents}>{brief}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}

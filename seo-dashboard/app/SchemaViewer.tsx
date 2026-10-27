"use client";

import { useState } from "react";

export type SchemaResult = {
  schema_type: string;
  search_intent: {
    primary: string;
    breakdown?: { informational?: number; commercial?: number; transactional?: number };
    rationale?: string;
  };
  snippet: string;
};

const intentStyles: Record<string, string> = {
  Informational: "bg-sky-50 text-sky-700 ring-sky-600/20",
  Commercial: "bg-violet-50 text-violet-700 ring-violet-600/20",
  Transactional: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
};

export default function SchemaViewer({ result }: { result: SchemaResult }) {
  const [copied, setCopied] = useState(false);
  const { primary, breakdown, rationale } = result.search_intent;

  async function copy() {
    try {
      await navigator.clipboard.writeText(result.snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  const parts = [
    ["Informational", breakdown?.informational],
    ["Commercial", breakdown?.commercial],
    ["Transactional", breakdown?.transactional],
  ].filter((p): p is [string, number] => typeof p[1] === "number");

  return (
    <div className="mt-3 overflow-hidden rounded-md border border-slate-200">
      <div className="space-y-2 bg-slate-50 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-slate-500">Search intent</span>
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${
              intentStyles[primary] ?? "bg-slate-100 text-slate-600 ring-slate-500/20"
            }`}
          >
            {primary}
          </span>
          {parts.length > 0 && (
            <span className="text-xs text-slate-500">
              {parts.map(([label, pct]) => `${label} ${pct}%`).join(" · ")}
            </span>
          )}
          <span className="ml-auto rounded bg-slate-200 px-2 py-0.5 font-mono text-xs text-slate-700">
            {result.schema_type}
          </span>
        </div>
        {rationale && <p className="text-xs leading-relaxed text-slate-600">{rationale}</p>}
      </div>

      <div className="flex items-center justify-between border-t border-slate-200 bg-slate-100 px-3 py-1.5">
        <span className="text-xs font-medium text-slate-600">JSON-LD</span>
        <button
          type="button"
          onClick={copy}
          className="rounded bg-white px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
        >
          {copied ? "Copied ✓" : "Copy Schema"}
        </button>
      </div>
      <pre className="max-h-80 overflow-auto bg-slate-900 p-3 text-xs leading-relaxed text-slate-100">
        <code className="font-mono">{result.snippet}</code>
      </pre>
    </div>
  );
}

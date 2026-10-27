"use client";

import { useEffect, useRef, useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8010";
const NAME_MAX = 80;
const NOTES_MAX = 1000;
const STORAGE_KEY = "seo-dashboard.export-report";
const TIMEOUT_MS = 90_000;

type Source = "auto" | "live" | "sample";
type Phase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "done"; filename: string; pages: string | null; source: string | null };

const SOURCES: { value: Source; label: string; hint: string }[] = [
  { value: "auto", label: "Automatic", hint: "Your synced Search Console data if there is any; otherwise clearly marked demo data." },
  { value: "live", label: "Live data only", hint: "Fails with a message if no Search Console data has been synced." },
  { value: "sample", label: "Demo data", hint: "Built-in sample figures. Every page is marked DEMO DATA so it cannot pass for real results." },
];

function readSaved(): { preparedFor: string; preparedBy: string } {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const v = JSON.parse(raw) as { preparedFor?: string; preparedBy?: string };
      return { preparedFor: String(v.preparedFor ?? "").slice(0, NAME_MAX), preparedBy: String(v.preparedBy ?? "").slice(0, NAME_MAX) };
    }
  } catch {
    /* private window or blocked storage: start empty */
  }
  return { preparedFor: "", preparedBy: "" };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "report";
}

function filenameFrom(res: Response, preparedFor: string): string {
  const cd = res.headers.get("Content-Disposition") ?? "";
  const m = /filename="([^"]+)"/.exec(cd);
  if (m && /^[\w.-]+\.pdf$/.test(m[1])) return m[1];
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `SEO-Executive-Audit-${slug(preparedFor)}-${stamp}.pdf`;
}

async function readError(res: Response): Promise<string> {
  const data = await res.json().catch(() => ({}));
  const detail = Array.isArray(data.detail) ? data.detail[0]?.msg : data.detail;
  return typeof detail === "string" ? detail : `The report could not be generated (HTTP ${res.status}).`;
}

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** Customise and download the Executive Audit PDF. Everything is built on the server; this only collects the options and saves the file. */
export default function ExportReportModal({ onClose }: { onClose: () => void }) {
  const [saved] = useState(readSaved);
  const [preparedFor, setPreparedFor] = useState(saved.preparedFor);
  const [preparedBy, setPreparedBy] = useState(saved.preparedBy);
  const [notes, setNotes] = useState("");
  const [includeGovernance, setIncludeGovernance] = useState(true);
  const [source, setSource] = useState<Source>("auto");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const dialogRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
      controllerRef.current?.abort(); // closing the dialog cancels a report that is still being built
    };
  }, []);

  const busy = phase.kind === "loading";

  async function generate(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ preparedFor: preparedFor.trim(), preparedBy: preparedBy.trim() }));
    } catch {
      /* not worth failing the export over */
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    let timedOut = false;
    const timer = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, TIMEOUT_MS);
    setPhase({ kind: "loading" });
    try {
      const qs = new URLSearchParams({ prepared_for: preparedFor.trim(), prepared_by: preparedBy.trim(), notes: notes.trim(), include_governance: String(includeGovernance), source });
      const res = await fetch(`${API_URL}/api/v1/reports/executive-audit-pdf?${qs}`, { signal: controller.signal });
      if (!res.ok) throw new Error(await readError(res));
      const blob = await res.blob();
      if (blob.type !== "application/pdf" || blob.size < 1000) throw new Error("The server did not return a PDF. Please try again.");
      const filename = filenameFrom(res, preparedFor.trim());
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setPhase({ kind: "done", filename, pages: res.headers.get("X-Report-Pages"), source: res.headers.get("X-Report-Source") });
    } catch (err) {
      if (timedOut) {
        setPhase({ kind: "error", message: "The report took too long to build and was cancelled. Please try again." });
      } else if (!controller.signal.aborted) {
        setPhase({ kind: "error", message: err instanceof Error ? err.message : "Could not reach the analysis API. Is the FastAPI server running?" });
      } // else: the dialog was closed while building, so there is nothing left to show
    } finally {
      window.clearTimeout(timer);
    }
  }

  const sourceHint = SOURCES.find((s) => s.value === source)?.hint;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-0 sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-title"
        tabIndex={-1}
        className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl focus:outline-none sm:rounded-2xl"
      >
        <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 id="export-title" className="text-base font-semibold text-slate-900">
              Export Executive PDF
            </h2>
            <p className="mt-0.5 text-sm text-slate-500">A client-ready audit: summary, priorities, 30/60/90-day scenarios, technical findings and sign-off history.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
            ✕
          </button>
        </header>

        <form onSubmit={generate} className="space-y-4 overflow-y-auto px-5 py-5">
          <label className="block text-sm font-medium text-slate-700">
            Prepared for <span className="font-normal text-slate-400">(client or organisation)</span>
            <input
              type="text"
              value={preparedFor}
              maxLength={NAME_MAX}
              onChange={(e) => setPreparedFor(e.target.value)}
              placeholder="Acme Corporation"
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Prepared by <span className="font-normal text-slate-400">(optional)</span>
            <input
              type="text"
              value={preparedBy}
              maxLength={NAME_MAX}
              onChange={(e) => setPreparedBy(e.target.value)}
              placeholder="Your name or team"
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Notes <span className="font-normal text-slate-400">(optional, shown in the executive summary)</span>
            <textarea
              value={notes}
              maxLength={NOTES_MAX}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Context for the reader, e.g. what decision you need from them."
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
            />
            <span className="mt-0.5 block text-right text-xs text-slate-400">
              {notes.length}/{NOTES_MAX}
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <input type="checkbox" checked={includeGovernance} onChange={(e) => setIncludeGovernance(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
            <span className="text-sm">
              <span className="font-medium text-slate-800">Include governance history</span>
              <span className="block text-xs text-slate-500">Adds who approved, rejected or sent back each opportunity, with their comments. Leave it off for a version without reviewer names.</span>
            </span>
          </label>

          <fieldset>
            <legend className="text-sm font-medium text-slate-700">Data</legend>
            <div className="mt-1 inline-flex rounded-lg bg-slate-100 p-1 text-sm font-medium" role="radiogroup" aria-label="Data source">
              {SOURCES.map((s) => (
                <label key={s.value} className={`cursor-pointer rounded-md px-3 py-1.5 transition focus-within:ring-2 focus-within:ring-indigo-500 ${source === s.value ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800"}`}>
                  <input type="radio" name="export-source" value={s.value} checked={source === s.value} onChange={() => setSource(s.value)} className="sr-only" />
                  {s.label}
                </label>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-slate-500">{sourceHint}</p>
          </fieldset>

          <p className="rounded-md bg-amber-50 p-2.5 text-xs text-amber-900">Scores and projections are ranking aids to prioritize investigation and risk. They do not predict traffic, leads, or revenue. This line is printed on every page.</p>

          {phase.kind === "error" && (
            <p role="alert" className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
              {phase.message}
            </p>
          )}
          {phase.kind === "done" && (
            <p role="status" className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
              ✓ Downloaded <span className="font-medium">{phase.filename}</span>
              {phase.pages ? ` (${phase.pages} pages)` : ""}.{phase.source === "sample" && " It is built from demo data and marked DEMO DATA on every page."}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
              {phase.kind === "done" ? "Close" : "Cancel"}
            </button>
            <button
              type="submit"
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {busy ? (
                <>
                  <Spinner /> Building report…
                </>
              ) : phase.kind === "done" ? (
                "Generate again"
              ) : (
                "Generate & download"
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

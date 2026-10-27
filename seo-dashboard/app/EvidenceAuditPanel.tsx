"use client";

import { FreshnessChip, formatWhen, useEvidence, type AuditFinding } from "./evidence";

const SEVERITY: Record<AuditFinding["severity"], { label: string; badge: string; accent: string }> = {
  error: { label: "Error", badge: "bg-rose-600 text-white", accent: "border-l-rose-500" },
  warning: { label: "Warning", badge: "bg-amber-500 text-white", accent: "border-l-amber-500" },
  info: { label: "Note", badge: "bg-slate-500 text-white", accent: "border-l-slate-400" },
};

const CHECKS: { key: string; label: string; what: string }[] = [
  { key: "stale_data", label: "Stale data", what: "Search Console or crawl data older than 7 days" },
  { key: "text_consistency", label: "Text vs data", what: "Alert text whose figures are more than 25% off the current data" },
  { key: "integrity", label: "Snapshot & baselines", what: "Missing queries or positions, row counts, incomplete baselines" },
];

function Checks() {
  const ev = useEvidence();
  const audit = ev?.audit;
  if (!audit) return null;
  return (
    <ul className="grid gap-3 sm:grid-cols-3">
      {CHECKS.map((c) => {
        const r = audit.checks[c.key];
        const tone = !r ? "text-slate-500" : r.status === "ok" ? "text-emerald-700" : r.status === "failed" ? "text-rose-700" : "text-amber-700";
        return (
          <li key={c.key} className="rounded-lg border border-slate-200 bg-white p-3">
            <p className="text-sm font-semibold text-slate-900">{c.label}</p>
            <p className={`mt-0.5 text-sm font-medium ${tone}`}>{!r ? "Not run" : r.status === "ok" ? "Passed" : r.status === "failed" ? "Could not run" : `${r.findings} finding${r.findings === 1 ? "" : "s"}`}</p>
            <p className="mt-1 text-xs text-slate-500">{c.what}</p>
          </li>
        );
      })}
    </ul>
  );
}

/** The full audit: where each kind of data came from, how old it is, and every inconsistency found. */
export default function EvidenceAuditPanel() {
  const ev = useEvidence();
  if (!ev) return null;
  const { audit, failed, running, runNow } = ev;

  return (
    <section aria-labelledby="evidence-heading" className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="evidence-heading" className="text-lg font-semibold text-slate-900">
              Evidence Audit
            </h2>
            <p className="text-sm text-slate-500">
              Re-checks the stored data for age, for written figures that no longer match, and for missing positions or queries. It uses only what is already stored.
            </p>
            {audit && (
              <p className="mt-1 text-xs text-slate-400">
                Last audit {formatWhen(audit.ran_at)} · took {audit.duration_ms} ms
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => void runNow()}
            disabled={running}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {running ? "Running…" : "Run audit now"}
          </button>
        </div>
      </div>

      {failed && (
        <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          Could not load the audit from the analysis API{audit ? ", so this is the last result we received" : ""}. Do not read a missing result as a clean one.
        </p>
      )}
      {!audit && !failed && <p className="text-sm text-slate-500">Loading the audit…</p>}

      {audit && (
        <>
          <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
            <h3 className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-900">Data sources and freshness</h3>
            <ul className="divide-y divide-slate-100">
              {audit.sources.map((s) => (
                <li key={s.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3">
                  <span className="w-44 shrink-0 text-sm font-medium text-slate-800">{s.label}</span>
                  <FreshnessChip source={s.key} />
                  <span className="min-w-0 flex-1 basis-60 text-xs text-slate-500">
                    {s.detail}
                    {s.site_url ? ` ${s.site_url}, data ${s.window}.` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <Checks />

          <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
            <h3 className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-900">
              Findings <span className="font-normal text-slate-500">({audit.counts.error} errors · {audit.counts.warning} warnings · {audit.counts.info} notes)</span>
            </h3>
            {audit.findings.length === 0 ? (
              <p className="px-5 py-4 text-sm font-medium text-emerald-700">✓ No stale data and no inconsistencies found in the stored evidence.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {audit.findings.map((f) => {
                  const sv = SEVERITY[f.severity];
                  return (
                    <li key={f.id} className={`border-l-4 px-5 py-3 ${sv.accent}`}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${sv.badge}`}>{sv.label}</span>
                        <p className="text-sm font-semibold text-slate-900">{f.title}</p>
                      </div>
                      <p className="mt-1 text-sm text-slate-600">{f.detail}</p>
                      {typeof f.deviation_pct === "number" && typeof f.claimed === "number" && typeof f.live === "number" && (
                        <p className="mt-1 text-xs text-slate-500">
                          Written: <strong>{f.claimed.toLocaleString()}</strong> · Current data: <strong>{f.live.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong> · {f.deviation_pct}% apart
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/** Compact version for the dashboard: the headline, the source freshness, and the top findings, with a way into the full audit. */
export function EvidenceAuditSummary({ onOpen }: { onOpen: () => void }) {
  const ev = useEvidence();
  if (!ev) return null;
  const { audit, failed } = ev;

  if (!audit) {
    return (
      <section aria-label="Evidence audit" className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500 shadow-sm">
        {failed ? "Could not load the evidence audit, so data freshness is unknown." : "Checking the evidence audit…"}
      </section>
    );
  }

  const tone =
    audit.status === "errors" ? "border-rose-200 bg-rose-50" : audit.status === "issues" ? "border-amber-200 bg-amber-50" : "border-emerald-200 bg-emerald-50";
  const headline =
    audit.status === "ok"
      ? "Evidence audit: all stored data is current and consistent"
      : `Evidence audit: ${audit.counts.error} error${audit.counts.error === 1 ? "" : "s"}, ${audit.counts.warning} warning${audit.counts.warning === 1 ? "" : "s"}${audit.counts.info ? `, ${audit.counts.info} note${audit.counts.info === 1 ? "" : "s"}` : ""}`;
  const top = audit.findings.filter((f) => f.severity !== "info").slice(0, 2);

  return (
    <section aria-label="Evidence audit" className={`rounded-xl border px-4 py-3 ${tone}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-0 flex-1 basis-72 text-sm font-semibold text-slate-900">
          {headline}
          <span className="ml-2 text-xs font-normal text-slate-500">
            last audit {formatWhen(audit.ran_at)}
            {failed && " · could not refresh just now"}
          </span>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-slate-500">Search Console</span>
          <FreshnessChip source="gsc" />
          <span className="text-xs text-slate-500">Crawl</span>
          <FreshnessChip source="crawl" />
        </div>
        <button type="button" onClick={onOpen} className="shrink-0 rounded-full bg-white/70 px-3 py-1 text-xs font-medium text-slate-600 ring-1 ring-inset ring-slate-300 transition hover:bg-white hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
          Open audit →
        </button>
      </div>
      {top.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-slate-700">
          {top.map((f) => (
            <li key={f.id}>• {f.title}</li>
          ))}
          {audit.counts.error + audit.counts.warning > top.length && <li className="text-slate-500">…and {audit.counts.error + audit.counts.warning - top.length} more</li>}
        </ul>
      )}
    </section>
  );
}

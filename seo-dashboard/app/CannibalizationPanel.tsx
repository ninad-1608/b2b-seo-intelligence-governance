"use client";

import { useEffect, useState } from "react";
import AlertBriefButton from "./AlertBriefButton";
import { OUTCOME_STYLE, groupOf, type DeepCheckResponse, type Group, type Validation } from "./lib/cannibalValidation";
import QuickFixModal from "./QuickFixModal";

export type RiskLevel = "High" | "Medium" | "Low";

export type UrlStat = { url: string; impressions: number; position: number };

export type CannibalizationAlert = {
  query: string;
  competing_urls: string[];
  url_stats: UrlStat[]; // per-URL impressions / avg position, used by the Quick Fix
  total_impressions: number;
  risk_level: RiskLevel;
  validation?: Validation; // the six validation checks and the verdict
};

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8010";

const riskStyles: Record<RiskLevel, string> = {
  High: "bg-rose-50 text-rose-700 ring-rose-600/20",
  Medium: "bg-indigo-50 text-indigo-700 ring-indigo-600/20",
  Low: "bg-slate-100 text-slate-600 ring-slate-500/20",
};

const numberFormat = new Intl.NumberFormat("en-US");

const GROUPS: { key: Group; title: string; blurb: string; badge: string; border: string }[] = [
  { key: "harmful", title: "Harmful overlaps", blurb: "Consolidation candidates: nothing explained the overlap away.", badge: "bg-rose-600 text-white", border: "border-rose-200" },
  { key: "domination", title: "Winning SERP dominations", blurb: "Your pages hold the top results together. That is a win, not a problem.", badge: "bg-emerald-600 text-white", border: "border-emerald-200" },
  { key: "cleared", title: "Cleared by validation checks", blurb: "Too little data, or one URL takes almost everything. Nothing to consolidate.", badge: "bg-emerald-700 text-white", border: "border-emerald-200" },
  { key: "false_positive", title: "False positives", blurb: "The URLs only look like they compete: regional or audience variants, one canonical, different countries, or different intents.", badge: "bg-slate-600 text-white", border: "border-slate-200" },
];

function WarningIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5 shrink-0 text-rose-500" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M8.5 3.5a1.7 1.7 0 0 1 3 0l6 10.8A1.7 1.7 0 0 1 16 16.8H4a1.7 1.7 0 0 1-1.5-2.5l6-10.8ZM10 7.5a.9.9 0 0 0-.9.9v3a.9.9 0 1 0 1.8 0v-3a.9.9 0 0 0-.9-.9Zm0 6.6a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function VerdictBadge({ v }: { v: Validation | undefined }) {
  const g = GROUPS.find((x) => x.key === groupOf(v)) ?? GROUPS[0];
  const text = v?.domination ? "Winning SERP domination" : (v?.label ?? "Harmful overlap");
  return <span className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${g.badge}`}>{text}</span>;
}

type DeepState = { busy: boolean; error: string | null; info: DeepCheckResponse["evidence"] | null };

/** "Why, evidence and checks": every test with its result, the threshold it was held to, and what was observed. */
function EvidencePanel({ id, v, canDeep, deep, onDeep }: { id: string; v: Validation; canDeep: boolean; deep: DeepState | undefined; onDeep: () => void }) {
  return (
    <div id={id} className="mt-3 space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <p className="text-sm text-slate-700">
        <span className="font-semibold text-slate-900">{v.label}.</span> {v.headline}
      </p>
      <ol className="space-y-2">
        {v.checks.map((c, i) => {
          const o = OUTCOME_STYLE[c.outcome];
          return (
            <li key={c.id} className="rounded-md bg-white p-2.5 ring-1 ring-inset ring-slate-200">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-slate-400">{String.fromCharCode(97 + i)}.</span>
                <span className="text-sm font-semibold text-slate-900">{c.label}</span>
                <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${o.pill}`}>
                  <span aria-hidden="true">{o.icon}</span>
                  {o.label}
                </span>
              </div>
              <p className="mt-1 text-sm text-slate-600">{c.summary}</p>
              <dl className="mt-1.5 grid gap-x-4 gap-y-0.5 text-xs text-slate-500 sm:grid-cols-[auto_1fr]">
                <dt className="font-medium text-slate-600">Threshold</dt>
                <dd>{c.threshold}</dd>
                <dt className="font-medium text-slate-600">Observed</dt>
                <dd className="break-words">{c.observed}</dd>
              </dl>
            </li>
          );
        })}
      </ol>
      <p className={`text-xs ${v.confidence === "partial" ? "text-amber-700" : "text-slate-500"}`}>
        {v.tested} of {v.total} checks could be tested.
        {v.confidence === "partial" && " The verdict rests on the checks that ran; the others need data this view does not have."}
      </p>
      {v.untested.length > 0 &&
        (canDeep ? (
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onDeep}
              disabled={deep?.busy}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {deep?.busy ? "Fetching evidence…" : "Run deep checks"}
            </button>
            <span className="text-xs text-slate-500">Fetches each page&rsquo;s canonical tag, Google&rsquo;s chosen canonical and per-day, per-country data for this query.</span>
          </div>
        ) : (
          <p className="text-xs text-slate-500">Deep checks need your live, synced Search Console data.</p>
        ))}
      {deep?.error && (
        <p role="alert" className="rounded-md border border-rose-200 bg-rose-50 p-2 text-sm text-rose-700">
          {deep.error}
        </p>
      )}
      {deep?.info && (
        <div className="text-xs text-slate-500">
          <p>
            Evidence fetched {new Date(deep.info.fetched_at).toLocaleString()} · {deep.info.urls_checked} URLs · {deep.info.days} days of data ({deep.info.window}). Kept until the next sync.
          </p>
          {deep.info.errors.length > 0 && (
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-amber-700">
              {deep.info.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

type RowProps = {
  alert: CannibalizationAlert;
  v: Validation | undefined;
  open: boolean;
  onToggle: () => void;
  canDeep: boolean;
  deep: DeepState | undefined;
  onDeep: () => void;
};

function ToggleButton({ open, controls, onToggle }: { open: boolean; controls: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={controls}
      className="rounded-md px-2 py-1 text-sm font-medium text-indigo-700 hover:bg-indigo-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
    >
      {open ? "Hide" : "Why, evidence and checks"} <span aria-hidden="true">{open ? "▴" : "▾"}</span>
    </button>
  );
}

/** A candidate that was cleared or ruled out: compact, because there is nothing to fix. */
function DismissedRow({ alert, v, open, onToggle, canDeep, deep, onDeep }: RowProps) {
  const id = `evidence-${alert.query.replace(/\W+/g, "-")}`;
  return (
    <li className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="min-w-0 flex-1 basis-48 truncate font-medium text-slate-900" title={alert.query}>
          {alert.query}
          <span className="ml-2 text-xs font-normal text-slate-400">{numberFormat.format(alert.total_impressions)} impressions</span>
        </p>
        <VerdictBadge v={v} />
        <ToggleButton open={open} controls={id} onToggle={onToggle} />
      </div>
      <p className="mt-1 text-sm text-slate-600">{v?.headline}</p>
      {open && v && <EvidencePanel id={id} v={v} canDeep={canDeep} deep={deep} onDeep={onDeep} />}
    </li>
  );
}

export default function CannibalizationPanel({
  alerts,
  canDeepCheck = false,
  onDeepChecked,
}: {
  alerts: CannibalizationAlert[];
  /** True for live, synced Search Console data: the only data the deep checks can fetch evidence for. */
  canDeepCheck?: boolean;
  onDeepChecked?: () => void;
}) {
  const [queued, setQueued] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const [fixAlert, setFixAlert] = useState<CannibalizationAlert | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [deep, setDeep] = useState<Record<string, DeepState>>({});
  const [overrides, setOverrides] = useState<Record<string, Validation>>({});

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  function queue(query: string) {
    setQueued((prev) => new Set(prev).add(query));
    setToast(`Action queued for review: “${query}”`);
  }

  function toggle(query: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(query)) next.delete(query);
      else next.add(query);
      return next;
    });
  }

  async function runDeep(query: string) {
    setDeep((d) => ({ ...d, [query]: { busy: true, error: null, info: d[query]?.info ?? null } }));
    try {
      const res = await fetch(`${API_URL}/api/v1/cannibalization/deep-check`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : `Deep check failed (${res.status})`);
      const body = data as DeepCheckResponse;
      setOverrides((o) => ({ ...o, [query]: body.validation }));
      setDeep((d) => ({ ...d, [query]: { busy: false, error: null, info: body.evidence } }));
      onDeepChecked?.();
    } catch (err) {
      setDeep((d) => ({ ...d, [query]: { busy: false, error: err instanceof Error ? err.message : "Deep check failed.", info: d[query]?.info ?? null } }));
    }
  }

  const effective = (a: CannibalizationAlert) => overrides[a.query] ?? a.validation;
  const grouped: Record<Group, CannibalizationAlert[]> = { harmful: [], domination: [], cleared: [], false_positive: [] };
  for (const a of alerts) grouped[groupOf(effective(a))].push(a);
  const dismissedTotal = alerts.length - grouped.harmful.length;

  return (
    <section aria-labelledby="cannibalization-heading" className="space-y-5">
      <div className="space-y-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="cannibalization-heading" className="text-base font-semibold text-slate-900">
            Cannibalization alerts
          </h2>
          <span className="text-sm text-slate-500">
            {grouped.harmful.length} harmful {grouped.harmful.length === 1 ? "overlap" : "overlaps"}
            {dismissedTotal > 0 && ` · ${dismissedTotal} set aside by validation`}
          </span>
        </div>
        <p className="text-xs text-slate-500">
          A query showing two or more of your URLs is only a candidate. Each one runs six checks (volume floor, canonical, regional and audience variants, country and same-day overlap, page type and intent, SERP domination) before it is called harmful.
        </p>
      </div>

      {alerts.length === 0 ? (
        <p className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-500 shadow-sm">No cannibalization candidates detected.</p>
      ) : (
        <>
          {grouped.harmful.length === 0 && (
            <p className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-800">
              ✓ No harmful overlaps. {alerts.length} candidate{alerts.length === 1 ? " was" : "s were"} checked and set aside below.
            </p>
          )}

          {GROUPS.map((g) => {
            const list = grouped[g.key];
            if (list.length === 0) return null;
            return (
              <div key={g.key} className="space-y-2">
                <div>
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                    <span className={`rounded-full px-2 py-0.5 text-xs ${g.badge}`}>{list.length}</span>
                    {g.title}
                  </h3>
                  <p className="text-xs text-slate-500">{g.blurb}</p>
                </div>

                {g.key === "harmful" ? (
                  <div className="grid gap-4 lg:grid-cols-2">
                    {list.map((alert) => {
                      const isQueued = queued.has(alert.query);
                      const v = effective(alert);
                      const id = `evidence-${alert.query.replace(/\W+/g, "-")}`;
                      return (
                        <article key={alert.query} className="rounded-xl border border-rose-200 bg-white p-5 shadow-sm">
                          <header className="flex items-start gap-3">
                            <WarningIcon />
                            <div className="min-w-0 flex-1">
                              <h4 className="truncate font-semibold text-slate-900">{alert.query}</h4>
                              <p className="mt-0.5 text-xs text-slate-500">
                                {numberFormat.format(alert.total_impressions)} impressions · {alert.competing_urls.length} competing pages
                              </p>
                            </div>
                            <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${riskStyles[alert.risk_level]}`}>{alert.risk_level} risk</span>
                          </header>

                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <VerdictBadge v={v} />
                            {v?.confidence === "partial" && <span className="text-xs text-amber-700">{v.tested} of {v.total} checks tested</span>}
                          </div>

                          <ul className="mt-3 space-y-1.5">
                            {alert.competing_urls.map((url) => (
                              <li key={url} className="truncate rounded-md bg-slate-50 px-3 py-1.5 font-mono text-xs text-slate-700" title={url}>
                                {url}
                              </li>
                            ))}
                          </ul>

                          <div className="mt-3">
                            <ToggleButton open={expanded.has(alert.query)} controls={id} onToggle={() => toggle(alert.query)} />
                            {expanded.has(alert.query) && v && <EvidencePanel id={id} v={v} canDeep={canDeepCheck} deep={deep[alert.query]} onDeep={() => void runDeep(alert.query)} />}
                          </div>

                          <div className="mt-4">
                            <AlertBriefButton query={alert.query} competingUrls={alert.competing_urls} />
                          </div>

                          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => setFixAlert(alert)}
                              disabled={alert.url_stats.length < 2}
                              className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-rose-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:ring-offset-2 disabled:opacity-50"
                            >
                              🛠 Quick Fix: Merge &amp; Redirect
                            </button>
                            {isQueued ? (
                              <span className="text-sm font-medium text-emerald-700">Queued for review</span>
                            ) : (
                              <button
                                type="button"
                                onClick={() => queue(alert.query)}
                                className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
                              >
                                Consolidation Candidate
                              </button>
                            )}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {list.map((alert) => (
                      <DismissedRow
                        key={alert.query}
                        alert={alert}
                        v={effective(alert)}
                        open={expanded.has(alert.query)}
                        onToggle={() => toggle(alert.query)}
                        canDeep={canDeepCheck}
                        deep={deep[alert.query]}
                        onDeep={() => void runDeep(alert.query)}
                      />
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </>
      )}

      {fixAlert && <QuickFixModal alert={fixAlert} onClose={() => setFixAlert(null)} />}

      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-6 flex justify-center px-4">
        {toast && <div className="rounded-lg bg-slate-900 px-4 py-2.5 text-sm text-white shadow-lg">{toast}</div>}
      </div>
    </section>
  );
}

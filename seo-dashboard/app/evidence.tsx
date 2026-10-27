"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

const AUDIT_URL = `${process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8010"}/api/v1/audit`;
const REFRESH_MS = 5 * 60 * 1000;

export type FreshnessStatus = "current" | "stale" | "missing";
export type SourceKey = "gsc" | "crawl" | "ga4";

export type AuditSource = {
  key: SourceKey;
  label: string;
  status: FreshnessStatus;
  last_sync: string | null;
  age_days: number | null;
  detail: string;
  site_url?: string | null;
  window?: string | null;
  collected?: boolean;
};

export type AuditFinding = {
  id: string;
  check: "stale_data" | "text_consistency" | "integrity";
  severity: "error" | "warning" | "info";
  source: string;
  title: string;
  detail: string;
  claimed?: number;
  live?: number;
  deviation_pct?: number | null;
};

export type AuditStatus = {
  ran_at: string;
  duration_ms: number;
  status: "ok" | "issues" | "errors";
  counts: { error: number; warning: number; info: number; total: number };
  error_count: number;
  sources: AuditSource[];
  checks: Record<string, { status: "ok" | "issues" | "failed"; findings: number }>;
  findings: AuditFinding[];
  thresholds: { stale_days: number; discrepancy_pct: number };
};

type Evidence = {
  audit: AuditStatus | null;
  failed: boolean;
  running: boolean;
  reload: () => void;
  runNow: () => Promise<void>;
};

const EvidenceContext = createContext<Evidence | null>(null);

export function useEvidence(): Evidence | null {
  return useContext(EvidenceContext);
}

function isAudit(x: unknown): x is AuditStatus {
  const a = x as AuditStatus;
  return Boolean(a) && typeof a.ran_at === "string" && Array.isArray(a.sources) && Array.isArray(a.findings) && typeof a.counts === "object";
}

/**
 * Loads the evidence audit once and shares it, so every card shows the same freshness. Reloads when `version` changes (a sync, an
 * alert check or a review), when the tab regains focus, and every five minutes.
 */
export function EvidenceProvider({ version = 0, children }: { version?: number; children: ReactNode }) {
  const [audit, setAudit] = useState<AuditStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [running, setRunning] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(`${AUDIT_URL}/status`, { signal: controller.signal, cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const body: unknown = await res.json();
        if (!isAudit(body)) throw new Error("unexpected response");
        setAudit(body);
        setFailed(false);
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    })();
    return () => controller.abort();
  }, [version, tick]);

  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    const timer = window.setInterval(bump, REFRESH_MS);
    window.addEventListener("focus", bump);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", bump);
    };
  }, []);

  const value = useMemo<Evidence>(
    () => ({
      audit,
      failed,
      running,
      reload: () => setTick((t) => t + 1),
      runNow: async () => {
        setRunning(true);
        try {
          const res = await fetch(`${AUDIT_URL}/run`, { method: "POST" });
          if (!res.ok) throw new Error(String(res.status));
          const body: unknown = await res.json();
          if (!isAudit(body)) throw new Error("unexpected response");
          setAudit(body);
          setFailed(false);
        } catch {
          setFailed(true);
        } finally {
          setRunning(false);
        }
      },
    }),
    [audit, failed, running],
  );

  return <EvidenceContext.Provider value={value}>{children}</EvidenceContext.Provider>;
}

export function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const CHIP: Record<FreshnessStatus, { label: string; cls: string }> = {
  current: { label: "Current", cls: "bg-emerald-50 text-emerald-800 ring-emerald-600/20" },
  stale: { label: "Stale", cls: "bg-amber-50 text-amber-800 ring-amber-600/30" },
  missing: { label: "Missing", cls: "bg-slate-100 text-slate-600 ring-slate-500/20" },
};

/** Current / Stale / Missing, with the date the data was last synced. `source` says which stored data the card is built from. */
export function FreshnessChip({ source, className = "" }: { source: SourceKey; className?: string }) {
  const ev = useEvidence();
  if (!ev) return null;
  const src = ev.audit?.sources.find((s) => s.key === source);
  if (!src) {
    return (
      <span className={`inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500 ring-1 ring-inset ring-slate-500/20 ${className}`}>
        {ev.failed ? "Freshness unknown" : "Checking freshness…"}
      </span>
    );
  }
  const c = CHIP[src.status];
  const when =
    src.status === "missing"
      ? src.collected === false
        ? "not collected"
        : "no sync yet"
      : `synced ${formatWhen(src.last_sync)}${src.status === "stale" && src.age_days !== null ? ` (${Math.floor(src.age_days)} days ago)` : ""}`;
  return (
    <span title={`${src.label}: ${src.detail}`} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${c.cls} ${className}`}>
      <span className="font-semibold">{c.label}</span>
      <span className="font-normal opacity-80">· {when}</span>
    </span>
  );
}

/** For figures that are not synced from anywhere (sample rows, reviewer ratings, numbers someone typed in), so they are never mistaken for evidence. */
export function NoSyncChip({ children = "Sample data · no sync date", title }: { children?: string; title?: string }) {
  return (
    <span
      title={title ?? "These figures are not pulled from Search Console, so there is no sync date."}
      className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 ring-1 ring-inset ring-slate-500/20"
    >
      {children}
    </span>
  );
}

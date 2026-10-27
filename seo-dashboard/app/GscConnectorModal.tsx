"use client";

import { useEffect, useRef, useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8010";
const B = `${API_URL}/api/v1/gsc`;
const numberFormat = new Intl.NumberFormat("en-US");

export type DataMode = "sandbox" | "live";

type Status = {
  configured: boolean;
  redirect_uri: string;
  connected: boolean;
  scopes: { gsc: boolean; ga4: boolean };
  connected_at: string | null;
  site_url: string | null;
  ga4_property: string | null;
  ga4_name: string | null;
  last_sync: {
    site_url: string;
    start_date: string;
    end_date: string;
    previous_start: string | null;
    previous_end: string | null;
    rows_current: number;
    rows_previous: number;
    truncated: boolean;
    synced_at: string;
  } | null;
};

type Properties = {
  gsc: { sites: { site_url: string; permission: string; type: "domain" | "url-prefix" }[]; error: string | null };
  ga4: { properties: { property_id: string; name: string; account: string }[]; error: string | null };
};

type SyncResult = {
  rows_current: number;
  rows_previous: number;
  truncated: boolean;
  totals_current: { clicks: number; impressions: number; ctr: number; position: number };
  note: string;
};

async function errorMessage(res: Response): Promise<string> {
  const data = await res.json().catch(() => ({}));
  const detail = Array.isArray(data.detail) ? data.detail[0]?.msg : data.detail;
  return typeof detail === "string" ? detail.replace(/^Value error, /, "") : `Request failed (${res.status})`;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${B}${path}`);
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function rangeEndingDaysAgo(daysAgo: number, length: number): { start: string; end: string } {
  const end = new Date();
  end.setDate(end.getDate() - daysAgo); // Search Console data lags by a few days
  const start = new Date(end);
  start.setDate(start.getDate() - (length - 1));
  return { start: iso(start), end: iso(end) };
}

type Props = {
  open: boolean;
  onClose: () => void;
  dataMode: DataMode;
  onModeChange: (mode: DataMode) => void;
  onSynced: () => void;
};

export default function GscConnectorModal({ open, onClose, dataMode, onModeChange, onSynced }: Props) {
  const [status, setStatus] = useState<Status | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [props, setProps] = useState<Properties | null>(null);

  const [site, setSite] = useState("");
  const [range, setRange] = useState(() => rangeEndingDaysAgo(3, 28));
  const [compare, setCompare] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Load connection status (and the account's properties when connected) whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const st = await getJson<Status>("/status");
        let pr: Properties | null = null;
        if (st.connected) {
          try {
            pr = await getJson<Properties>("/properties");
          } catch (e) {
            if (!cancelled) setError(e instanceof Error ? e.message : "Could not load properties.");
          }
        }
        if (cancelled) return;
        setStatus(st);
        setProps(pr);
        setSite((cur) => cur || st.last_sync?.site_url || st.site_url || pr?.gsc.sites[0]?.site_url || "");
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not reach the API. Is the FastAPI server running?");
      } finally {
        if (!cancelled) setStatusLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function connect() {
    setConnecting(true);
    setError(null);
    try {
      const data = await getJson<{ auth_url: string }>("/auth-url");
      window.location.assign(data.auth_url); // full-page redirect to Google; Google returns to /gsc/callback
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the Google sign-in.");
      setConnecting(false);
    }
  }

  async function sync() {
    if (!site) {
      setError("Choose a Search Console property to sync.");
      return;
    }
    setSyncing(true);
    setError(null);
    setSyncResult(null);
    try {
      const res = await fetch(`${B}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ site_url: site, start_date: range.start, end_date: range.end, compare_previous: compare }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      setSyncResult(await res.json());
      setStatus(await getJson<Status>("/status"));
      onSynced();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sync failed.");
    } finally {
      setSyncing(false);
    }
  }

  async function disconnect() {
    if (!window.confirm("Disconnect Google and delete the stored credentials and synced data?")) return;
    setError(null);
    try {
      const res = await fetch(`${B}/disconnect`, { method: "POST" });
      if (!res.ok) throw new Error(await errorMessage(res));
      setStatus(await res.json());
      setProps(null);
      setSyncResult(null);
      onModeChange("sandbox");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not disconnect.");
    }
  }

  async function chooseGa4(propertyId: string) {
    const p = props?.ga4.properties.find((x) => x.property_id === propertyId);
    if (!p) return;
    try {
      const res = await fetch(`${B}/select`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ga4_property: p.property_id, ga4_name: p.name }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      setStatus(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the GA4 property.");
    }
  }

  const hasData = Boolean(status?.last_sync);
  const syncLabel = status?.last_sync
    ? `${status.last_sync.site_url} · ${status.last_sync.start_date} to ${status.last_sync.end_date} · ${numberFormat.format(status.last_sync.rows_current)} rows`
    : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="gsc-title"
        tabIndex={-1}
        className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl focus:outline-none sm:rounded-2xl"
      >
        <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 id="gsc-title" className="text-base font-semibold text-slate-900">
              Google Search Console &amp; GA4
            </h2>
            <p className="text-sm text-slate-500">Read-only access. Your data is stored on this server only.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            ✕
          </button>
        </header>

        <div className="space-y-5 overflow-y-auto px-5 py-5">
          {/* data mode */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-slate-50 p-3">
            <div>
              <p className="text-sm font-medium text-slate-800">Dashboard data</p>
              <p className="text-xs text-slate-500">{dataMode === "live" ? syncLabel ?? "Live Search Console data" : "Built-in demo data"}</p>
            </div>
            <div role="group" aria-label="Data mode" className="inline-flex rounded-lg bg-slate-200/70 p-1 text-sm font-medium">
              <button
                type="button"
                aria-pressed={dataMode === "sandbox"}
                onClick={() => onModeChange("sandbox")}
                className={`rounded-md px-3 py-1.5 transition ${dataMode === "sandbox" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800"}`}
              >
                Sandbox Demo Mode
              </button>
              <button
                type="button"
                aria-pressed={dataMode === "live"}
                disabled={!hasData}
                title={hasData ? undefined : "Sync your Search Console data first"}
                onClick={() => onModeChange("live")}
                className={`rounded-md px-3 py-1.5 transition disabled:cursor-not-allowed disabled:opacity-40 ${
                  dataMode === "live" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800"
                }`}
              >
                Live Data
              </button>
            </div>
          </div>

          {error && (
            <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-600">
              ⚠️ {error}
            </p>
          )}

          {statusLoading && <p className="text-sm text-slate-500">Checking connection…</p>}

          {/* not configured */}
          {status && !status.configured && (
            <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              <p className="font-semibold">One-time setup needed</p>
              <ol className="list-decimal space-y-1 pl-5">
                <li>In Google Cloud Console, create an OAuth client of type “Web application”.</li>
                <li>
                  Add this authorised redirect URI: <code className="break-all rounded bg-white px-1 py-0.5 font-mono text-xs">{status.redirect_uri}</code>
                </li>
                <li>Enable the “Search Console API” and the “Google Analytics Admin API” for the project.</li>
                <li>
                  Put <code className="font-mono text-xs">GOOGLE_CLIENT_ID</code> and <code className="font-mono text-xs">GOOGLE_CLIENT_SECRET</code> in the backend{" "}
                  <code className="font-mono text-xs">.env</code>, then restart the API.
                </li>
              </ol>
            </div>
          )}

          {/* not connected */}
          {status && status.configured && !status.connected && (
            <div className="space-y-3 rounded-lg border border-slate-200 p-4">
              <p className="text-sm text-slate-700">
                Connect to pull real clicks, impressions, CTR and position into the Cannibalization and Content Decay views. Only read-only permissions are requested.
              </p>
              <button
                type="button"
                onClick={connect}
                disabled={connecting}
                className="rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-60"
              >
                {connecting ? "Redirecting to Google…" : "🔌 Connect Live GSC & GA4 Account"}
              </button>
            </div>
          )}

          {/* connected */}
          {status?.connected && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="flex items-center gap-2 text-sm font-medium text-emerald-700">
                  <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" /> Connected
                  <span className="text-xs font-normal text-slate-400">
                    {status.scopes.gsc ? "Search Console" : ""}
                    {status.scopes.gsc && status.scopes.ga4 ? " + " : ""}
                    {status.scopes.ga4 ? "GA4" : ""}
                  </span>
                </p>
                <button type="button" onClick={disconnect} className="text-xs font-medium text-rose-600 hover:text-rose-800">
                  Disconnect &amp; delete data
                </button>
              </div>

              {!status.scopes.gsc ? (
                <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-800">
                  Search Console access wasn’t granted. Disconnect and connect again, ticking the Search Console permission.
                </p>
              ) : (
                <div className="space-y-3 rounded-lg border border-slate-200 p-4">
                  <label className="block text-sm font-medium text-slate-700">
                    Search Console property
                    <select
                      value={site}
                      onChange={(e) => setSite(e.target.value)}
                      className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-900"
                    >
                      {props?.gsc.sites.length ? null : <option value="">No verified properties found</option>}
                      {props?.gsc.sites.map((s) => (
                        <option key={s.site_url} value={s.site_url}>
                          {s.site_url} ({s.type === "domain" ? "domain" : "URL prefix"})
                        </option>
                      ))}
                    </select>
                  </label>
                  {props?.gsc.error && <p className="text-xs text-rose-600">{props.gsc.error}</p>}

                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block text-sm font-medium text-slate-700">
                      From
                      <input
                        type="date"
                        value={range.start}
                        max={range.end}
                        onChange={(e) => setRange((r) => ({ ...r, start: e.target.value }))}
                        className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900"
                      />
                    </label>
                    <label className="block text-sm font-medium text-slate-700">
                      To
                      <input
                        type="date"
                        value={range.end}
                        min={range.start}
                        max={iso(new Date())}
                        onChange={(e) => setRange((r) => ({ ...r, end: e.target.value }))}
                        className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900"
                      />
                    </label>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {[28, 90].map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setRange(rangeEndingDaysAgo(3, n))}
                        className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200"
                      >
                        Last {n} days
                      </button>
                    ))}
                  </div>
                  <label className="flex items-start gap-2 text-sm text-slate-700">
                    <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600" />
                    <span>
                      Also fetch the previous period of the same length
                      <span className="block text-xs text-slate-400">Needed for the Content Decay analysis.</span>
                    </span>
                  </label>

                  <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                    <p className="text-xs text-slate-500" aria-live="polite">
                      {syncing
                        ? "Syncing from Search Console…"
                        : status.last_sync
                          ? `Last sync ${new Date(status.last_sync.synced_at).toLocaleString()}`
                          : "Not synced yet"}
                    </p>
                    <button
                      type="button"
                      onClick={sync}
                      disabled={syncing || !site}
                      className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-60"
                    >
                      {syncing ? "Syncing…" : "🔄 Sync Now"}
                    </button>
                  </div>

                  {syncResult && (
                    <div className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-900">
                      <p className="font-medium">
                        Synced {numberFormat.format(syncResult.rows_current)} rows
                        {syncResult.rows_previous > 0 && ` (+ ${numberFormat.format(syncResult.rows_previous)} from the previous period)`}.
                      </p>
                      <p className="text-xs">
                        {numberFormat.format(syncResult.totals_current.clicks)} clicks · {numberFormat.format(syncResult.totals_current.impressions)} impressions ·{" "}
                        {(syncResult.totals_current.ctr * 100).toFixed(2)}% CTR · position {syncResult.totals_current.position}
                      </p>
                      <p className="mt-1 text-xs text-emerald-800">{syncResult.note}</p>
                    </div>
                  )}
                </div>
              )}

              {/* GA4 */}
              <div className="rounded-lg border border-slate-200 p-4">
                <p className="text-sm font-medium text-slate-700">GA4 property</p>
                {!status.scopes.ga4 ? (
                  <p className="mt-1 text-xs text-slate-500">Analytics access wasn’t granted.</p>
                ) : props?.ga4.error ? (
                  <p className="mt-1 text-xs text-amber-700">{props.ga4.error}</p>
                ) : (
                  <select
                    value={status.ga4_property ?? ""}
                    onChange={(e) => chooseGa4(e.target.value)}
                    className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                  >
                    <option value="">{props?.ga4.properties.length ? "Select a property…" : "No GA4 properties found"}</option>
                    {props?.ga4.properties.map((p) => (
                      <option key={p.property_id} value={p.property_id}>
                        {p.name} · {p.account} ({p.property_id})
                      </option>
                    ))}
                  </select>
                )}
                <p className="mt-1 text-xs text-slate-400">Your GA4 properties are listed and the selection is saved; GA4 metrics aren’t pulled into the dashboard yet.</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

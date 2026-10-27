"use client";

import { useEffect, useState } from "react";
import {
  API_BASE,
  apiErrorMessage,
  timeAgo,
  toToolRequest,
  type AlertItem,
  type AlertSettings,
  type AlertSeverity,
  type AlertSummary,
} from "./lib/alerts";
import { useToolActions } from "./toolActions";
import { FreshnessChip } from "./evidence";

type StatusFilter = "open" | "resolved" | "all";
type CheckResult = {
  checked_at: string | null;
  ran: Record<string, { status: "ok" | "skipped"; reason?: string }>;
  new_alerts: AlertItem[];
  resolved: number;
  notifications: Record<string, { ok: boolean; skipped?: string; error?: string }>;
};
type Form = Omit<AlertSettings, "slack_configured" | "slack_webhook_masked" | "teams_configured" | "teams_webhook_masked">;
type TestState = { busy: boolean; ok?: boolean; message?: string };

const SEVERITY_STYLES: Record<AlertSeverity, { card: string; badge: string; icon: string; label: string }> = {
  critical: { card: "border-l-rose-500 bg-rose-50/40", badge: "bg-rose-600 text-white", icon: "🔴", label: "Critical" },
  warning: { card: "border-l-amber-500 bg-amber-50/40", badge: "bg-amber-500 text-white", icon: "🟠", label: "Warning" },
  info: { card: "border-l-sky-400 bg-sky-50/40", badge: "bg-sky-500 text-white", icon: "🔵", label: "Info" },
};

const FREQUENCIES: [number, string][] = [
  [0, "Off (run manually)"],
  [15, "Every 15 minutes"],
  [30, "Every 30 minutes"],
  [60, "Hourly"],
  [360, "Every 6 hours"],
  [1440, "Daily"],
];

const CHECK_LABELS: Record<string, string> = {
  volatility: "Volatility",
  cannibalization: "Cannibalization",
  bot_access: "Crawler access",
};

function SliderField({
  id,
  label,
  help,
  min,
  max,
  step = 1,
  value,
  unit,
  onChange,
}: {
  id: string;
  label: string;
  help: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  unit: string;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium text-slate-700">
          {label}
        </label>
        <output htmlFor={id} className="text-sm font-semibold tabular-nums text-indigo-700">
          {value}
          {unit}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full accent-indigo-600"
      />
      <p className="text-xs text-slate-400">{help}</p>
    </div>
  );
}

function Toggle({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
      {label}
    </label>
  );
}

function NumberField({ id, label, help, value, onChange }: { id: string; label: string; help: string; value: number; onChange: (v: number) => void }) {
  return (
    <label htmlFor={id} className="block text-sm font-medium text-slate-700">
      {label}
      <input
        id={id}
        type="number"
        min={0}
        value={value}
        onChange={(e) => onChange(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
        className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
      />
      <span className="mt-0.5 block text-xs font-normal text-slate-400">{help}</span>
    </label>
  );
}

type WebhookRowProps = {
  target: "slack" | "teams";
  label: string;
  configured: boolean;
  masked: string | null;
  input: string;
  onInput: (v: string) => void;
  remove: boolean;
  onRemove: (v: boolean) => void;
  placeholder: string;
  test: TestState;
  onTest: () => void;
};

/** One webhook channel: masked input, saved-state chip and the test button. Kept at module level so typing never remounts it. */
function WebhookRow({ target, label, configured, masked, input, onInput, remove, onRemove, placeholder, test, onTest }: WebhookRowProps) {
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={`wh-${target}`} className="text-sm font-medium text-slate-700">
          {label} webhook
        </label>
        {configured && !remove && <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-600/20">Saved: {masked}</span>}
        {remove && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">Will be removed on save</span>}
      </div>
      <input
        id={`wh-${target}`}
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={input}
        onChange={(e) => onInput(e.target.value)}
        placeholder={configured ? "Paste a new URL to replace the saved one" : placeholder}
        className="mt-2 block w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs text-slate-900 placeholder:font-sans placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onTest}
          disabled={test.busy || (!input.trim() && !configured)}
          className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-slate-700 ring-1 ring-inset ring-slate-300 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {test.busy ? "Sending…" : "🔔 Test Webhook"}
        </button>
        {configured && (
          <button type="button" onClick={() => onRemove(!remove)} className="text-xs font-medium text-slate-500 hover:text-rose-600">
            {remove ? "Keep it" : "Remove saved URL"}
          </button>
        )}
        {test.message && (
          <span role="status" className={`text-xs ${test.ok ? "text-emerald-700" : "text-rose-600"}`}>
            {test.ok ? "✓" : "⚠"} {test.message}
          </span>
        )}
      </div>
    </div>
  );
}

type Props = {
  /** Bumped by the dashboard when something outside the panel changed the alerts (e.g. an automatic check). */
  version: number;
  /** Tell the dashboard (and the bell) that alerts changed. */
  onChanged: () => void;
};

export default function AlertingPanel({ version, onChanged }: Props) {
  const { openTool } = useToolActions();

  const [items, setItems] = useState<AlertItem[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<AlertSummary | null>(null);
  const [feedLoading, setFeedLoading] = useState(true);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open");
  const [severityFilter, setSeverityFilter] = useState<AlertSeverity | "all">("all");
  const [reloadTick, setReloadTick] = useState(0);

  const [settings, setSettings] = useState<AlertSettings | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [slackInput, setSlackInput] = useState("");
  const [teamsInput, setTeamsInput] = useState("");
  const [removeSlack, setRemoveSlack] = useState(false);
  const [removeTeams, setRemoveTeams] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [tests, setTests] = useState<Record<"slack" | "teams", TestState>>({ slack: { busy: false }, teams: { busy: false } });

  const [checking, setChecking] = useState(false);
  const [notifyOnCheck, setNotifyOnCheck] = useState(true);
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);

  // ---- load settings once
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/settings`);
        if (!res.ok) throw new Error(await apiErrorMessage(res));
        const s: AlertSettings = await res.json();
        if (cancelled) return;
        setSettings(s);
        setForm(toForm(s));
      } catch (e) {
        if (!cancelled) setSettingsError(e instanceof Error ? e.message : "Could not load alert settings. Is the FastAPI server running?");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- load the feed (filters, reloads and outside changes)
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const qs = new URLSearchParams({ status: statusFilter, severity: severityFilter, limit: "100" });
        const res = await fetch(`${API_BASE}/history?${qs}`, { signal: controller.signal });
        if (!res.ok) throw new Error(await apiErrorMessage(res));
        const data: { items: AlertItem[]; total: number; summary: AlertSummary } = await res.json();
        setItems(data.items);
        setTotal(data.total);
        setSummary(data.summary);
        setFeedError(null);
      } catch (e) {
        if (controller.signal.aborted) return;
        setFeedError(e instanceof Error ? e.message : "Could not load alerts. Is the FastAPI server running?");
      } finally {
        if (!controller.signal.aborted) setFeedLoading(false);
      }
    })();
    return () => controller.abort();
  }, [statusFilter, severityFilter, reloadTick, version]);

  function toForm(s: AlertSettings): Form {
    return {
      position_drop: s.position_drop,
      traffic_drop_pct: s.traffic_drop_pct,
      ctr_drop_pct: s.ctr_drop_pct,
      min_query_impressions: s.min_query_impressions,
      cannibalization_min_impressions: s.cannibalization_min_impressions,
      check_volatility: s.check_volatility,
      check_cannibalization: s.check_cannibalization,
      check_bot_access: s.check_bot_access,
      monitor_url: s.monitor_url,
      notify_min_severity: s.notify_min_severity,
      auto_check_minutes: s.auto_check_minutes,
    };
  }

  const setField = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((f) => (f ? { ...f, [k]: v } : f));
    setSaved(false);
  };

  function reload() {
    setReloadTick((n) => n + 1);
    onChanged();
  }

  async function runCheck() {
    setChecking(true);
    setCheckError(null);
    try {
      const res = await fetch(`${API_BASE}/check`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notify: notifyOnCheck }) });
      if (!res.ok) throw new Error(await apiErrorMessage(res));
      setCheckResult(await res.json());
      setStatusFilter("open");
      reload();
    } catch (e) {
      setCheckError(e instanceof Error ? e.message : "The check failed. Is the FastAPI server running?");
    } finally {
      setChecking(false);
    }
  }

  async function markRead(body: { ids?: number[]; all?: boolean }) {
    try {
      await fetch(`${API_BASE}/read`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    } finally {
      reload();
    }
  }

  async function saveSettings() {
    if (!form) return;
    setSaving(true);
    setSettingsError(null);
    const webhook = (input: string, remove: boolean) => (input.trim() ? input.trim() : remove ? "" : null); // null = leave the saved URL as it is
    try {
      const res = await fetch(`${API_BASE}/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, slack_webhook_url: webhook(slackInput, removeSlack), teams_webhook_url: webhook(teamsInput, removeTeams) }),
      });
      if (!res.ok) throw new Error(await apiErrorMessage(res));
      const s: AlertSettings = await res.json();
      setSettings(s);
      setForm(toForm(s));
      setSlackInput("");
      setTeamsInput("");
      setRemoveSlack(false);
      setRemoveTeams(false);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
      onChanged();
    } catch (e) {
      setSettingsError(e instanceof Error ? e.message : "Could not save the settings.");
    } finally {
      setSaving(false);
    }
  }

  async function testWebhook(target: "slack" | "teams") {
    const typed = (target === "slack" ? slackInput : teamsInput).trim();
    setTests((t) => ({ ...t, [target]: { busy: true } }));
    try {
      const res = await fetch(`${API_BASE}/test-webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target, url: typed || undefined }),
      });
      if (!res.ok) throw new Error(await apiErrorMessage(res));
      const data: { ok: boolean; error?: string } = await res.json();
      setTests((t) => ({ ...t, [target]: { busy: false, ok: data.ok, message: data.ok ? "Test message delivered." : (data.error ?? "The webhook did not accept the message.") } }));
    } catch (e) {
      setTests((t) => ({ ...t, [target]: { busy: false, ok: false, message: e instanceof Error ? e.message : "Could not send the test." } }));
    }
  }

  const unread = items.filter((a) => !a.read && a.status === "open").length;

  return (
    <section aria-labelledby="alerts-heading" className="space-y-5">
      {/* header + run check */}
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="alerts-heading" className="text-lg font-semibold text-slate-900">
              Alerts &amp; Notifications
            </h2>
            <p className="text-sm text-slate-500">
              Watches your synced Search Console data and crawler access, and posts to Slack or Teams when something moves. Last check:{" "}
              <span className="font-medium text-slate-700">{timeAgo(summary?.last_check ?? null)}</span>
            </p>
            <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
              Search Console <FreshnessChip source="gsc" /> Crawl check <FreshnessChip source="crawl" />
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Toggle id="notify-on-check" label="Notify webhooks" checked={notifyOnCheck} onChange={setNotifyOnCheck} />
            <button
              type="button"
              onClick={runCheck}
              disabled={checking}
              className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-60"
            >
              {checking ? "Checking…" : "▶ Run check now"}
            </button>
          </div>
        </div>
        {checkError && (
          <p role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-600">
            ⚠️ {checkError}
          </p>
        )}
        {checkResult && (
          <div className="mt-3 space-y-2 rounded-lg bg-slate-50 p-3 text-sm">
            <p className="text-slate-800">
              <span className="font-semibold">{checkResult.new_alerts.length}</span> new alert{checkResult.new_alerts.length === 1 ? "" : "s"} ·{" "}
              <span className="font-semibold">{checkResult.resolved}</span> resolved
            </p>
            <ul className="flex flex-wrap gap-2 text-xs">
              {Object.entries(checkResult.ran).map(([k, v]) => (
                <li
                  key={k}
                  title={v.reason}
                  className={`rounded-full px-2.5 py-1 font-medium ring-1 ring-inset ${
                    v.status === "ok" ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20" : "bg-slate-100 text-slate-500 ring-slate-500/20"
                  }`}
                >
                  {CHECK_LABELS[k] ?? k}: {v.status === "ok" ? "checked" : `skipped${v.reason ? ` (${v.reason})` : ""}`}
                </li>
              ))}
            </ul>
            {Object.entries(checkResult.notifications).some(([, n]) => n.ok || n.error) && (
              <p className="text-xs text-slate-500">
                {Object.entries(checkResult.notifications)
                  .filter(([, n]) => n.ok || n.error)
                  .map(([k, n]) => `${k}: ${n.ok ? "sent" : `failed (${n.error})`}`)
                  .join(" · ")}
              </p>
            )}
          </div>
        )}
      </div>

      {/* feed */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3">
          <h3 className="font-semibold text-slate-900">
            Alert feed <span className="text-sm font-normal text-slate-400">({total})</span>
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            <div role="group" aria-label="Alert status" className="inline-flex rounded-lg bg-slate-100 p-0.5 text-xs font-medium">
              {(["open", "resolved", "all"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  aria-pressed={statusFilter === f}
                  onClick={() => {
                    setFeedLoading(true);
                    setStatusFilter(f);
                  }}
                  className={`rounded-md px-3 py-1.5 capitalize transition ${statusFilter === f ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800"}`}
                >
                  {f}
                </button>
              ))}
            </div>
            <label className="sr-only" htmlFor="alert-severity">
              Severity
            </label>
            <select
              id="alert-severity"
              value={severityFilter}
              onChange={(e) => {
                setFeedLoading(true);
                setSeverityFilter(e.target.value as AlertSeverity | "all");
              }}
              className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-700"
            >
              <option value="all">All severities</option>
              <option value="critical">Critical</option>
              <option value="warning">Warning</option>
              <option value="info">Info</option>
            </select>
            {unread > 0 && (
              <button type="button" onClick={() => markRead({ all: true })} className="text-xs font-medium text-indigo-600 hover:text-indigo-800">
                Mark all read
              </button>
            )}
          </div>
        </div>

        <div className="space-y-3 p-5">
          {feedLoading && <p className="text-sm text-slate-500">Loading alerts…</p>}
          {feedError && (
            <p role="alert" className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
              {feedError}
            </p>
          )}
          {!feedLoading && !feedError && items.length === 0 && (
            <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
              {statusFilter === "open" ? "No open alerts. Run a check after syncing your Search Console data." : "No alerts match these filters."}
            </p>
          )}
          {items.map((a) => {
            const sev = SEVERITY_STYLES[a.severity];
            return (
              <article key={a.id} className={`rounded-lg border border-slate-200 border-l-4 p-4 ${sev.card} ${a.status === "resolved" ? "opacity-70" : ""}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${sev.badge}`}>
                      {sev.icon} {sev.label}
                    </span>
                    {!a.read && a.status === "open" && <span className="h-2 w-2 rounded-full bg-indigo-600" title="Unread" aria-label="Unread" />}
                    {a.status === "resolved" && <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">Resolved {timeAgo(a.resolved_at)}</span>}
                    <h4 className="font-semibold text-slate-900">{a.title}</h4>
                  </div>
                  <span className="shrink-0 text-xs text-slate-400" title={`First seen ${a.created_at}`}>
                    {timeAgo(a.last_seen_at)}
                  </span>
                </div>
                <p className="mt-1.5 break-words text-sm leading-relaxed text-slate-700">{a.detail}</p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {a.action && a.status === "open" && (
                    <button
                      type="button"
                      onClick={() => openTool(toToolRequest(a.action!))}
                      className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2"
                    >
                      {a.action.label} →
                    </button>
                  )}
                  {!a.read && a.status === "open" && (
                    <button type="button" onClick={() => markRead({ ids: [a.id] })} className="text-xs font-medium text-slate-500 hover:text-slate-800">
                      Mark read
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </div>

      {/* settings */}
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="font-semibold text-slate-900">Notification channels</h3>
        <p className="text-sm text-slate-500">
          Webhook URLs are secrets: they are encrypted on the server and never shown in full again. Only real Slack and Microsoft Teams webhook addresses are accepted.
        </p>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          {settings ? (
            <>
              <WebhookRow
                target="slack"
                label="Slack"
                configured={settings.slack_configured}
                masked={settings.slack_webhook_masked}
                input={slackInput}
                onInput={(v) => {
                  setSlackInput(v);
                  setSaved(false);
                }}
                remove={removeSlack}
                onRemove={setRemoveSlack}
                placeholder="https://hooks.slack.com/services/…"
                test={tests.slack}
                onTest={() => testWebhook("slack")}
              />
              <WebhookRow
                target="teams"
                label="Microsoft Teams"
                configured={settings.teams_configured}
                masked={settings.teams_webhook_masked}
                input={teamsInput}
                onInput={(v) => {
                  setTeamsInput(v);
                  setSaved(false);
                }}
                remove={removeTeams}
                onRemove={setRemoveTeams}
                placeholder="https://…webhook.office.com/… or a Power Automate URL"
                test={tests.teams}
                onTest={() => testWebhook("teams")}
              />
            </>
          ) : (
            !settingsError && <p className="text-sm text-slate-500">Loading settings…</p>
          )}
        </div>

        {form && (
          <>
            <h3 className="mt-6 font-semibold text-slate-900">Thresholds</h3>
            <div className="mt-3 grid gap-x-8 gap-y-5 md:grid-cols-2">
              <SliderField id="th-pos" label="Position drop" help="Alert when a query's average position gets this many places worse." min={1} max={30} value={form.position_drop} unit=" places" onChange={(v) => setField("position_drop", v)} />
              <SliderField id="th-traffic" label="Traffic drop" help="Alert when clicks or impressions fall by more than this versus the previous period." min={5} max={80} step={5} value={form.traffic_drop_pct} unit="%" onChange={(v) => setField("traffic_drop_pct", v)} />
              <SliderField id="th-ctr" label="CTR decrease" help="Alert when overall click-through rate falls by this much (relative)." min={5} max={80} step={5} value={form.ctr_drop_pct} unit="%" onChange={(v) => setField("ctr_drop_pct", v)} />
              <NumberField id="th-minq" label="Ignore queries under (impressions)" help="Position checks skip queries with fewer impressions last period." value={form.min_query_impressions} onChange={(v) => setField("min_query_impressions", v)} />
              <NumberField id="th-cannib" label="Cannibalization threshold (impressions)" help="A URL needs at least this many impressions to count as competing for a query." value={form.cannibalization_min_impressions} onChange={(v) => setField("cannibalization_min_impressions", Math.max(1, v))} />
              <label htmlFor="th-severity" className="block text-sm font-medium text-slate-700">
                Notify webhooks for
                <select
                  id="th-severity"
                  value={form.notify_min_severity}
                  onChange={(e) => setField("notify_min_severity", e.target.value as AlertSeverity)}
                  className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-900"
                >
                  <option value="critical">Critical only</option>
                  <option value="warning">Warning and above</option>
                  <option value="info">Everything</option>
                </select>
              </label>
            </div>

            <h3 className="mt-6 font-semibold text-slate-900">What to check</h3>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <Toggle id="chk-vol" label="Volatility (traffic, CTR, positions)" checked={form.check_volatility} onChange={(v) => setField("check_volatility", v)} />
                <Toggle id="chk-can" label="New cannibalization splits" checked={form.check_cannibalization} onChange={(v) => setField("check_cannibalization", v)} />
                <Toggle id="chk-bot" label="LLM crawler access (HTTP status and robots.txt)" checked={form.check_bot_access} onChange={(v) => setField("check_bot_access", v)} />
              </div>
              <div className="space-y-3">
                <label htmlFor="th-freq" className="block text-sm font-medium text-slate-700">
                  Automatic check frequency
                  <select
                    id="th-freq"
                    value={form.auto_check_minutes}
                    onChange={(e) => setField("auto_check_minutes", Number(e.target.value))}
                    className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-900"
                  >
                    {FREQUENCIES.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                  <span className="mt-0.5 block text-xs font-normal text-slate-400">Runs all enabled checks, crawler access included, only while this dashboard is open in a browser.</span>
                </label>
                <label htmlFor="th-monitor" className="block text-sm font-medium text-slate-700">
                  Page to test for crawler access
                  <input
                    id="th-monitor"
                    type="text"
                    inputMode="url"
                    value={form.monitor_url}
                    onChange={(e) => setField("monitor_url", e.target.value)}
                    placeholder="Blank = your synced Search Console site"
                    className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                  />
                </label>
              </div>
            </div>
          </>
        )}

        {settingsError && (
          <p role="alert" className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-600">
            ⚠️ {settingsError}
          </p>
        )}
        <div className="mt-5 flex items-center justify-end gap-3">
          {saved && (
            <span role="status" className="text-sm font-medium text-emerald-700">
              Saved ✓
            </span>
          )}
          <button
            type="button"
            onClick={saveSettings}
            disabled={saving || !form}
            className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save settings"}
          </button>
        </div>
      </div>
    </section>
  );
}

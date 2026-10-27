"use client";

import { useEffect, useMemo, useState } from "react";
import { currentWindow, previousWindow } from "./lib/decaySample";
import { FORECAST_API, forecastError, type AggPoint, type BatchForecast, type PageForecast, type PageIn } from "./lib/forecast";
import { useToolActions } from "./toolActions";
import { InfoTip, ScoreDisclaimer, SyncStamp, ThirdPartyBadge } from "./Guardrails";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8010";
const nf = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const fmt = (n: number) => nf.format(Math.round(n));

type DecayRow = {
  url: string;
  prior_impressions: number;
  current_impressions: number;
  prior_clicks: number;
  current_clicks: number;
  prior_position: number | null;
  current_position: number | null;
  top_queries: { query: string }[];
};

type Source = "sandbox" | "live";
type SortKey = "loss" | "score";

const PERIOD_OPTIONS = [7, 14, 28, 30, 60, 90];

/**
 * The decay analysis gives two periods per page; that is the history the forecast starts from.
 * A page that has no impressions at all now has no position and nothing left to project, so it is reported separately
 * ("gone") rather than silently dropped: losing everything is the worst decay there is.
 */
function toPages(rows: DecayRow[], periodDays: number): { pages: PageIn[]; gone: string[] } {
  const pages: PageIn[] = [];
  const gone: string[] = [];
  for (const d of rows) {
    if (d.prior_position === null) continue;
    if (d.current_position === null) {
      gone.push(d.url);
      continue;
    }
    pages.push({
      url: d.url,
      keyword: d.top_queries[0]?.query ?? "",
      period_days: periodDays,
      history: [
        { clicks: d.prior_clicks, position: Math.max(1, d.prior_position), impressions: d.prior_impressions },
        { clicks: d.current_clicks, position: Math.max(1, d.current_position), impressions: d.current_impressions },
      ],
    });
  }
  return { pages, gone };
}

function niceMax(v: number): number {
  if (v <= 0) return 10;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * pow) return m * pow;
  return 10 * pow;
}

const CONFIDENCE_STYLES = {
  low: "bg-amber-50 text-amber-700 ring-amber-600/20",
  medium: "bg-sky-50 text-sky-700 ring-sky-600/20",
  high: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
};
const TIER_STYLES = {
  "Act now": { bar: "bg-rose-500", text: "text-rose-700" },
  "Plan a refresh": { bar: "bg-amber-500", text: "text-amber-700" },
  Monitor: { bar: "bg-slate-400", text: "text-slate-500" },
};

function velocityLabel(v: number): string {
  return v <= 0.6 ? "Conservative" : v < 1.4 ? "Expected" : v < 2.2 ? "Aggressive" : "Severe";
}

function ForecastChart({ curve, title }: { curve: AggPoint[]; title: string }) {
  const [hover, setHover] = useState<number | null>(null);
  if (curve.length === 0) return null;
  const W = 640;
  const H = 300;
  const L = 58;
  const R = 16;
  const T = 18;
  const B = 36;
  const maxY = niceMax(Math.max(...curve.flatMap((p) => [p.baseline_high, p.refreshed, p.baseline])));
  const x = (day: number) => L + (day / 90) * (W - L - R);
  const y = (v: number) => T + (1 - v / maxY) * (H - T - B);
  const line = (key: "baseline" | "refreshed") => curve.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.day).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ");
  const band =
    curve.map((p) => `${x(p.day).toFixed(1)},${y(p.baseline_high).toFixed(1)}`).join(" ") +
    " " +
    [...curve].reverse().map((p) => `${x(p.day).toFixed(1)},${y(p.baseline_low).toFixed(1)}`).join(" ");
  const now = curve[0].baseline;
  const hp = hover === null ? null : curve.find((p) => p.day === hover) ?? null;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`${title}: projected clicks per 30 days over the next 90 days. Do nothing falls from ${fmt(curve[0].baseline)} to ${fmt(curve[curve.length - 1].baseline)}; a refresh reaches ${fmt(curve[curve.length - 1].refreshed)}.`}
      className="w-full select-none"
      onMouseLeave={() => setHover(null)}
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const px = ((e.clientX - r.left) / r.width) * W;
        const day = Math.round((((px - L) / (W - L - R)) * 90) / 5) * 5;
        setHover(Math.max(0, Math.min(90, day)));
      }}
    >
      {[0, 0.25, 0.5, 0.75, 1].map((f) => (
        <g key={f}>
          <line x1={L} x2={W - R} y1={y(maxY * f)} y2={y(maxY * f)} className="stroke-slate-100" />
          <text x={L - 8} y={y(maxY * f) + 4} textAnchor="end" className="fill-slate-400 text-[11px]">
            {fmt(maxY * f)}
          </text>
        </g>
      ))}
      {[0, 30, 60, 90].map((d) => (
        <text key={d} x={x(d)} y={H - 12} textAnchor="middle" className="fill-slate-500 text-[11px]">
          {d === 0 ? "Today" : `+${d}d`}
        </text>
      ))}
      <polygon points={band} className="fill-rose-200/60 stroke-rose-300" strokeDasharray="3 3" />
      <text x={x(90) - 4} y={y(curve[curve.length - 1].baseline_high) - 5} textAnchor="end" className="fill-rose-700 text-[10px] font-medium">
        High case {fmt(curve[curve.length - 1].baseline_high)}
      </text>
      <text x={x(90) - 4} y={y(curve[curve.length - 1].baseline_low) + 13} textAnchor="end" className="fill-rose-700 text-[10px] font-medium">
        Low case {fmt(curve[curve.length - 1].baseline_low)}
      </text>
      <line x1={x(0)} x2={x(90)} y1={y(now)} y2={y(now)} className="stroke-slate-300" strokeDasharray="4 4" />
      <path d={line("baseline")} fill="none" className="stroke-rose-500" strokeWidth="2.5" />
      <path d={line("refreshed")} fill="none" className="stroke-emerald-500" strokeWidth="2.5" />
      {[0, 30, 60, 90].map((d) => {
        const p = curve.find((q) => q.day === d);
        return p ? (
          <g key={d}>
            <circle cx={x(d)} cy={y(p.baseline)} r="4" className="fill-white stroke-rose-500" strokeWidth="2" />
            <circle cx={x(d)} cy={y(p.refreshed)} r="4" className="fill-white stroke-emerald-500" strokeWidth="2" />
          </g>
        ) : null;
      })}
      {hp && (
        <g>
          <line x1={x(hp.day)} x2={x(hp.day)} y1={T} y2={H - B} className="stroke-slate-400" strokeDasharray="3 3" />
          <rect x={Math.min(x(hp.day) + 8, W - R - 170)} y={T + 4} width="170" height="46" rx="6" className="fill-slate-900/90" />
          <text x={Math.min(x(hp.day) + 8, W - R - 170) + 10} y={T + 20} className="fill-white text-[11px] font-semibold">
            {hp.day === 0 ? "Today" : `Day ${hp.day}`}
          </text>
          <text x={Math.min(x(hp.day) + 8, W - R - 170) + 10} y={T + 34} className="fill-rose-300 text-[11px]">
            Do nothing: {fmt(hp.baseline)}
          </text>
          <text x={Math.min(x(hp.day) + 8, W - R - 170) + 10} y={T + 46} className="fill-emerald-300 text-[11px]">
            Refreshed: {fmt(hp.refreshed)}
          </text>
        </g>
      )}
    </svg>
  );
}

function SliderRow({ id, label, value, min, max, step, display, onChange, help }: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (v: number) => void;
  help: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium text-slate-700">
          {label}
        </label>
        <output htmlFor={id} className="text-sm font-semibold tabular-nums text-indigo-700">
          {display}
        </output>
      </div>
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="mt-1 w-full accent-indigo-600" />
      <p className="text-xs text-slate-400">{help}</p>
    </div>
  );
}

type ManualRow = { clicks: string; position: string };

export default function ForecastingPanel({ liveLabel }: { liveLabel?: string }) {
  const { openTool } = useToolActions();

  const [source, setSource] = useState<Source>(liveLabel ? "live" : "sandbox");
  const [sourcePages, setSourcePages] = useState<PageIn[]>([]);
  const [gonePages, setGonePages] = useState<string[]>([]);
  const [sourceLoading, setSourceLoading] = useState(true);
  const [sourceError, setSourceError] = useState<string | null>(null);

  const [manual, setManual] = useState<PageIn[]>([]);
  const [velocity, setVelocity] = useState(1);
  const [recovery, setRecovery] = useState(0.6);

  const [batch, setBatch] = useState<BatchForecast | null>(null);
  const [forecasting, setForecasting] = useState(true);
  const [forecastErr, setForecastErr] = useState<string | null>(null);

  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortKey>("loss");
  const [showStable, setShowStable] = useState(false);

  const [formOpen, setFormOpen] = useState(false);
  const [mUrl, setMUrl] = useState("");
  const [mKeyword, setMKeyword] = useState("");
  const [mVolume, setMVolume] = useState("");
  const [mPeriod, setMPeriod] = useState(28);
  const [mRows, setMRows] = useState<ManualRow[]>([{ clicks: "", position: "" }, { clicks: "", position: "" }, { clicks: "", position: "" }]);
  const [mError, setMError] = useState<string | null>(null);

  // ---- 1. the pages to forecast: the decay analysis of the sandbox data or of the synced Search Console data
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        let rows: DecayRow[];
        let days = 30;
        if (source === "live") {
          const [res, st] = await Promise.all([fetch(`${API_URL}/api/v1/gsc/decay`, { signal: controller.signal }), fetch(`${API_URL}/api/v1/gsc/status`, { signal: controller.signal })]);
          if (!res.ok) throw new Error(await forecastError(res));
          rows = (await res.json()).decayed;
          const sync = st.ok ? (await st.json()).last_sync : null;
          if (sync) days = Math.max(7, Math.round((Date.parse(sync.end_date) - Date.parse(sync.start_date)) / 86_400_000) + 1);
        } else {
          const res = await fetch(`${API_URL}/api/v1/analyze-decay`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ previous: previousWindow, current: currentWindow }),
            signal: controller.signal,
          });
          if (!res.ok) throw new Error(await forecastError(res));
          rows = (await res.json()).decayed;
        }
        const { pages, gone } = toPages(rows, days);
        setSourcePages(pages);
        setGonePages(gone);
        setSourceError(null);
      } catch (e) {
        if (controller.signal.aborted) return;
        setSourcePages([]);
        setGonePages([]);
        setSourceError(e instanceof Error ? e.message : "Could not reach the analysis API. Is the FastAPI server running?");
      } finally {
        if (!controller.signal.aborted) setSourceLoading(false);
      }
    })();
    return () => controller.abort();
  }, [source]);

  const allPages = useMemo(() => [...manual, ...sourcePages], [manual, sourcePages]);

  // ---- 2. the forecast, recomputed (debounced) whenever the pages or the scenario change
  useEffect(() => {
    if (allPages.length === 0) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setForecasting(true);
      try {
        const res = await fetch(`${FORECAST_API}/batch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pages: allPages, velocity_multiplier: velocity, recovery_pct: recovery }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(await forecastError(res));
        setBatch(await res.json());
        setForecastErr(null);
      } catch (e) {
        if (controller.signal.aborted) return;
        setForecastErr(e instanceof Error ? e.message : "Could not reach the forecasting API.");
      } finally {
        if (!controller.signal.aborted) setForecasting(false);
      }
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [allPages, velocity, recovery]);

  const result = allPages.length > 0 ? batch : null;
  const manualUrls = useMemo(() => new Set(manual.map((m) => m.url)), [manual]);

  const rows: PageForecast[] = useMemo(() => {
    if (!result) return [];
    const list = result.pages.filter((p) => showStable || p.status === "decaying");
    return sortBy === "score" ? [...list].sort((a, b) => b.action_score - a.action_score || b.losses.d90 - a.losses.d90) : list;
  }, [result, showStable, sortBy]);

  const selected = result?.pages.find((p) => p.url === selectedUrl) ?? null;
  const chartCurve: AggPoint[] = selected ? selected.curve : (result?.curve ?? []);
  const chartPoints: AggPoint[] = selected ? selected.points : (result?.points ?? []);
  const notDecaying = result ? result.pages.filter((p) => p.status !== "decaying").length : 0;
  const lowConfidence = result ? result.pages.filter((p) => p.status === "decaying" && p.confidence === "low").length : 0;

  function switchSource(next: Source) {
    if (next === source) return;
    setSourceLoading(true);
    setSourceError(null);
    setSelectedUrl(null);
    setSource(next);
  }

  function addManual(e: React.FormEvent) {
    e.preventDefault();
    const history = mRows
      .filter((r) => r.clicks.trim() !== "" || r.position.trim() !== "")
      .map((r) => ({ clicks: Number(r.clicks), position: Number(r.position) }));
    if (!mUrl.trim()) return setMError("Enter the page URL.");
    if (history.length < 2) return setMError("Enter at least two periods (oldest first).");
    if (history.some((h) => !Number.isFinite(h.clicks) || h.clicks < 0)) return setMError("Clicks must be zero or more in every period.");
    if (history.some((h) => !Number.isFinite(h.position) || h.position < 1 || h.position > 1000)) return setMError("Average position must be 1 or higher in every period.");
    const vol = mVolume.trim() === "" ? undefined : Number(mVolume.replace(/,/g, ""));
    if (vol !== undefined && (!Number.isFinite(vol) || vol < 0)) return setMError("Search volume must be a number, or left blank.");
    setMError(null);
    const page: PageIn = { url: mUrl.trim(), keyword: mKeyword.trim(), keyword_volume: vol, period_days: mPeriod, history };
    setManual((prev) => [page, ...prev.filter((p) => p.url !== page.url)].slice(0, 20));
    setForecasting(true);
    setSelectedUrl(page.url);
    setMUrl("");
    setMKeyword("");
  }

  const t = result?.totals;

  return (
    <section aria-labelledby="forecast-heading" className="space-y-5">
      {/* header + source */}
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="forecast-heading" className="text-lg font-semibold text-slate-900">
              Predictive Decay Forecast
            </h2>
            <p className="text-sm text-slate-500">Projects where each decaying page’s clicks are heading over the next 90 days, with and without a content refresh.</p>
          </div>
          <div role="group" aria-label="Data source" className="inline-flex shrink-0 rounded-lg bg-slate-100 p-1 text-sm font-medium">
            {(
              [
                ["sandbox", "Sandbox Demo Data"],
                ...(liveLabel ? [["live", "Live GSC"]] : []),
              ] as [Source, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={source === key}
                onClick={() => switchSource(key)}
                className={`rounded-md px-3 py-1.5 transition ${source === key ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800"}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <SyncStamp live={source === "live" && Boolean(liveLabel)} className="mt-3" />
        <ScoreDisclaimer className="mt-3" />
      </div>

      {sourceError && (
        <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          {sourceError}
        </p>
      )}
      {gonePages.length > 0 && (
        <div role="status" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-semibold">
            {gonePages.length} page{gonePages.length === 1 ? " has" : "s have"} lost all of {gonePages.length === 1 ? "its" : "their"} impressions
          </p>
          <p className="mt-0.5 text-amber-800">
            There is nothing left to project for {gonePages.length === 1 ? "it" : "them"}, so {gonePages.length === 1 ? "it is" : "they are"} not in the forecast. This is usually a removed, redirected or deindexed page, so check that first:
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 font-mono text-xs">
            {gonePages.slice(0, 5).map((u) => (
              <li key={u} className="break-all">
                {u}
              </li>
            ))}
            {gonePages.length > 5 && <li className="font-sans">…and {gonePages.length - 5} more</li>}
          </ul>
        </div>
      )}
      {sourceLoading && allPages.length === 0 && <p className="p-2 text-sm text-slate-500">Loading decaying pages…</p>}
      {!sourceLoading && !sourceError && allPages.length === 0 && (
        <p className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-500 shadow-sm">No decaying pages to forecast in this data. You can still forecast a page manually below.</p>
      )}
      {forecastErr && (
        <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          {forecastErr}
        </p>
      )}

      {result && t && (
        <>
          {/* summary + scenario */}
          <div className="grid gap-4 lg:grid-cols-5">
            <div className="rounded-xl border border-rose-200 bg-gradient-to-br from-rose-50 to-white p-5 shadow-sm lg:col-span-3" aria-busy={forecasting}>
              <p className="text-xs font-semibold uppercase tracking-wide text-rose-700">
                Projected 90-day traffic at risk
                <InfoTip text="A what-if estimate from each page's recent ranking trend, with search demand assumed constant. It is not a traffic prediction. The chart shows the low and high range." />
              </p>
              <p className="mt-1 text-4xl font-semibold tracking-tight text-slate-900">
                {fmt(t.loss_90d)} <span className="text-lg font-normal text-slate-500">clicks</span>
              </p>
              <p className="mt-1 text-sm text-slate-600">
                across {t.decaying} decaying page{t.decaying === 1 ? "" : "s"} that earn {fmt(t.clicks_now_30d)} clicks a month today
                {t.clicks_now_30d > 0 && <> ({((t.loss_90d / (t.clicks_now_30d * 3)) * 100).toFixed(0)}% of the next 90 days’ traffic)</>}
              </p>
              <dl className="mt-4 grid grid-cols-3 gap-3 text-sm">
                <div className="rounded-lg bg-white/70 p-3 ring-1 ring-rose-100">
                  <dt className="text-xs text-slate-500">Lost by day 30</dt>
                  <dd className="font-semibold text-slate-900">{fmt(t.loss_30d)}</dd>
                </div>
                <div className="rounded-lg bg-white/70 p-3 ring-1 ring-rose-100">
                  <dt className="text-xs text-slate-500">Lost by day 60</dt>
                  <dd className="font-semibold text-slate-900">{fmt(t.loss_60d)}</dd>
                </div>
                <div className="rounded-lg bg-emerald-50 p-3 ring-1 ring-emerald-200">
                  <dt className="text-xs text-emerald-700">Recoverable with refreshes</dt>
                  <dd className="font-semibold text-emerald-800">{fmt(t.recoverable_90d)}</dd>
                </div>
              </dl>
              {lowConfidence > 0 && (
                <p className="mt-3 text-xs text-amber-700">
                  {lowConfidence} of {t.decaying} forecasts are low confidence (usually only two periods of history), so treat them as a direction, not a promise.
                </p>
              )}
            </div>

            <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm lg:col-span-2">
              <h3 className="font-semibold text-slate-900">Scenario simulator</h3>
              <div className="flex flex-wrap gap-1.5">
                {(
                  [
                    ["Conservative", 0.5],
                    ["Expected", 1],
                    ["Aggressive", 2],
                  ] as const
                ).map(([label, v]) => (
                  <button
                    key={label}
                    type="button"
                    aria-pressed={velocity === v}
                    onClick={() => setVelocity(v)}
                    className={`rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset transition ${velocity === v ? "bg-indigo-600 text-white ring-indigo-600" : "bg-white text-slate-600 ring-slate-300 hover:bg-slate-50"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <SliderRow
                id="fc-velocity"
                label="Decay velocity"
                value={velocity}
                min={0.25}
                max={3}
                step={0.25}
                display={`${velocity.toFixed(2).replace(/\.?0+$/, "")}× · ${velocityLabel(velocity)}`}
                onChange={setVelocity}
                help="Multiplies how fast positions are assumed to keep eroding (1× = the observed trend)."
              />
              <SliderRow
                id="fc-recovery"
                label="Refresh effectiveness"
                value={recovery}
                min={0.2}
                max={1}
                step={0.1}
                display={`${Math.round(recovery * 100)}% of lost ground`}
                onChange={setRecovery}
                help="How much of the lost ranking a refresh wins back, once it is live (about 2 weeks) and settled (about a month)."
              />
            </div>
          </div>

          {/* chart */}
          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="font-semibold text-slate-900">Clicks per 30 days, next 90 days</h3>
                <p className="text-xs text-slate-500">{selected ? <span className="break-all">{selected.url}</span> : `All ${t.decaying} decaying pages combined`}</p>
              </div>
              {selected && (
                <button type="button" onClick={() => setSelectedUrl(null)} className="text-sm font-medium text-indigo-600 hover:text-indigo-800">
                  Show all pages
                </button>
              )}
            </div>
            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
              <li className="flex items-center gap-1.5">
                <span className="h-0.5 w-5 bg-rose-500" aria-hidden="true" /> Do nothing
              </li>
              <li className="flex items-center gap-1.5">
                <span className="h-3 w-5 rounded-sm bg-rose-100" aria-hidden="true" /> Range band: low to high case (0.5× to 1.5× the decay speed)
              </li>
              <li className="flex items-center gap-1.5">
                <span className="h-0.5 w-5 bg-emerald-500" aria-hidden="true" /> Content refresh
              </li>
              <li className="flex items-center gap-1.5">
                <span className="w-5 border-t-2 border-dashed border-slate-300" aria-hidden="true" /> Today’s level
              </li>
            </ul>
            <ForecastChart curve={chartCurve} title={selected ? selected.url : "All decaying pages"} />
            {chartCurve.length > 0 && (
              <p className="mt-1 text-xs text-slate-600">
                Do-nothing path at day 90: <strong>{fmt(chartCurve[chartCurve.length - 1].baseline)}</strong> clicks per 30 days, with a range of{" "}
                <strong>{fmt(chartCurve[chartCurve.length - 1].baseline_low)}</strong> to <strong>{fmt(chartCurve[chartCurve.length - 1].baseline_high)}</strong>. The green
                refresh line is a scenario that assumes the refresh works as set above, so it has no range; treat it as an upper bound on what a refresh could win back.
              </p>
            )}
            <table className="mt-2 w-full text-right text-xs text-slate-600">
              <caption className="sr-only">Projected clicks per 30 days at day 0, 30, 60 and 90</caption>
              <thead>
                <tr className="text-slate-400">
                  <th scope="col" className="py-1 text-left font-medium">
                    Day
                  </th>
                  {chartPoints.map((p) => (
                    <th key={p.day} scope="col" className="py-1 font-medium">
                      {p.day === 0 ? "Today" : `+${p.day}`}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row" className="py-1 text-left font-medium text-rose-700">
                    Do nothing
                  </th>
                  {chartPoints.map((p) => (
                    <td key={p.day} className="py-1 tabular-nums">
                      {fmt(p.baseline)}
                    </td>
                  ))}
                </tr>
                <tr>
                  <th scope="row" className="py-1 text-left font-medium text-emerald-700">
                    Refreshed
                  </th>
                  {chartPoints.map((p) => (
                    <td key={p.day} className="py-1 tabular-nums">
                      {fmt(p.refreshed)}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>

          {/* priority table */}
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3">
              <h3 className="font-semibold text-slate-900">
                Action priorities <span className="text-sm font-normal text-slate-400">({rows.length})</span>
              </h3>
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <div role="group" aria-label="Sort by" className="inline-flex rounded-lg bg-slate-100 p-0.5 font-medium">
                  {(
                    [
                      ["loss", "Projected loss"],
                      ["score", "Action score"],
                    ] as [SortKey, string][]
                  ).map(([k, label]) => (
                    <button
                      key={k}
                      type="button"
                      aria-pressed={sortBy === k}
                      onClick={() => setSortBy(k)}
                      className={`rounded-md px-3 py-1.5 transition ${sortBy === k ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800"}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {notDecaying > 0 && (
                  <label className="flex cursor-pointer items-center gap-1.5 text-slate-600">
                    <input type="checkbox" checked={showStable} onChange={(e) => setShowStable(e.target.checked)} className="h-3.5 w-3.5 rounded border-slate-300 text-indigo-600" />
                    Show {notDecaying} without position decay
                  </label>
                )}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Page</th>
                    <th className="px-4 py-3 text-right">Clicks / 30d</th>
                    <th className="px-4 py-3 text-right">Position now → day 90</th>
                    <th className="px-4 py-3 text-right">90-day loss</th>
                    <th className="px-4 py-3">Action score</th>
                    <th className="px-4 py-3">Confidence</th>
                    <th className="px-4 py-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 align-top">
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                        No page is projected to decay.
                      </td>
                    </tr>
                  )}
                  {rows.map((p, i) => {
                    const decaying = p.status === "decaying";
                    const tier = TIER_STYLES[p.tier];
                    const active = p.url === selectedUrl;
                    return (
                      <tr key={`${p.url}-${i}`} className={`${active ? "bg-indigo-50/60" : "hover:bg-slate-50/60"} ${decaying ? "" : "opacity-60"}`}>
                        <td className="max-w-[18rem] px-4 py-3">
                          <button type="button" onClick={() => setSelectedUrl(active ? null : p.url)} aria-pressed={active} title="Show this page on the chart" className="block max-w-full text-left">
                            <span className="block truncate font-mono text-xs text-slate-800">{p.url}</span>
                          </button>
                          <p className="truncate text-xs text-slate-500">
                            {p.keyword || "no keyword"}
                            {manualUrls.has(p.url) && <span className="ml-1.5 rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-indigo-700">Manual</span>}
                            {!decaying && <span className="ml-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-500">{p.status}</span>}
                          </p>
                          <p className="text-[11px] text-slate-400">
                            {p.model.type} model, {p.model.periods} periods
                            {decaying && ` · ${p.model.positions_per_30d >= 0 ? "+" : ""}${p.model.positions_per_30d.toFixed(1)} positions / 30d`}
                          </p>
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-slate-700">{fmt(p.current.clicks_30d)}</td>
                        <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-slate-700">
                          {p.current.position.toFixed(1)} → <span className={decaying ? "font-semibold text-rose-600" : ""}>{p.points[3].position.toFixed(1)}</span>
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          <span className="font-semibold text-slate-900">{decaying ? `−${fmt(p.losses.d90)}` : "0"}</span>
                          {decaying && <span className="block text-xs text-slate-400">{p.losses.pct_of_current_90d.toFixed(0)}% of 90d traffic</span>}
                          {decaying && p.losses.recoverable_90d > 0 && <span className="block text-xs text-emerald-700">+{fmt(p.losses.recoverable_90d)} recoverable</span>}
                        </td>
                        <td className="px-4 py-3">
                          <div
                            className="flex items-center gap-2"
                            title={`Loss ${(p.score_breakdown.loss_magnitude.value * 100).toFixed(0)}% × 45 · Demand ${(p.score_breakdown.demand.value * 100).toFixed(0)}% × 25 (${fmt(p.score_breakdown.demand.monthly_demand)} / month, from ${p.score_breakdown.demand.source}) · Decay speed ${(p.score_breakdown.decay_speed_and_acceleration.value * 100).toFixed(0)}% × 30${p.score_breakdown.decay_speed_and_acceleration.acceleration_known ? "" : " (acceleration unknown)"}`}
                          >
                            <div className="h-2 w-16 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={p.action_score} aria-valuemin={0} aria-valuemax={100}>
                              <div className={`h-full rounded-full ${tier.bar}`} style={{ width: `${p.action_score}%` }} />
                            </div>
                            <span className="w-7 font-semibold tabular-nums text-slate-900">{p.action_score}</span>
                          </div>
                          <p className={`text-xs font-medium ${tier.text}`}>{p.tier}</p>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ring-1 ring-inset ${CONFIDENCE_STYLES[p.confidence]}`} title={p.notes.join(" ")}>
                            {p.confidence}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => openTool({ tool: "refresh", keyword: p.keyword, url: p.url })}
                              disabled={!decaying}
                              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              ⚡ Launch Content Refresh
                            </button>
                            {manualUrls.has(p.url) && (
                              <button
                                type="button"
                                onClick={() => {
                                  setManual((prev) => prev.filter((m) => m.url !== p.url));
                                  if (selectedUrl === p.url) setSelectedUrl(null);
                                }}
                                aria-label={`Remove ${p.url}`}
                                title="Remove this manual page"
                                className="rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                              >
                                ✕
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {selected && selected.notes.length > 0 && (
              <ul className="space-y-1 border-t border-slate-100 bg-slate-50 px-5 py-3 text-xs text-slate-600">
                {selected.notes.map((n) => (
                  <li key={n}>• {n}</li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {/* manual entry */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <button
          type="button"
          onClick={() => setFormOpen((v) => !v)}
          aria-expanded={formOpen}
          className="flex w-full items-center justify-between px-5 py-3 text-left text-sm font-semibold text-slate-800 hover:bg-slate-50"
        >
          Forecast a page manually (use 3+ periods for a better model)
          <span className="text-xs text-slate-400" aria-hidden="true">
            {formOpen ? "▲" : "▼"}
          </span>
        </button>
        {formOpen && (
          <form onSubmit={addManual} className="space-y-4 border-t border-slate-200 p-5">
            <div className="grid gap-3 md:grid-cols-4">
              <label className="block text-sm font-medium text-slate-700 md:col-span-2">
                Page URL
                <input type="text" value={mUrl} onChange={(e) => setMUrl(e.target.value)} placeholder="https://example.com/blog/post" className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
              </label>
              <label className="block text-sm font-medium text-slate-700">
                Primary keyword
                <input type="text" value={mKeyword} onChange={(e) => setMKeyword(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
              </label>
              <label className="block text-sm font-medium text-slate-700">
                Monthly search volume <ThirdPartyBadge>Estimated · your figure</ThirdPartyBadge> <span className="font-normal text-slate-400">(optional)</span>
                <input type="text" inputMode="numeric" value={mVolume} onChange={(e) => setMVolume(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
              </label>
            </div>
            <div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-slate-700">Periods, oldest first</p>
                <label className="flex items-center gap-2 text-xs text-slate-500">
                  Days per period
                  <select value={mPeriod} onChange={(e) => setMPeriod(Number(e.target.value))} className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900">
                    {PERIOD_OPTIONS.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="mt-2 space-y-2">
                {mRows.map((r, i) => (
                  <div key={i} className="grid grid-cols-[2rem_1fr_1fr_2rem] items-center gap-2">
                    <span className="text-xs text-slate-400">#{i + 1}</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      aria-label={`Period ${i + 1} clicks`}
                      placeholder="Clicks"
                      value={r.clicks}
                      onChange={(e) => setMRows((rows2) => rows2.map((x, j) => (j === i ? { ...x, clicks: e.target.value } : x)))}
                      className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                    />
                    <input
                      type="text"
                      inputMode="decimal"
                      aria-label={`Period ${i + 1} average position`}
                      placeholder="Avg position"
                      value={r.position}
                      onChange={(e) => setMRows((rows2) => rows2.map((x, j) => (j === i ? { ...x, position: e.target.value } : x)))}
                      className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                    />
                    <button
                      type="button"
                      onClick={() => setMRows((rows2) => (rows2.length > 2 ? rows2.filter((_, j) => j !== i) : rows2))}
                      disabled={mRows.length <= 2}
                      aria-label={`Remove period ${i + 1}`}
                      className="rounded p-1 text-slate-400 hover:text-rose-600 disabled:opacity-30"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setMRows((rows2) => (rows2.length < 12 ? [...rows2, { clicks: "", position: "" }] : rows2))}
                disabled={mRows.length >= 12}
                className="mt-2 text-sm font-medium text-indigo-600 hover:text-indigo-800 disabled:opacity-40"
              >
                + Add period
              </button>
            </div>
            {mError && (
              <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-600">
                ⚠️ {mError}
              </p>
            )}
            <div className="flex justify-end">
              <button type="submit" className="rounded-lg bg-slate-900 px-5 py-2 text-sm font-semibold text-white transition hover:bg-slate-700">
                Add to forecast
              </button>
            </div>
          </form>
        )}
      </div>

      <p className="text-xs leading-relaxed text-slate-400">
        How this works: position erosion is fitted over the history (a straight line, or compounding when 3+ periods show it speeding up) and mapped to clicks with a standard
        click-through-by-position curve, anchored to each page’s own clicks. Search demand is assumed constant. “Content refresh” is a scenario you control above, not a
        prediction. With only two periods the trend is a straight line, so forecasts are directional.
      </p>
    </section>
  );
}

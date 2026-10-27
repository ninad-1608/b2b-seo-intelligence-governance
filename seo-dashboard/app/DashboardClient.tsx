"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import AlertBell from "./AlertBell";
import AlertingPanel from "./AlertingPanel";
import CannibalizationPanel, { type CannibalizationAlert } from "./CannibalizationPanel";
import ContentBriefPanel, { type BriefSeed } from "./ContentBriefPanel";
import ContentDecayPanel from "./ContentDecayPanel";
import ContentRefreshPanel from "./ContentRefreshPanel";
import CrawlerSimulatorPanel from "./CrawlerSimulatorPanel";
import ForecastingPanel from "./ForecastingPanel";
import GeoAuditPanel, { type GeoSeed } from "./GeoAuditPanel";
import GeoSimulatorPanel from "./GeoSimulatorPanel";
import GscCallout, { type GscSummary } from "./GscCallout";
import GscConnectorModal, { type DataMode } from "./GscConnectorModal";
import GSCUploadModal from "./GSCUploadModal";
import InternalLinkPanel from "./InternalLinkPanel";
import { flaggedToAlerts, harmfulCount, type ApiFlaggedQuery } from "./lib/alertMapping";
import LiveSiteInspector from "./LiveSiteInspector";
import ModuleDrawer from "./ModuleDrawer";
import NeedsYourAttentionStrip, { type AttentionTarget } from "./NeedsYourAttentionStrip";
import ModuleToolbar from "./ModuleToolbar";
import type { ModuleKey } from "./modules";
import { OPEN_OPPORTUNITY_EVENT, REVIEW_CHANGED_EVENT, ToolActionsProvider, type ToolRequest } from "./toolActions";
import TopicClusterPanel from "./TopicClusterPanel";
import { ScoreDisclaimer, SyncStamp } from "./Guardrails";
import EvidenceAuditPanel, { EvidenceAuditSummary } from "./EvidenceAuditPanel";
import { EvidenceProvider, FreshnessChip, NoSyncChip } from "./evidence";
import ExportReportModal from "./ExportReportModal";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8010";

type Metric = { label: string; value: string; hint: string; accent: string; source?: "gsc" | "sample" | "typed" | "ratings" };
type Source = "sandbox" | "custom";

type Props = {
  sandboxAlerts: CannibalizationAlert[];
  alertsError: string | null;
  staticMetrics: Metric[];
  children: ReactNode; // server-rendered content (the opportunities table), shown full width below the module toolbar
};

async function apiError(res: Response): Promise<string> {
  const data = await res.json().catch(() => ({}));
  const detail = Array.isArray(data.detail) ? data.detail[0]?.msg : data.detail;
  return typeof detail === "string" ? detail : `Request failed (${res.status})`;
}

/** Lightweight connection summary for the callout; null when the API is unreachable. */
async function fetchGscSummary(): Promise<GscSummary | null> {
  try {
    const res = await fetch(`${API_URL}/api/v1/gsc/status`);
    if (!res.ok) return null;
    const st = await res.json();
    return { connected: Boolean(st.connected), configured: Boolean(st.configured), hasSync: Boolean(st.last_sync) };
  } catch {
    return null;
  }
}

export default function DashboardClient({ sandboxAlerts, alertsError, staticMetrics, children }: Props) {
  const params = useSearchParams();
  const [tab, setTab] = useState<ModuleKey | null>(null); // the module open in the drawer, if any
  const [geoSeed, setGeoSeed] = useState<GeoSeed | undefined>(undefined);
  const [briefSeed, setBriefSeed] = useState<BriefSeed | undefined>(undefined);
  const [refreshKeyword, setRefreshKeyword] = useState<string | undefined>(undefined);
  const [simQuery, setSimQuery] = useState<string | undefined>(undefined);
  const [refreshUrl, setRefreshUrl] = useState<string | undefined>(undefined);
  const [crawlerUrl, setCrawlerUrl] = useState<string | undefined>(undefined);
  const [alertsVersion, setAlertsVersion] = useState(0); // bumped when alerts change, so the bell and the panel reload
  const [geoQueries, setGeoQueries] = useState<string | undefined>(undefined);
  // Not cleared when the drawer closes: the Topic Clusters panel stays mounted so its results survive, and re-keying it would wipe them.
  const [clusterSeed, setClusterSeed] = useState<string | undefined>(undefined);
  const [source, setSource] = useState<Source>("sandbox");
  const [customAlerts, setCustomAlerts] = useState<CannibalizationAlert[]>([]);

  // Live Google Search Console data (synced through the connector)
  const [gscOpen, setGscOpen] = useState(() => params.get("gsc") === "connected"); // returning from Google's consent screen
  const [dataMode, setDataMode] = useState<DataMode>("sandbox");
  const [liveAlerts, setLiveAlerts] = useState<CannibalizationAlert[]>([]);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [liveLabel, setLiveLabel] = useState("Search Console");
  const [liveVersion, setLiveVersion] = useState(0);
  const [exportOpen, setExportOpen] = useState(false);
  const exportButtonRef = useRef<HTMLButtonElement>(null);
  const [reviewVersion, setReviewVersion] = useState(0); // bumped when a reviewer decides, so the attention strip reloads

  useEffect(() => {
    const onChanged = () => setReviewVersion((v) => v + 1);
    window.addEventListener(REVIEW_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(REVIEW_CHANGED_EVENT, onChanged);
  }, []);
  const [gscSummary, setGscSummary] = useState<GscSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const summary = await fetchGscSummary();
      if (!cancelled && summary) setGscSummary(summary);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function refreshGscSummary() {
    const summary = await fetchGscSummary();
    if (summary) setGscSummary(summary);
  }

  const usingLive = dataMode === "live";
  const usingCustom = !usingLive && source === "custom";
  const alerts = usingLive ? liveAlerts : usingCustom ? customAlerts : sandboxAlerts;
  const showError = usingLive ? liveError : !usingCustom ? alertsError : null;

  async function activateLive() {
    try {
      const [reportRes, statusRes] = await Promise.all([fetch(`${API_URL}/api/v1/gsc/cannibalization`), fetch(`${API_URL}/api/v1/gsc/status`)]);
      if (!reportRes.ok) throw new Error(await apiError(reportRes));
      const report: { flagged?: ApiFlaggedQuery[]; candidates?: ApiFlaggedQuery[] } = await reportRes.json();
      const st = statusRes.ok ? await statusRes.json() : null;
      setLiveAlerts(flaggedToAlerts(report.candidates ?? report.flagged ?? []));
      setLiveLabel(st?.last_sync ? `${st.last_sync.site_url}, ${st.last_sync.start_date} to ${st.last_sync.end_date}` : "Search Console");
      setLiveError(null);
    } catch (err) {
      setLiveAlerts([]);
      setLiveError(err instanceof Error ? err.message : "Could not reach the analysis API. Is the FastAPI server running?");
    }
    setLiveVersion((v) => v + 1); // remounts panels that cache live results
    setDataMode("live");
    void refreshGscSummary();
  }

  /** After a deep check the stored evidence can change a verdict, so re-read the live report (without remounting the panels). */
  async function reloadLiveAlerts() {
    try {
      const res = await fetch(`${API_URL}/api/v1/gsc/cannibalization`);
      if (!res.ok) return;
      const report: { flagged?: ApiFlaggedQuery[]; candidates?: ApiFlaggedQuery[] } = await res.json();
      setLiveAlerts(flaggedToAlerts(report.candidates ?? report.flagged ?? []));
      setAlertsVersion((v) => v + 1);
    } catch {
      /* keep what is on screen */
    }
  }

  function changeMode(mode: DataMode) {
    if (mode === "live") void activateLive();
    else {
      setDataMode("sandbox");
      setLiveVersion((v) => v + 1);
    }
  }

  function closeGsc() {
    setGscOpen(false);
    if (params.get("gsc")) window.history.replaceState(null, "", window.location.pathname);
    void refreshGscSummary();
  }

  function clearSeeds() {
    // hand-offs must not re-run (or re-fill a form) on a later, unrelated visit
    setGeoSeed(undefined);
    setBriefSeed(undefined);
    setRefreshKeyword(undefined);
    setRefreshUrl(undefined);
    setCrawlerUrl(undefined);
    setSimQuery(undefined);
    setGeoQueries(undefined);
  }

  function openModule(key: ModuleKey) {
    clearSeeds();
    setTab(key);
  }

  function closeModule() {
    clearSeeds();
    setTab(null);
  }

  /** Open a tool workspace pre-filled from a table row (or another tool). */
  function openTool(req: ToolRequest) {
    if (req.tool === "sync") {
      setGscOpen(true); // a dialog, not a module: it opens over the drawer
      return;
    }
    clearSeeds();
    if (req.tool === "brief") setBriefSeed({ keyword: req.keyword, audience: req.audience, intent: req.intent, opportunityId: req.opportunityId });
    if (req.tool === "refresh") {
      setRefreshKeyword(req.keyword);
      setRefreshUrl(req.url);
    }
    if (req.tool === "crawler") setCrawlerUrl(req.url);
    if (req.tool === "clusters") setClusterSeed(req.seedTopic);
    if (req.tool === "simulator") setSimQuery(req.query);
    if (req.tool === "geo") setGeoQueries(req.queries);
    setTab(req.tool);
  }

  /** One click from the attention strip to the place the problem is handled. */
  function handleAttention(target: AttentionTarget) {
    if (target.kind === "opportunity") {
      closeModule(); // the drawer would cover the table
      window.dispatchEvent(new CustomEvent(OPEN_OPPORTUNITY_EVENT, { detail: { id: target.opportunity_id } }));
    } else if (target.kind === "module") {
      openModule(target.module);
    } else if (target.tool === "crawler") {
      openTool({ tool: "crawler", url: target.url ?? undefined });
    } else {
      openTool({ tool: target.tool });
    }
  }

  const metrics: Metric[] = [
    ...staticMetrics,
    {
      label: "Cannibalization Alerts",
      value: showError ? "—" : String(harmfulCount(alerts)),
      hint: usingLive ? "Harmful overlaps in your live Search Console data" : usingCustom ? "Harmful overlaps in your uploaded GSC CSV" : "Harmful overlaps after validation (sandbox data)",
      accent: "text-indigo-600",
      source: usingLive ? "gsc" : "sample",
    },
  ];

  return (
    <ToolActionsProvider value={{ openTool }}>
      <EvidenceProvider version={liveVersion + alertsVersion + reviewVersion}>
      <NeedsYourAttentionStrip version={liveVersion + alertsVersion + reviewVersion} onAction={handleAttention} />

      <ModuleToolbar
        active={tab}
        onSelect={openModule}
        trailing={
          <>
            <button
              ref={exportButtonRef}
              type="button"
              onClick={() => setExportOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
            >
              <span aria-hidden="true">📄</span> Export Executive PDF
            </button>
            <AlertBell onOpen={() => openModule("alerts")} version={alertsVersion} onAutoCheck={() => setAlertsVersion((v) => v + 1)} />
          </>
        }
      />

      <GscCallout summary={gscSummary} live={usingLive} liveLabel={liveLabel} onOpen={() => setGscOpen(true)} onUseSandbox={() => changeMode("sandbox")} />

      <section aria-label="Summary metrics" className="grid gap-4 sm:grid-cols-3">
        {metrics.map((m) => (
          <div key={m.label} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-sm font-medium text-slate-500">{m.label}</p>
            <p className={`mt-2 text-3xl font-semibold tracking-tight ${m.accent}`}>{m.value}</p>
            {/* one footer for every card: a muted note, then the data-source pill */}
            <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-slate-100 pt-3">
              <span className="text-xs text-slate-500">{m.hint}</span>
              {m.source === "gsc" ? (
                <FreshnessChip source="gsc" />
              ) : m.source === "ratings" ? (
                <NoSyncChip>Reviewer ratings · no sync date</NoSyncChip>
              ) : m.source === "typed" ? (
                <NoSyncChip>Sample + typed-in figures · no sync date</NoSyncChip>
              ) : m.source === "sample" ? (
                <NoSyncChip>Sample data · no sync date</NoSyncChip>
              ) : null}
            </div>
          </div>
        ))}
      </section>

      <EvidenceAuditSummary onOpen={() => openModule("evidence")} />

      <div className="space-y-2">
        <ScoreDisclaimer compact />
        {!usingLive && <SyncStamp live={false} />}
      </div>

      {children}

      <ModuleDrawer open={tab !== null} moduleKey={tab} onSelect={openModule} onClose={closeModule}>
        {/* Kept mounted (just hidden) so cluster results survive the hand-off to the Content Brief module and closing the drawer. */}
        <div hidden={tab !== "clusters"}>
          <TopicClusterPanel
            key={clusterSeed ?? "manual"}
            initialSeed={clusterSeed}
            onGenerateBrief={(seed) => {
              setBriefSeed(seed);
              setTab("brief");
            }}
          />
        </div>

        {tab === "evidence" ? (
          <EvidenceAuditPanel />
        ) : tab === "alerts" ? (
          <AlertingPanel version={alertsVersion} onChanged={() => setAlertsVersion((v) => v + 1)} />
        ) : tab === "forecast" ? (
          <ForecastingPanel key={`forecast-${liveVersion}-${usingLive}`} liveLabel={usingLive ? liveLabel : undefined} />
        ) : tab === "decay" ? (
          <ContentDecayPanel key={`decay-${liveVersion}-${usingLive}`} liveLabel={usingLive ? liveLabel : undefined} />
        ) : tab === "geo" ? (
          <GeoAuditPanel key={geoSeed?.label ?? geoQueries ?? "manual"} seed={geoSeed} initialQueries={geoQueries} />
        ) : tab === "links" ? (
          <InternalLinkPanel />
        ) : tab === "refresh" ? (
          <ContentRefreshPanel key={`${refreshKeyword ?? ""}|${refreshUrl ?? ""}`} initialKeyword={refreshKeyword} initialUrl={refreshUrl} />
        ) : tab === "crawler" ? (
          <CrawlerSimulatorPanel key={crawlerUrl ?? "manual"} initialUrl={crawlerUrl} />
        ) : tab === "simulator" ? (
          <GeoSimulatorPanel key={simQuery ?? "manual"} initialQuery={simQuery} />
        ) : tab === "brief" ? (
          <ContentBriefPanel key={briefSeed ? `${briefSeed.keyword}|${briefSeed.intent}|${briefSeed.opportunityId ?? ""}` : "manual"} seed={briefSeed} />
        ) : tab === "inspector" ? (
          <LiveSiteInspector
            onRunGeo={(content, label) => {
              setGeoSeed({ content, label });
              setTab("geo");
            }}
          />
        ) : tab === "cannibalization" ? (
          <div className="space-y-4">
            <GSCUploadModal
              onAlertsUpdated={(next) => {
                setCustomAlerts(next);
                setSource("custom");
                setDataMode("sandbox"); // an uploaded CSV replaces the live view
              }}
              onResetToSandbox={() => {
                setCustomAlerts([]);
                setSource("sandbox");
                setDataMode("sandbox");
              }}
            />

            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span>Data source:</span>
              <span
                className={`rounded-full px-2.5 py-0.5 font-medium ring-1 ring-inset ${
                  usingLive || usingCustom ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20" : "bg-slate-100 text-slate-600 ring-slate-500/20"
                }`}
              >
                {usingLive ? "Live Search Console" : usingCustom ? "Custom GSC upload" : "Sandbox demo"}
              </span>
            </div>
            <SyncStamp live={usingLive} />

            {showError ? (
              <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
                {showError}
              </p>
            ) : (
              <CannibalizationPanel alerts={alerts} canDeepCheck={usingLive} onDeepChecked={() => void reloadLiveAlerts()} />
            )}
          </div>
        ) : null}
      </ModuleDrawer>

      <GscConnectorModal open={gscOpen} onClose={closeGsc} dataMode={dataMode} onModeChange={changeMode} onSynced={() => void activateLive()} />
        {exportOpen && (
          <ExportReportModal
            onClose={() => {
              setExportOpen(false);
              exportButtonRef.current?.focus();
            }}
          />
        )}
      </EvidenceProvider>
    </ToolActionsProvider>
  );
}

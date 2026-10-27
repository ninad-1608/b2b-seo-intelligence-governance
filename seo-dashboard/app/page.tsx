import { connection } from "next/server";
import { Suspense } from "react";
import type { CannibalizationAlert } from "./CannibalizationPanel";
import { fetchCannibalizationAlerts } from "./lib/cannibalization";
import { fetchOpportunities } from "./lib/opportunities";
import DashboardClient from "./DashboardClient";
import OpportunityTable from "./OpportunityTable";

const numberFormat = new Intl.NumberFormat("en-US");
const API_DOWN = "Could not reach the analysis API. Is the FastAPI server running?";

async function DashboardContent() {
  await connection(); // render per request: this page shows live API data

  const [alertsResult, scoredResult] = await Promise.allSettled([fetchCannibalizationAlerts(), fetchOpportunities()]);

  const cannibalizationAlerts: CannibalizationAlert[] = alertsResult.status === "fulfilled" ? alertsResult.value : [];
  const alertsError = alertsResult.status === "rejected" ? API_DOWN : null;
  const scored = scoredResult.status === "fulfilled" ? scoredResult.value : null;

  const totalImpressions = scored ? scored.items.reduce((sum, o) => sum + o.impressions, 0) : null;
  const highPriority = scored ? scored.items.filter((o) => o.high_priority).length : null;

  const metrics = [
    {
      label: "Total Impressions",
      value: totalImpressions === null ? "—" : numberFormat.format(totalImpressions),
      hint: "Sample + typed-in figures, not live Search Console",
      accent: "text-slate-900",
      source: "typed" as const,
    },
    {
      label: "High Priority Count",
      value: highPriority === null ? "—" : String(highPriority),
      hint: scored ? `Score ${scored.threshold}+` : "Scoring unavailable",
      accent: "text-emerald-600",
      source: "ratings" as const,
    },
  ];

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-5 sm:px-6">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">SEO Opportunities Dashboard</h1>
            <p className="mt-0.5 text-sm text-slate-500">Prioritized B2B keyword opportunities and content gaps</p>
          </div>
          <span className="hidden rounded-full bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700 ring-1 ring-inset ring-indigo-600/20 sm:inline">
            Last 28 days
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-6">
        <DashboardClient sandboxAlerts={cannibalizationAlerts} alertsError={alertsError} staticMetrics={metrics}>
          {scored ? (
            <OpportunityTable items={scored.items} threshold={scored.threshold} />
          ) : (
            <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
              {API_DOWN}
            </p>
          )}
        </DashboardClient>
      </main>
    </div>
  );
}

export default function Dashboard() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-slate-500">Loading dashboard…</div>}>
      <DashboardContent />
    </Suspense>
  );
}

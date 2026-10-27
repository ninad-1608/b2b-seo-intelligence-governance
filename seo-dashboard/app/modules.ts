export type ModuleKey =
  | "alerts"
  | "cannibalization"
  | "decay"
  | "forecast"
  | "refresh"
  | "links"
  | "geo"
  | "inspector"
  | "crawler"
  | "simulator"
  | "clusters"
  | "brief"
  | "evidence";

export type ModuleInfo = { key: ModuleKey; label: string; icon: string; description: string };
export type ModuleGroup = { id: string; label: string; blurb: string; modules: ModuleInfo[] };

export const MODULE_GROUPS: ModuleGroup[] = [
  {
    id: "fixes",
    label: "Fixes & Decay",
    blurb: "Find and repair what is losing traffic",
    modules: [
      { key: "alerts", label: "Alerts & Notifications", icon: "🔔", description: "Traffic, split and crawler-access alerts" },
      { key: "cannibalization", label: "Cannibalization", icon: "🧩", description: "Queries split across competing URLs" },
      { key: "decay", label: "Content Decay", icon: "📉", description: "Pages losing impressions and clicks" },
      { key: "forecast", label: "Predictive Decay Forecast", icon: "📈", description: "Project clicks 30, 60 and 90 days out" },
      { key: "refresh", label: "Content Refresh", icon: "🔄", description: "Section-by-section rewrite plan" },
      { key: "links", label: "Internal Links", icon: "🔗", description: "Link orphaned and under-linked pages" },
    ],
  },
  {
    id: "audits",
    label: "Audits & Technical",
    blurb: "Check pages, crawlers and AI visibility",
    modules: [
      { key: "geo", label: "GEO & LLM Audit", icon: "🤖", description: "Score how citable a page is by AI" },
      { key: "inspector", label: "Live Site Inspector", icon: "🔎", description: "Core Web Vitals, content and schema" },
      { key: "crawler", label: "Crawler Simulator", icon: "🕷️", description: "Can AI crawlers reach and read it?" },
      { key: "simulator", label: "GEO Simulator", icon: "⚡", description: "Head-to-head vs a competitor" },
      { key: "evidence", label: "Evidence Audit", icon: "🧾", description: "Data freshness and consistency checks" },
    ],
  },
  {
    id: "strategy",
    label: "Strategy & Clusters",
    blurb: "Plan what to publish next",
    modules: [
      { key: "clusters", label: "Topic Clusters", icon: "🗺️", description: "Group keywords into pillar pages" },
      { key: "brief", label: "Content Brief", icon: "📝", description: "Outline and SEO brief for a keyword" },
    ],
  },
];

export function findModule(key: ModuleKey | null): (ModuleInfo & { group: string }) | null {
  if (!key) return null;
  for (const g of MODULE_GROUPS) {
    const m = g.modules.find((x) => x.key === key);
    if (m) return { ...m, group: g.label };
  }
  return null;
}

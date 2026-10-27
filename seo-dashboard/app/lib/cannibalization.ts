import type { CannibalizationAlert } from "../CannibalizationPanel";
import { flaggedToAlerts, type ApiFlaggedQuery } from "./alertMapping";

const API_URL = process.env.API_URL ?? "http://127.0.0.1:8010";

type QueryRow = {
  query: string;
  url: string;
  impressions: number;
  average_position: number;
};

type ApiReport = { flagged: ApiFlaggedQuery[]; candidates?: ApiFlaggedQuery[] };

// Sample Search Console rows for the demo; replace with your real export / data source. Each query shows a different verdict:
//   cloud migration        two service pages, 4.2 / 7.8       -> Harmful overlap (High)
//   lead scoring           two guides, 8.5 / 14.2             -> Harmful overlap (Low)
//   account based marketing  a solution page + a blog post    -> False positive (different intents)
//   crm pricing            /en-us/ and /en-gb/ pricing         -> False positive (regional variants)
//   hubspot sync guide     two guides at 1.4 / 2.6             -> Winning SERP domination
//   abm tools list         12 impressions on the weaker URL    -> Cleared (under the 20-impression floor)
const sampleRows: QueryRow[] = [
  { query: "enterprise cloud migration", url: "/services/cloud-migration-framework", impressions: 480, average_position: 4.2 },
  { query: "enterprise cloud migration", url: "/services/enterprise-cloud-migration", impressions: 320, average_position: 7.8 },
  { query: "account based marketing platform", url: "/solutions/abm-automation", impressions: 150, average_position: 5.1 },
  { query: "account based marketing platform", url: "/blog/what-is-abm-software", impressions: 80, average_position: 11.4 },
  { query: "lead scoring model examples", url: "/blog/lead-scoring-frameworks", impressions: 45, average_position: 8.5 },
  { query: "lead scoring model examples", url: "/resources/b2b-lead-scoring-guide", impressions: 25, average_position: 14.2 },
  { query: "crm pricing", url: "/en-us/pricing", impressions: 90, average_position: 3.1 },
  { query: "crm pricing", url: "/en-gb/pricing", impressions: 70, average_position: 3.8 },
  { query: "hubspot sync guide", url: "/blog/hubspot-sync-guide", impressions: 600, average_position: 1.4 },
  { query: "hubspot sync guide", url: "/blog/hubspot-integration-setup", impressions: 300, average_position: 2.6 },
  { query: "abm tools list", url: "/blog/abm-tools", impressions: 15, average_position: 9.0 },
  { query: "abm tools list", url: "/blog/abm-software", impressions: 12, average_position: 12.0 },
  { query: "b2b saas demand generation", url: "/solutions/demand-generation", impressions: 48200, average_position: 2.1 },
  { query: "hubspot crm integration", url: "/integrations/hubspot", impressions: 27400, average_position: 1.8 },
  { query: "sales enablement software", url: "/products/sales-enablement", impressions: 18600, average_position: 6.3 },
  { query: "saas pricing models", url: "/pricing", impressions: 9400, average_position: 3.4 },
  { query: "what is mql vs sql", url: "/blog/mql-vs-sql-guide", impressions: 6700, average_position: 4.9 },
];

/** Fetch live cannibalization analysis from FastAPI and shape it for CannibalizationPanel. */
export async function fetchCannibalizationAlerts(): Promise<CannibalizationAlert[]> {
  const res = await fetch(`${API_URL}/analyze-cannibalization`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sampleRows),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Analysis API returned ${res.status}`);
  }
  const report: ApiReport = await res.json();
  return flaggedToAlerts(report.candidates ?? report.flagged);
}

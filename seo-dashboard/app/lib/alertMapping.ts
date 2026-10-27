import type { CannibalizationAlert, RiskLevel } from "../CannibalizationPanel";
import type { Validation } from "./cannibalValidation";

export type ApiFlaggedQuery = {
  query: string;
  risk_level: RiskLevel | null;
  total_impressions: number;
  competing_urls: { url: string; impressions: number; average_position: number }[];
  validation?: Validation | null;
};

/**
 * Maps the API's cannibalization candidates onto the cards the panel renders. Pass `candidates` (every query that looked like a
 * split, each with its validation verdict), not just `flagged`, so cleared queries and false positives stay visible with their reason.
 */
export function flaggedToAlerts(candidates: ApiFlaggedQuery[]): CannibalizationAlert[] {
  return candidates.map((q) => ({
    query: q.query,
    competing_urls: q.competing_urls.map((u) => u.url),
    url_stats: q.competing_urls.map((u) => ({ url: u.url, impressions: u.impressions, position: u.average_position })),
    total_impressions: q.total_impressions,
    risk_level: q.risk_level ?? "Low",
    validation: q.validation ?? undefined,
  }));
}

/** Only the overlaps that survived every validation check. */
export function harmfulCount(alerts: CannibalizationAlert[]): number {
  return alerts.filter((a) => !a.validation || a.validation.verdict === "harmful").length;
}

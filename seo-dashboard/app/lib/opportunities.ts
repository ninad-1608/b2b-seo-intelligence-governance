const API_URL = process.env.API_URL ?? "http://127.0.0.1:8010";

export type FactorBreakdown = {
  key: string;
  label: string;
  rating: number;
  max_rating: number;
  weight_pct: number;
  contribution: number;
  max_contribution: number;
};

export type PriorityLevel = "High" | "Medium" | "Low";

export type GovernanceStatus = "Proposed" | "Approved" | "Needs changes" | "Rejected" | "Measuring" | "Completed";
export type Verdict = "Approved" | "Needs changes" | "Reject";

/** Human review state. `approved` is true for every state that can only be reached through an approval (Approved, Measuring, Completed). */
export type Governance = {
  status: GovernanceStatus;
  reviewer: string | null;
  verdict: Verdict | null;
  comment: string | null;
  decided_at: string | null;
  baseline_locked_at: string | null;
  completed_at: string | null;
  updated_at: string | null;
  approved: boolean;
};

export type ScoredOpportunity = {
  id: number;
  priority: string; // business priority / topic
  keyword: string;
  impressions: number;
  cannibalized: boolean;
  score: number; // 20-100, from Mastek's 4-factor formula (computed by the API)
  high_priority: boolean;
  factors: FactorBreakdown[];
  governance: Governance;
  // present only on user-created priorities (stored by the API)
  custom?: boolean;
  dbId?: number;
  level?: PriorityLevel;
  rated?: boolean; // false: three of the four factors are neutral defaults
};

export type ScoredOpportunities = { threshold: number; items: ScoredOpportunity[] };

type ApiItem = Omit<ScoredOpportunity, "dbId" | "level" | "custom"> & { custom: boolean; db_id: number | null; level: PriorityLevel | null };

/** Every opportunity (built-in and custom), scored, with its review state. The server is the single registry. */
export async function fetchOpportunities(): Promise<ScoredOpportunities> {
  const res = await fetch(`${API_URL}/api/v1/opportunities`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Opportunities API returned ${res.status}`);
  const data: { threshold: number; items: ApiItem[] } = await res.json();
  return {
    threshold: data.threshold,
    items: data.items.map(({ db_id, level, ...rest }) => ({ ...rest, dbId: db_id ?? undefined, level: level ?? undefined })),
  };
}

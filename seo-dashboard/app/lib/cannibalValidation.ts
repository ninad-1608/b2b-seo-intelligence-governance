export type VerdictKey = "harmful" | "false_positive" | "cleared";
export type CheckOutcome = "dismisses" | "supports" | "neutral" | "not_testable";
export type CheckId = "low_volume" | "canonical" | "variant" | "country_overlap" | "page_intent" | "serp_domination";

export type ValidationCheck = {
  id: CheckId;
  label: string;
  outcome: CheckOutcome;
  summary: string;
  threshold: string;
  observed: string;
};

export type Validation = {
  verdict: VerdictKey;
  label: "Harmful overlap" | "False positive" | "Cleared by validation checks";
  headline: string;
  decided_by: CheckId | null;
  domination: boolean;
  supporting: CheckId[];
  checks: ValidationCheck[];
  untested: CheckId[];
  tested: number;
  total: number;
  confidence: "full" | "partial";
};

export type DeepCheckResponse = {
  query: string;
  validation: Validation;
  evidence: { errors: string[]; fetched_at: string; window: string; days: number; urls_checked: number };
};

export const OUTCOME_STYLE: Record<CheckOutcome, { icon: string; label: string; pill: string }> = {
  dismisses: { icon: "✓", label: "Rules it out", pill: "bg-emerald-50 text-emerald-800 ring-emerald-600/20" },
  supports: { icon: "⚠", label: "Points to harm", pill: "bg-rose-50 text-rose-800 ring-rose-600/20" },
  neutral: { icon: "–", label: "No signal", pill: "bg-slate-100 text-slate-600 ring-slate-500/20" },
  not_testable: { icon: "?", label: "Could not test", pill: "bg-amber-50 text-amber-800 ring-amber-600/30" },
};

/** Which group a candidate belongs to on screen: winning dominations are kept apart from other cleared queries. */
export type Group = "harmful" | "domination" | "cleared" | "false_positive";

export function groupOf(v: Validation | undefined): Group {
  if (!v || v.verdict === "harmful") return "harmful";
  if (v.verdict === "false_positive") return "false_positive";
  return v.domination ? "domination" : "cleared";
}

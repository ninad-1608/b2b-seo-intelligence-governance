export const FORECAST_API = `${process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8010"}/api/v1/forecast`;

export type HistoryPeriod = { clicks: number; position: number; impressions?: number };

export type PageIn = {
  url: string;
  keyword: string;
  keyword_volume?: number;
  period_days: number;
  history: HistoryPeriod[]; // oldest -> newest
};

export type CurvePoint = {
  day: number;
  position: number;
  baseline: number;
  baseline_low: number;
  baseline_high: number;
  refreshed: number;
  refreshed_position: number;
};

export type AggPoint = Pick<CurvePoint, "day" | "baseline" | "baseline_low" | "baseline_high" | "refreshed">;

export type PageForecast = {
  url: string;
  keyword: string;
  status: "decaying" | "stable" | "improving";
  model: {
    type: "linear" | "exponential";
    periods: number;
    r2: number;
    positions_per_period: number;
    positions_per_30d: number;
    acceleration: { known: boolean; normalized: number; positions_per_period2: number | null };
  };
  current: { clicks_30d: number; position: number; best_position: number };
  points: CurvePoint[];
  curve: CurvePoint[];
  losses: { d30: number; d60: number; d90: number; d90_refreshed: number; recoverable_90d: number; pct_of_current_90d: number };
  action_score: number;
  tier: "Act now" | "Plan a refresh" | "Monitor";
  score_breakdown: {
    loss_magnitude: { weight: number; value: number };
    demand: { weight: number; value: number; monthly_demand: number; source: string };
    decay_speed_and_acceleration: { weight: number; value: number; acceleration_known: boolean };
  };
  confidence: "low" | "medium" | "high";
  notes: string[];
  assumptions: { velocity_multiplier: number; recovery_pct: number; refresh_lag_days: number; ramp_days: number; refreshed_target_position: number; band: string };
};

export type BatchForecast = {
  totals: {
    pages: number;
    decaying: number;
    clicks_now_30d: number;
    loss_30d: number;
    loss_60d: number;
    loss_90d: number;
    loss_90d_refreshed: number;
    recoverable_90d: number;
  };
  points: AggPoint[];
  curve: AggPoint[];
  pages: PageForecast[];
};

export async function forecastError(res: Response): Promise<string> {
  const data = await res.json().catch(() => ({}));
  const detail = Array.isArray(data.detail) ? data.detail[0]?.msg : data.detail;
  return typeof detail === "string" ? detail.replace(/^Value error, /, "") : `Request failed (${res.status})`;
}

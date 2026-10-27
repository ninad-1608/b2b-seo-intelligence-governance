import type { ToolRequest } from "../toolActions";

export const API_BASE = `${process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8010"}/api/v1/alerts`;

export type AlertSeverity = "critical" | "warning" | "info";

export type AlertAction = {
  tool: "decay" | "refresh" | "cannibalization" | "crawler" | "sync";
  label: string;
  keyword?: string;
  url?: string;
};

export type AlertItem = {
  id: number;
  fingerprint: string;
  kind: "volatility" | "cannibalization" | "bot_access" | "data";
  severity: AlertSeverity;
  title: string;
  detail: string;
  action: AlertAction | null;
  status: "open" | "resolved";
  read: boolean;
  created_at: string;
  last_seen_at: string;
  resolved_at: string | null;
};

export type AlertSummary = {
  unread_critical: number;
  unread_total: number;
  open_total: number;
  last_check: string | null;
  auto_check_minutes: number;
  due: boolean;
};

export type AlertSettings = {
  position_drop: number;
  traffic_drop_pct: number;
  ctr_drop_pct: number;
  min_query_impressions: number;
  cannibalization_min_impressions: number;
  check_volatility: boolean;
  check_cannibalization: boolean;
  check_bot_access: boolean;
  monitor_url: string;
  notify_min_severity: AlertSeverity;
  auto_check_minutes: number;
  slack_configured: boolean;
  slack_webhook_masked: string | null;
  teams_configured: boolean;
  teams_webhook_masked: string | null;
};

export async function apiErrorMessage(res: Response): Promise<string> {
  const data = await res.json().catch(() => ({}));
  const detail = Array.isArray(data.detail) ? data.detail[0]?.msg : data.detail;
  return typeof detail === "string" ? detail.replace(/^Value error, /, "") : `Request failed (${res.status})`;
}

/** Turn the action the API attached to an alert into a request the dashboard can open. */
export function toToolRequest(action: AlertAction): ToolRequest {
  switch (action.tool) {
    case "refresh":
      return { tool: "refresh", keyword: action.keyword ?? "", url: action.url };
    case "crawler":
      return { tool: "crawler", url: action.url };
    case "decay":
      return { tool: "decay" };
    case "sync":
      return { tool: "sync" };
    default:
      return { tool: "cannibalization" };
  }
}

export function timeAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

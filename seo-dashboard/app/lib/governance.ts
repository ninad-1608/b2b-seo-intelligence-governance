import type { GovernanceStatus, Verdict } from "./opportunities";

export const OPPORTUNITIES_API = `${process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8010"}/api/v1/opportunities`;

export type HistoryEntry = {
  id: number;
  opportunity_id: number;
  event: "decision" | "baseline_locked" | "completed" | "reset" | "brief_generated" | "deleted" | string;
  actor: string;
  from_status: GovernanceStatus | null;
  to_status: GovernanceStatus | null;
  verdict: Verdict | null;
  comment: string | null;
  details: Record<string, unknown>;
  created_at: string;
  hash: string;
};

export type HistoryResponse = { items: HistoryEntry[]; integrity: { ok: boolean; entries: number; first_bad_id: number | null } };

export const VERDICT_OPTIONS: { value: Verdict; label: string; hint: string; active: string }[] = [
  { value: "Approved", label: "Approve", hint: "Go ahead: unlocks the brief and measurement", active: "border-emerald-500 bg-emerald-50 text-emerald-800 ring-emerald-500/30" },
  { value: "Needs changes", label: "Needs changes", hint: "Send back with what must change", active: "border-amber-500 bg-amber-50 text-amber-800 ring-amber-500/30" },
  { value: "Reject", label: "Reject", hint: "Do not pursue this", active: "border-rose-500 bg-rose-50 text-rose-800 ring-rose-500/30" },
];

const RESERVED = new Set(["system", "ai", "bot", "assistant", "claude", "chatgpt", "gpt", "automation", "auto", "n/a", "na", "none", "unknown", "anonymous"]);

/** Mirrors the server's rule so the form can explain a problem before the round trip (the server stays the authority). */
export function reviewerNameError(name: string): string | null {
  const n = name.trim().replace(/\s+/g, " ");
  if (n.length < 2) return "Enter your name.";
  if ([...n].filter((c) => c.toLowerCase() !== c.toUpperCase()).length < 2) return "The name must contain letters.";
  if (RESERVED.has(n.toLowerCase())) return "Enter a real person's name: decisions must be signed by a named human.";
  return null;
}

export const COMMENT_MIN = 8;

export async function readError(res: Response): Promise<string> {
  const data = await res.json().catch(() => ({}));
  const detail = Array.isArray(data.detail) ? data.detail[0]?.msg : data.detail;
  return typeof detail === "string" ? detail.replace(/^Value error, /, "") : `Request failed (${res.status})`;
}

export function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

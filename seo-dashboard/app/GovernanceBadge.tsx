import type { GovernanceStatus } from "./lib/opportunities";

const STYLES: Record<GovernanceStatus, string> = {
  Proposed: "bg-slate-100 text-slate-600 ring-slate-500/20",
  Approved: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  "Needs changes": "bg-amber-50 text-amber-700 ring-amber-600/20",
  Rejected: "bg-rose-50 text-rose-700 ring-rose-600/20",
  Measuring: "bg-sky-50 text-sky-700 ring-sky-600/20",
  Completed: "bg-indigo-50 text-indigo-700 ring-indigo-600/20",
};

const ICONS: Record<GovernanceStatus, string> = {
  Proposed: "○",
  Approved: "✓",
  "Needs changes": "✎",
  Rejected: "✕",
  Measuring: "◔",
  Completed: "●",
};

/** Review-state pill (Proposed, Approved, Needs changes, Rejected, Measuring, Completed). */
export default function StatusBadge({ status, size = "sm" }: { status: GovernanceStatus; size?: "sm" | "md" }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-medium ring-1 ring-inset ${STYLES[status]} ${size === "md" ? "px-3 py-1 text-sm" : "px-2 py-0.5 text-xs"}`}
      title={`Review status: ${status}`}
    >
      <span aria-hidden="true">{ICONS[status]}</span>
      {status}
    </span>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { Fragment, useEffect, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { inferIntent } from "./lib/intent";
import StatusBadge from "./GovernanceBadge";
import OpportunityDetail from "./OpportunityDetail";
import type { ScoredOpportunity } from "./lib/opportunities";
import PriorityFormModal from "./PriorityFormModal";
import { OPEN_OPPORTUNITY_EVENT, REVIEW_CHANGED_EVENT, useToolActions, type ToolRequest } from "./toolActions";
import { InfoTip } from "./Guardrails";
import { NoSyncChip } from "./evidence";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8010";

const numberFormat = new Intl.NumberFormat("en-US");

function tier(o: ScoredOpportunity) {
  if (o.high_priority) {
    return { label: "High Priority", className: "bg-emerald-50 text-emerald-700 ring-emerald-600/20", bar: "bg-emerald-500" };
  }
  if (o.score >= 45) {
    return { label: "Medium", className: "bg-indigo-50 text-indigo-700 ring-indigo-600/20", bar: "bg-indigo-500" };
  }
  return { label: "Low", className: "bg-slate-100 text-slate-600 ring-slate-500/20", bar: "bg-slate-400" };
}

/** The brief hand-off for a row. The id lets the server enforce the human-approval gate. */
function briefRequest(o: ScoredOpportunity): ToolRequest {
  return { tool: "brief", keyword: o.keyword, audience: `Readers interested in ${o.priority}`, intent: inferIntent(o.keyword), opportunityId: o.id };
}

type MenuPos = { top?: number; bottom?: number; right: number };

/** Primary "Generate Brief" hand-off plus a menu of other tools pre-filled with this row's keyword. */
function RowActions({ o, onReview }: { o: ScoredOpportunity; onReview: () => void }) {
  const { openTool } = useToolActions();
  const [pos, setPos] = useState<MenuPos | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pos) return;
    const close = () => setPos(null);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !buttonRef.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true); // the menu is fixed-position: dismiss rather than drift
    window.addEventListener("resize", close);
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [pos]);

  function toggleMenu() {
    if (pos) return setPos(null);
    const r = buttonRef.current?.getBoundingClientRect();
    if (!r) return;
    const right = window.innerWidth - r.right;
    // open upwards when there is not enough room below the button
    setPos(window.innerHeight - r.bottom > 280 ? { top: r.bottom + 4, right } : { bottom: window.innerHeight - r.top + 4, right });
  }

  function run(request: ToolRequest) {
    setPos(null);
    openTool(request);
  }

  const items: { label: string; hint: string; icon: string; request: ToolRequest }[] = [
    { icon: "🔄", label: "Plan a content refresh", hint: "Open Content Refresh for this keyword", request: { tool: "refresh", keyword: o.keyword } },
    { icon: "🗺️", label: "Map a topic cluster", hint: "Start a cluster from this topic", request: { tool: "clusters", seedTopic: o.keyword } },
    { icon: "🤖", label: "Audit AI visibility", hint: "GEO & LLM audit with this keyword as the target query", request: { tool: "geo", queries: o.keyword } },
    { icon: "⚡", label: "Benchmark vs a competitor", hint: "Head-to-head GEO for this query", request: { tool: "simulator", query: o.keyword } },
    ...(o.cannibalized
      ? [{ icon: "🧩", label: "Review cannibalization", hint: "This keyword has competing URLs", request: { tool: "cannibalization" } as ToolRequest }]
      : []),
  ];

  return (
    <div className="flex items-center justify-end gap-2">
      {o.governance.approved ? (
        <button
          type="button"
          onClick={() => run(briefRequest(o))}
          aria-label={`Generate a content brief for ${o.keyword}`}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
        >
          ✨ Generate Brief
        </button>
      ) : (
        <button
          type="button"
          onClick={onReview}
          aria-label={`Generate Brief is locked for ${o.keyword} until a named reviewer approves it. Open the review.`}
          title="Locked until a named reviewer approves. Click to open the review."
          className="rounded-md bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-500 ring-1 ring-inset ring-slate-300 transition hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          🔒 Needs approval
        </button>
      )}
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={pos !== null}
        aria-label={`More tools for ${o.keyword}`}
        onClick={toggleMenu}
        className="rounded-md px-2.5 py-1.5 text-sm font-medium text-slate-600 ring-1 ring-inset ring-slate-300 transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
      >
        More ▾
      </button>
      {pos &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={`Tools for ${o.keyword}`}
            style={{ position: "fixed", top: pos.top, bottom: pos.bottom, right: pos.right }}
            onKeyDown={(e) => {
              if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
              e.preventDefault();
              const els = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
              const i = els.indexOf(document.activeElement as HTMLElement);
              els[e.key === "ArrowDown" ? (i + 1) % els.length : (i - 1 + els.length) % els.length]?.focus();
            }}
            className="z-50 w-64 rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl"
          >
            {items.map((it) => (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                onClick={() => run(it.request)}
                className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition hover:bg-indigo-50 focus:bg-indigo-50 focus:outline-none"
              >
                <span className="mt-0.5" aria-hidden="true">
                  {it.icon}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-slate-900">{it.label}</span>
                  <span className="block text-xs text-slate-500">{it.hint}</span>
                </span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}

type FormState = { mode: "add" } | { mode: "edit"; item: ScoredOpportunity } | null;
type TierFilter = "all" | "High Priority" | "Medium" | "Low";

export default function OpportunityTable({ items, threshold, customError }: { items: ScoredOpportunity[]; threshold: number; customError?: string | null }) {
  const router = useRouter();
  const { openTool } = useToolActions();
  const [refreshing, startRefresh] = useTransition();
  const [openId, setOpenId] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [tierFilter, setTierFilter] = useState<TierFilter>("all");
  const [form, setForm] = useState<FormState>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  // "Review and sign off" from the attention strip: show that row (clearing any filter that hides it) and scroll to it.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const id = (e as CustomEvent<{ id: number }>).detail?.id;
      if (typeof id !== "number") return;
      setQuery("");
      setTierFilter("all");
      setOpenId(id);
      window.setTimeout(() => document.getElementById(`opportunity-row-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
    };
    window.addEventListener(OPEN_OPPORTUNITY_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_OPPORTUNITY_EVENT, onOpen);
  }, []);

  const sorted = [...items].sort((a, b) => b.score - a.score);
  const q = query.trim().toLowerCase();
  const visible = sorted.filter(
    (o) => (!q || o.priority.toLowerCase().includes(q) || o.keyword.toLowerCase().includes(q)) && (tierFilter === "all" || tier(o).label === tierFilter),
  );
  const filtering = q !== "" || tierFilter !== "all";

  // The table is rendered on the server (together with the metric cards), so re-fetch it after any change.
  const refresh = () =>
    startRefresh(() => {
      router.refresh();
      window.dispatchEvent(new Event(REVIEW_CHANGED_EVENT)); // the attention strip reloads too
    });

  async function remove(o: ScoredOpportunity) {
    if (!o.dbId || !window.confirm(`Delete the business priority “${o.priority}”?`)) return;
    setDeletingId(o.id);
    setRowError(null);
    try {
      const res = await fetch(`${API_URL}/api/v1/priorities/${o.dbId}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) {
        const data = await res.json().catch(() => ({}));
        throw new Error(typeof data.detail === "string" ? data.detail : `Delete failed (${res.status})`);
      }
      refresh();
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Could not delete the priority. Is the FastAPI server running?");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm" aria-busy={refreshing}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Business priorities</h2>
          <p className="text-xs text-slate-400">
            4-factor opportunity score · High Priority at {threshold}+ · {filtering ? `${visible.length} of ${items.length}` : items.length} shown
          </p>
          <p className="mt-1">
            <NoSyncChip title="Scores come from reviewer ratings and impressions are sample or typed-in figures. Nothing here is pulled from Search Console.">Ratings and typed-in figures · no sync date</NoSyncChip>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="priority-search">
            Search priorities
          </label>
          <input
            id="priority-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search topic or keyword…"
            className="w-48 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 sm:w-56"
          />
          <label className="sr-only" htmlFor="priority-tier">
            Filter by status
          </label>
          <select
            id="priority-tier"
            value={tierFilter}
            onChange={(e) => setTierFilter(e.target.value as TierFilter)}
            className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-700 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
          >
            <option value="all">All statuses</option>
            <option value="High Priority">High Priority</option>
            <option value="Medium">Medium</option>
            <option value="Low">Low</option>
          </select>
          <button
            type="button"
            onClick={() => setForm({ mode: "add" })}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
          >
            + Add Business Priority
          </button>
        </div>
      </div>
      {(rowError || customError) && (
        <p role="alert" className="border-b border-rose-200 bg-rose-50 px-5 py-2 text-sm text-rose-700">
          {rowError ?? customError}
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th scope="col" className="px-5 py-3">Priority</th>
              <th scope="col" className="px-5 py-3 text-right">
                Impressions
                <InfoTip text="Not pulled from Search Console. Built-in rows are sample figures and custom rows are numbers you typed in." />
              </th>
              <th scope="col" className="px-5 py-3">
                Score
                <InfoTip text="A 0 to 100 ranking aid built from four 1 to 5 ratings. It orders what to look at first. It does not predict traffic, leads, or revenue." />
              </th>
              <th scope="col" className="px-5 py-3">Status</th>
              <th scope="col" className="px-5 py-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {visible.map((o) => {
              const t = tier(o);
              const open = openId === o.id;
              const panelId = `score-detail-${o.id}`;
              return (
                <Fragment key={o.id}>
                  <tr id={`opportunity-row-${o.id}`} className="hover:bg-slate-50/60">
                    <td className="px-5 py-4">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="flex flex-wrap items-center gap-1.5 font-medium text-slate-900">
                            {o.priority}
                            {o.custom ? (
                              <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-700">Custom</span>
                            ) : (
                              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Sample</span>
                            )}
                          </p>
                          <p className="text-xs text-slate-500">{o.keyword}</p>
                          {o.custom && o.level && <p className="text-xs text-slate-400">Your level: {o.level}</p>}
                        </div>
                        {o.custom && (
                          <div className="flex shrink-0 items-center gap-0.5">
                            <button
                              type="button"
                              onClick={() => setForm({ mode: "edit", item: o })}
                              aria-label={`Edit ${o.priority}`}
                              title="Edit"
                              className="rounded p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                            >
                              ✏️
                            </button>
                            <button
                              type="button"
                              onClick={() => remove(o)}
                              disabled={deletingId === o.id}
                              aria-label={`Delete ${o.priority}`}
                              title="Delete"
                              className="rounded p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 disabled:opacity-40"
                            >
                              🗑️
                            </button>
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-4 text-right tabular-nums text-slate-700">{numberFormat.format(o.impressions)}</td>
                    <td className="px-5 py-4">
                      <button
                        type="button"
                        onClick={() => setOpenId(open ? null : o.id)}
                        aria-expanded={open}
                        aria-controls={panelId}
                        title="Show score breakdown"
                        className="group flex items-center gap-3 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                      >
                        <div
                          className="h-2 w-24 overflow-hidden rounded-full bg-slate-100"
                          role="progressbar"
                          aria-valuenow={o.score}
                          aria-valuemin={0}
                          aria-valuemax={100}
                        >
                          <div className={`h-full rounded-full ${t.bar}`} style={{ width: `${o.score}%` }} />
                        </div>
                        <span className="w-10 font-semibold tabular-nums text-slate-900">{o.score}</span>
                        <span className="text-xs text-slate-400 group-hover:text-slate-600" aria-hidden="true">
                          {open ? "▲" : "▼"}
                        </span>
                      </button>
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex flex-col items-start gap-1.5">
                        {/* the review state is the one thing that should catch the eye */}
                        <StatusBadge status={o.governance.status} size="md" />
                        {/* secondary categories: muted, so they never compete with the workflow state */}
                        <div className="flex flex-wrap gap-1">
                          <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">
                            <span className={`h-1.5 w-1.5 rounded-full ${t.bar}`} aria-hidden="true" />
                            {t.label}
                          </span>
                          {o.cannibalized && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">
                              <span className="h-1.5 w-1.5 rounded-full bg-rose-400" aria-hidden="true" />
                              Cannibalization
                            </span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-4 text-right">
                      <RowActions o={o} onReview={() => setOpenId(o.id)} />
                    </td>
                  </tr>
                  {open && (
                    <tr id={panelId} className="bg-slate-50">
                      <td colSpan={5} className="px-5 py-5">
                        <OpportunityDetail item={o} threshold={threshold} onChanged={refresh} onGenerateBrief={() => openTool(briefRequest(o))} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-10 text-center text-sm text-slate-500">
                  {filtering ? "No priorities match your search or filter." : "No business priorities yet."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {form && (
        <PriorityFormModal
          key={form.mode === "edit" ? form.item.id : "new"}
          initial={form.mode === "edit" ? form.item : undefined}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            refresh();
          }}
        />
      )}
    </section>
  );
}

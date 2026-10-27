"use client";

import { useEffect, useState } from "react";
import StatusBadge from "./GovernanceBadge";
import { COMMENT_MIN, OPPORTUNITIES_API, VERDICT_OPTIONS, formatWhen, readError, reviewerNameError, type HistoryEntry, type HistoryResponse } from "./lib/governance";
import type { FactorBreakdown, ScoredOpportunity, Verdict } from "./lib/opportunities";
import { FreshnessChip } from "./evidence";

const NAME_KEY = "seo-dashboard.reviewer-name";

function loadName(): string {
  try {
    return window.localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveName(name: string): void {
  try {
    window.localStorage.setItem(NAME_KEY, name);
  } catch {
    /* private mode: the name just is not remembered */
  }
}

function FactorCard({ factor }: { factor: FactorBreakdown }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-slate-800">{factor.label}</p>
        <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">{factor.weight_pct}% weight</span>
      </div>
      <div className="mt-3 flex items-baseline gap-1">
        <span className="text-2xl font-semibold tabular-nums text-slate-900">{factor.rating}</span>
        <span className="text-sm text-slate-400">/ {factor.max_rating}</span>
      </div>
      <div className="mt-2 flex gap-1" role="img" aria-label={`Rated ${factor.rating} out of ${factor.max_rating}`}>
        {Array.from({ length: factor.max_rating }, (_, i) => (
          <span key={i} className={`h-1.5 flex-1 rounded-full ${i < factor.rating ? "bg-indigo-500" : "bg-slate-200"}`} />
        ))}
      </div>
      <p className="mt-2 text-xs text-slate-500">
        Contributes <span className="font-semibold text-slate-700">{factor.contribution.toFixed(1)}</span> of {factor.max_contribution.toFixed(0)} pts
      </p>
    </div>
  );
}

type GateProps = {
  step: number;
  title: string;
  description: string;
  state: "open" | "locked" | "done";
  lockedReason: string;
  doneText?: string;
  busy?: boolean;
  label: string;
  onClick: () => void;
};

/** One workflow step. Locked steps are visibly locked and say why; the server refuses them as well. */
function Gate({ step, title, description, state, lockedReason, doneText, busy, label, onClick }: GateProps) {
  return (
    <li className={`rounded-lg border p-3 ${state === "locked" ? "border-slate-200 bg-slate-50" : state === "done" ? "border-emerald-200 bg-emerald-50/50" : "border-indigo-200 bg-white"}`}>
      <div className="flex items-start gap-3">
        <span
          className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
            state === "done" ? "bg-emerald-600 text-white" : state === "locked" ? "bg-slate-200 text-slate-500" : "bg-indigo-600 text-white"
          }`}
          aria-hidden="true"
        >
          {state === "done" ? "✓" : state === "locked" ? "🔒" : step}
        </span>
        <div className="min-w-0 flex-1">
          <p className={`text-sm font-semibold ${state === "locked" ? "text-slate-500" : "text-slate-900"}`}>{title}</p>
          <p className="text-xs text-slate-500">{state === "locked" ? lockedReason : state === "done" ? (doneText ?? "Done") : description}</p>
        </div>
        {state !== "done" && (
          <button
            type="button"
            onClick={onClick}
            disabled={state === "locked" || busy}
            aria-disabled={state === "locked"}
            className={`shrink-0 rounded-md px-3 py-1.5 text-sm font-medium shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 ${
              state === "locked" ? "cursor-not-allowed bg-slate-200 text-slate-400" : "bg-indigo-600 text-white hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-60"
            }`}
          >
            {state === "locked" ? `🔒 ${label}` : busy ? "Working…" : label}
          </button>
        )}
      </div>
    </li>
  );
}

const EVENT_TITLES: Record<string, (e: HistoryEntry) => string> = {
  decision: (e) => `${e.actor} ${e.verdict === "Approved" ? "approved" : e.verdict === "Reject" ? "rejected" : "requested changes"}`,
  baseline_locked: (e) => `${e.actor} locked the measurement baseline`,
  completed: (e) => `${e.actor} marked it completed`,
  reset: () => "Sent back to Proposed",
  brief_generated: () => "AI content brief drafted",
  deleted: () => "Opportunity deleted",
};

function HistoryItem({ e }: { e: HistoryEntry }) {
  const isAi = e.actor === "AI draft";
  return (
    <li className="relative border-l-2 border-slate-200 pb-4 pl-4 last:pb-0">
      <span className={`absolute -left-[5px] top-1.5 h-2 w-2 rounded-full ${isAi ? "bg-violet-400" : e.event === "decision" ? "bg-indigo-500" : "bg-slate-400"}`} aria-hidden="true" />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="text-sm font-medium text-slate-900">{(EVENT_TITLES[e.event] ?? (() => e.event))(e)}</p>
        {e.event !== "brief_generated" && e.to_status && e.from_status !== e.to_status && (
          <span className="flex items-center gap-1 text-xs text-slate-400">
            {e.from_status && <StatusBadge status={e.from_status} />}
            <span aria-hidden="true">→</span>
            <StatusBadge status={e.to_status} />
          </span>
        )}
        <time className="ml-auto text-xs text-slate-400" dateTime={e.created_at} title={`Entry hash ${e.hash.slice(0, 16)}…`}>
          {formatWhen(e.created_at)}
        </time>
      </div>
      {e.comment && <p className="mt-1 whitespace-pre-wrap break-words rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700">“{e.comment}”</p>}
    </li>
  );
}

type Props = {
  item: ScoredOpportunity;
  threshold: number;
  onChanged: () => void; // the server-rendered table must refresh after any change
  onGenerateBrief: () => void;
};

export default function OpportunityDetail({ item, threshold, onChanged, onGenerateBrief }: Props) {
  const g = item.governance;
  const status = g.status;
  const closed = status === "Measuring" || status === "Completed";

  const [reviewer, setReviewer] = useState(loadName);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [comment, setComment] = useState("");
  const [showErrors, setShowErrors] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<"baseline" | "complete" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(`${OPPORTUNITIES_API}/${item.id}/history?limit=50`, { signal: controller.signal });
        if (!res.ok) throw new Error(await readError(res));
        setHistory(await res.json());
        setHistoryError(null);
      } catch (e) {
        if (controller.signal.aborted) return;
        setHistoryError(e instanceof Error ? e.message : "Could not load the history. Is the FastAPI server running?");
      }
    })();
    return () => controller.abort();
  }, [item.id, g.status, g.updated_at, reloadTick]);

  const nameError = reviewerNameError(reviewer);
  const commentError = comment.trim().length < COMMENT_MIN ? `Explain your decision in at least ${COMMENT_MIN} characters, so it can be understood later.` : null;
  const verdictError = verdict ? null : "Choose a verdict.";

  function changed() {
    setReloadTick((n) => n + 1);
    onChanged();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setShowErrors(true);
    setNotice(null);
    if (nameError || commentError || verdictError || !verdict) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const res = await fetch(`${OPPORTUNITIES_API}/${item.id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewer_name: reviewer.trim(), verdict, comment: comment.trim() }),
      });
      if (!res.ok) throw new Error(await readError(res));
      saveName(reviewer.trim());
      setNotice(verdict === "Approved" ? "Approved. Brief generation and measurement are now unlocked." : verdict === "Reject" ? "Rejected. Nothing downstream will unlock." : "Sent back for changes. Nothing downstream will unlock until it is approved.");
      setVerdict(null);
      setComment("");
      setShowErrors(false);
      changed();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not record the decision. Is the FastAPI server running?");
    } finally {
      setSubmitting(false);
    }
  }

  async function runAction(kind: "baseline" | "complete") {
    setActionError(null);
    setNotice(null);
    if (nameError) {
      setShowErrors(true);
      setActionError("Enter your name in the Reviewer name field first: this action is signed in the history.");
      return;
    }
    const prompt =
      kind === "baseline"
        ? "Lock the measurement baseline?\n\nThis freezes today's score and numbers as the point to measure against, starts measurement, and closes the review: the verdict and the opportunity's content can no longer be changed."
        : "Mark this opportunity completed?\n\nThis closes it. The verdict can no longer be changed.";
    if (!window.confirm(prompt)) return;
    setBusy(kind);
    try {
      const res = await fetch(`${OPPORTUNITIES_API}/${item.id}/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewer_name: reviewer.trim(), note: "" }),
      });
      if (!res.ok) throw new Error(await readError(res));
      saveName(reviewer.trim());
      setNotice(kind === "baseline" ? "Baseline locked. Measurement has started." : "Marked completed.");
      changed();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "The action failed. Is the FastAPI server running?");
    } finally {
      setBusy(null);
    }
  }

  const approved = g.approved;
  const lockedReason = status === "Proposed" ? "Locked until a named reviewer approves." : status === "Needs changes" ? "Locked: changes were requested. It needs a new review." : "Locked: a reviewer rejected this opportunity.";

  return (
    <div className="space-y-5">
      {/* status + latest decision */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={status} size="md" />
            <span className="text-sm text-slate-500">{item.priority}</span>
          </div>
          {g.reviewer && g.decided_at && (
            <p className="text-sm text-slate-600">
              Last decision: <span className="font-medium text-slate-800">{g.verdict === "Reject" ? "Rejected" : g.verdict}</span> by <span className="font-medium text-slate-800">{g.reviewer}</span> on {formatWhen(g.decided_at)}
            </p>
          )}
          {g.comment && <p className="max-w-2xl whitespace-pre-wrap break-words text-sm text-slate-500">“{g.comment}”</p>}
          {!g.reviewer && <p className="text-sm text-slate-500">Nobody has reviewed this yet. AI can draft work for it, but a named person has to decide.</p>}
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* human validation */}
        <section aria-labelledby={`hv-${item.id}`} className="rounded-xl border-2 border-indigo-200 bg-white p-4 shadow-sm">
          <h4 id={`hv-${item.id}`} className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <span aria-hidden="true">🧑‍⚖️</span> Human validation
          </h4>
          <p className="mt-0.5 text-xs text-slate-500">AI drafts, humans decide. Sign off below; the decision is written to a permanent history.</p>

          {closed ? (
            <p className="mt-3 rounded-md bg-slate-50 p-3 text-sm text-slate-600">
              Review closed: this opportunity is <b>{status}</b>, so the approval can no longer be changed.
            </p>
          ) : (
            <form onSubmit={submit} className="mt-3 space-y-3" noValidate>
              <label className="block text-sm font-medium text-slate-700">
                Reviewer name
                <input
                  type="text"
                  value={reviewer}
                  onChange={(e) => setReviewer(e.target.value)}
                  autoComplete="name"
                  maxLength={80}
                  placeholder="Your full name"
                  aria-invalid={showErrors && Boolean(nameError)}
                  className={`mt-1 block w-full rounded-lg border px-3 py-2 text-sm font-normal text-slate-900 focus:outline-none focus:ring-2 ${
                    showErrors && nameError ? "border-rose-400 focus:ring-rose-500/20" : "border-slate-300 focus:border-indigo-500 focus:ring-indigo-500/20"
                  }`}
                />
                {showErrors && nameError && (
                  <span role="alert" className="mt-1 block text-xs text-rose-600">
                    {nameError}
                  </span>
                )}
              </label>

              <fieldset>
                <legend className="text-sm font-medium text-slate-700">Verdict</legend>
                <div className="mt-1 grid gap-2 sm:grid-cols-3">
                  {VERDICT_OPTIONS.map((o) => (
                    <label
                      key={o.value}
                      className={`cursor-pointer rounded-lg border-2 px-3 py-2 text-center transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-indigo-500 ${
                        verdict === o.value ? `${o.active} ring-2` : "border-slate-200 text-slate-600 hover:border-slate-300"
                      }`}
                    >
                      <input type="radio" name={`verdict-${item.id}`} value={o.value} checked={verdict === o.value} onChange={() => setVerdict(o.value)} className="sr-only" />
                      <span className="block text-sm font-semibold">{o.label}</span>
                      <span className="block text-[11px] leading-tight opacity-80">{o.hint}</span>
                    </label>
                  ))}
                </div>
                {showErrors && verdictError && (
                  <p role="alert" className="mt-1 text-xs text-rose-600">
                    {verdictError}
                  </p>
                )}
              </fieldset>

              <label className="block text-sm font-medium text-slate-700">
                Reviewer comment <span className="font-normal text-rose-600">(required)</span>
                <textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  rows={3}
                  maxLength={2000}
                  placeholder="Why this verdict? What did you check, or what must change?"
                  aria-invalid={showErrors && Boolean(commentError)}
                  className={`mt-1 block w-full rounded-lg border px-3 py-2 text-sm font-normal text-slate-900 focus:outline-none focus:ring-2 ${
                    showErrors && commentError ? "border-rose-400 focus:ring-rose-500/20" : "border-slate-300 focus:border-indigo-500 focus:ring-indigo-500/20"
                  }`}
                />
                <span className="flex justify-between text-xs">
                  {showErrors && commentError ? (
                    <span role="alert" className="text-rose-600">
                      {commentError}
                    </span>
                  ) : (
                    <span />
                  )}
                  <span className="text-slate-400">{comment.length}/2000</span>
                </span>
              </label>

              {formError && (
                <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-2.5 text-sm text-red-600">
                  ⚠️ {formError}
                </p>
              )}
              <button
                type="submit"
                disabled={submitting}
                className="w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
              >
                {submitting ? "Recording…" : "Record decision"}
              </button>
            </form>
          )}
          {notice && (
            <p role="status" className="mt-3 rounded-md bg-emerald-50 p-2.5 text-sm text-emerald-800">
              ✓ {notice}
            </p>
          )}
        </section>

        {/* workflow gates */}
        <section aria-labelledby={`wf-${item.id}`} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h4 id={`wf-${item.id}`} className="text-sm font-semibold text-slate-900">
            Workflow
          </h4>
          <p className="mt-0.5 text-xs text-slate-500">Each step stays locked until a named reviewer has approved. The server enforces this too.</p>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            A baseline records Search Console numbers from the last sync: <FreshnessChip source="gsc" />
          </p>
          <ol className="mt-3 space-y-2">
            <Gate
              step={1}
              title="Generate content brief"
              description="Draft an SEO brief for this keyword (AI draft; review it before use)."
              state={approved ? "open" : "locked"}
              lockedReason={lockedReason}
              label="Generate Brief"
              onClick={onGenerateBrief}
            />
            <Gate
              step={2}
              title="Lock measurement baseline"
              description="Freeze today's numbers to measure against. This closes the review."
              state={status === "Approved" ? "open" : status === "Measuring" || status === "Completed" ? "done" : "locked"}
              lockedReason={lockedReason}
              doneText={g.baseline_locked_at ? `Baseline locked ${formatWhen(g.baseline_locked_at)}` : "Completed without a baseline"}
              busy={busy === "baseline"}
              label="Lock baseline"
              onClick={() => runAction("baseline")}
            />
            <Gate
              step={3}
              title="Mark completed"
              description="Close the opportunity once the work is done."
              state={status === "Completed" ? "done" : status === "Approved" || status === "Measuring" ? "open" : "locked"}
              lockedReason={lockedReason}
              doneText={`Completed ${formatWhen(g.completed_at)}`}
              busy={busy === "complete"}
              label="Mark completed"
              onClick={() => runAction("complete")}
            />
          </ol>
          {actionError && (
            <p role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 p-2.5 text-sm text-red-600">
              ⚠️ {actionError}
            </p>
          )}
        </section>
      </div>

      {/* score breakdown */}
      <section aria-label="Score breakdown">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {item.factors.map((f) => (
            <FactorCard key={f.key} factor={f} />
          ))}
        </div>
        {item.custom && item.rated === false && (
          <p className="mt-3 rounded-md bg-amber-50 p-2.5 text-xs text-amber-800">
            Business Priority comes from your level ({item.level}). The other three factors default to a neutral 3 until you rate them: use Edit, then Advanced scoring.
          </p>
        )}
        <p className="mt-3 text-xs text-slate-500">
          Score = Σ(rating × weight) ÷ 5 × 100 = <span className="font-semibold text-slate-700">{item.score.toFixed(1)}</span>
          {item.high_priority ? (
            <span className="font-medium text-emerald-700"> · High Priority (≥ {threshold})</span>
          ) : (
            <span> · {(threshold - item.score).toFixed(1)} pts below the High Priority threshold of {threshold}</span>
          )}
        </p>
      </section>

      {/* audit trail */}
      <section aria-label="History" className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-sm font-semibold text-slate-900">History</h4>
          {history && (
            <span className={`text-xs ${history.integrity.ok ? "text-emerald-700" : "font-semibold text-rose-600"}`}>
              {history.integrity.ok ? `✓ Audit log verified (${history.integrity.entries} entries, tamper-evident)` : `⚠ Audit log integrity check FAILED at entry ${history.integrity.first_bad_id}`}
            </span>
          )}
        </div>
        {historyError && <p className="mt-2 text-sm text-rose-600">{historyError}</p>}
        {!history && !historyError && <p className="mt-2 text-sm text-slate-500">Loading history…</p>}
        {history && history.items.length === 0 && <p className="mt-2 text-sm text-slate-500">No activity yet. Every decision, status change and AI draft will be recorded here.</p>}
        {history && history.items.length > 0 && (
          <ol className="mt-3">
            {history.items.map((e) => (
              <HistoryItem key={e.id} e={e} />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

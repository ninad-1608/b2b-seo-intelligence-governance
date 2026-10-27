"use client";

import { useEffect, useRef, useState } from "react";
import type { PriorityLevel, ScoredOpportunity } from "./lib/opportunities";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8010";

type Props = {
  initial?: ScoredOpportunity; // present when editing a stored priority
  onClose: () => void;
  onSaved: () => void;
};

type Fields = { name: string; keyword: string; impressions: string; level: PriorityLevel; fpe: string; ro: string; qu: string };
type Errors = Partial<Record<keyof Fields | "form", string>>;

const LEVELS: { value: PriorityLevel; label: string }[] = [
  { value: "High", label: "High Priority" },
  { value: "Medium", label: "Medium Priority" },
  { value: "Low", label: "Low Priority" },
];

const RATING_HELP = "1 (weak) to 5 (strong). Leave on “Not rated” to use a neutral 3.";

function validate(f: Fields): Errors {
  const e: Errors = {};
  const name = f.name.trim().replace(/\s+/g, " ");
  const keyword = f.keyword.trim().replace(/\s+/g, " ");
  if (name.length < 2) e.name = "Enter a priority name of at least 2 characters.";
  else if (name.length > 120) e.name = "Keep the name under 120 characters.";
  if (keyword.length < 2) e.keyword = "Enter a target keyword of at least 2 characters.";
  else if (keyword.length > 150) e.keyword = "Keep the keyword under 150 characters.";
  const imp = f.impressions.trim().replace(/,/g, "");
  if (imp !== "" && !/^\d+$/.test(imp)) e.impressions = "Use a whole number, or leave it blank for 0.";
  else if (imp !== "" && Number(imp) > 1_000_000_000) e.impressions = "That number is too large.";
  return e;
}

async function readError(res: Response): Promise<{ field?: keyof Fields; message: string }> {
  const data = await res.json().catch(() => ({}));
  const detail = Array.isArray(data.detail) ? data.detail[0]?.msg : data.detail;
  const message = typeof detail === "string" ? detail.replace(/^Value error, /, "") : `Request failed (${res.status})`;
  return { field: res.status === 409 && /keyword/i.test(message) ? "keyword" : undefined, message };
}

const BASE_INPUT = "mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20";

function RatingSelect({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label htmlFor={id} className="block text-xs font-medium text-slate-600">
      {label}
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={BASE_INPUT}>
        <option value="">Not rated</option>
        {[1, 2, 3, 4, 5].map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function PriorityFormModal({ initial, onClose, onSaved }: Props) {
  const editing = Boolean(initial?.dbId);
  const rated = initial?.rated ? initial.factors.map((f) => String(f.rating)) : ["", "", "", ""];
  const [f, setF] = useState<Fields>({
    name: initial?.priority ?? "",
    keyword: initial?.keyword ?? "",
    impressions: initial ? String(initial.impressions) : "",
    level: initial?.level ?? "High",
    fpe: rated[1],
    ro: rated[2],
    qu: rated[3],
  });
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [serverErrors, setServerErrors] = useState<Errors>({});
  const [showAdvanced, setShowAdvanced] = useState(Boolean(initial?.rated));
  const [saving, setSaving] = useState(false);
  const firstField = useRef<HTMLInputElement>(null);

  const clientErrors = validate(f);
  const errors: Errors = { ...Object.fromEntries(Object.entries(clientErrors).filter(([k]) => touched.has(k))), ...serverErrors };

  useEffect(() => {
    firstField.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const set = <K extends keyof Fields>(k: K, v: Fields[K]) => {
    setF((prev) => ({ ...prev, [k]: v }));
    setServerErrors({});
  };
  const blur = (k: keyof Fields) => setTouched((prev) => new Set(prev).add(k));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setTouched(new Set(["name", "keyword", "impressions"]));
    if (Object.keys(clientErrors).length > 0) return;
    setSaving(true);
    setServerErrors({});
    const rating = (v: string) => (v === "" ? null : Number(v));
    const body = {
      name: f.name.trim(),
      keyword: f.keyword.trim(),
      impressions: f.impressions.trim() === "" ? 0 : Number(f.impressions.trim().replace(/,/g, "")),
      level: f.level,
      first_party_evidence: rating(f.fpe),
      ranking_opportunity: rating(f.ro),
      query_url_evidence: rating(f.qu),
    };
    try {
      const res = await fetch(editing ? `${API_URL}/api/v1/priorities/${initial!.dbId}` : `${API_URL}/api/v1/priorities`, {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await readError(res);
        setServerErrors(err.field ? { [err.field]: err.message } : { form: err.message });
        return;
      }
      onSaved();
    } catch {
      setServerErrors({ form: "Could not reach the API. Is the FastAPI server running?" });
    } finally {
      setSaving(false);
    }
  }

  const inputCls = (bad: boolean) =>
    `mt-1 block w-full rounded-lg border px-3 py-2 text-sm font-normal text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 ${
      bad ? "border-rose-400 focus:border-rose-500 focus:ring-rose-500/20" : "border-slate-300 focus:border-indigo-500 focus:ring-indigo-500/20"
    }`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={save}
        noValidate
        role="dialog"
        aria-modal="true"
        aria-labelledby="priority-form-title"
        className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl sm:rounded-2xl"
      >
        <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 id="priority-form-title" className="text-base font-semibold text-slate-900">
              {editing ? "Edit Business Priority" : "Add Business Priority"}
            </h2>
            <p className="text-sm text-slate-500">It is scored and gets the same tool shortcuts as the other rows.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            ✕
          </button>
        </header>

        <div className="space-y-4 overflow-y-auto px-5 py-5">
          {editing && initial && initial.governance.status !== "Proposed" && (
            <p role="note" className={`rounded-md p-3 text-sm ${initial.governance.status === "Measuring" || initial.governance.status === "Completed" ? "bg-rose-50 text-rose-800" : "bg-amber-50 text-amber-800"}`}>
              {initial.governance.status === "Measuring" || initial.governance.status === "Completed"
                ? `This priority is ${initial.governance.status}. Its content is frozen so the measurement baseline stays valid, so saving will be refused.`
                : `This priority is ${initial.governance.status}. Saving changes sends it back to Proposed and a reviewer has to sign it off again.`}
            </p>
          )}
          <label className="block text-sm font-medium text-slate-700">
            Priority Name / Topic
            <input
              ref={firstField}
              type="text"
              value={f.name}
              onChange={(e) => set("name", e.target.value)}
              onBlur={() => blur("name")}
              maxLength={120}
              placeholder="e.g. AI Marketing Automation Platform"
              aria-invalid={Boolean(errors.name)}
              aria-describedby={errors.name ? "pf-name-err" : undefined}
              className={inputCls(Boolean(errors.name))}
            />
            {errors.name && (
              <span id="pf-name-err" role="alert" className="mt-1 block text-xs text-rose-600">
                {errors.name}
              </span>
            )}
          </label>

          <label className="block text-sm font-medium text-slate-700">
            Target Keyword / Query
            <input
              type="text"
              value={f.keyword}
              onChange={(e) => set("keyword", e.target.value)}
              onBlur={() => blur("keyword")}
              maxLength={150}
              placeholder="e.g. b2b ai marketing engine"
              aria-invalid={Boolean(errors.keyword)}
              aria-describedby={errors.keyword ? "pf-kw-err" : undefined}
              className={inputCls(Boolean(errors.keyword))}
            />
            {errors.keyword && (
              <span id="pf-kw-err" role="alert" className="mt-1 block text-xs text-rose-600">
                {errors.keyword}
              </span>
            )}
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm font-medium text-slate-700">
              Monthly Impressions <span className="font-normal text-slate-400">(optional)</span>
              <input
                type="text"
                inputMode="numeric"
                value={f.impressions}
                onChange={(e) => set("impressions", e.target.value)}
                onBlur={() => blur("impressions")}
                placeholder="0"
                aria-invalid={Boolean(errors.impressions)}
                aria-describedby={errors.impressions ? "pf-imp-err" : undefined}
                className={inputCls(Boolean(errors.impressions))}
              />
              {errors.impressions && (
                <span id="pf-imp-err" role="alert" className="mt-1 block text-xs text-rose-600">
                  {errors.impressions}
                </span>
              )}
            </label>
            <label className="block text-sm font-medium text-slate-700">
              Priority Level
              <select value={f.level} onChange={(e) => set("level", e.target.value as PriorityLevel)} className={inputCls(false) + " bg-white"}>
                {LEVELS.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="rounded-lg border border-slate-200">
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              aria-expanded={showAdvanced}
              className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Advanced scoring (optional)
              <span aria-hidden="true" className="text-xs text-slate-400">
                {showAdvanced ? "▲" : "▼"}
              </span>
            </button>
            {showAdvanced && (
              <div className="space-y-3 border-t border-slate-200 p-3">
                <p className="text-xs text-slate-500">
                  The priority level sets the Business Priority factor (High 5, Medium 3, Low 1). Rate the other three factors if you know them. {RATING_HELP}
                </p>
                <div className="grid gap-3 sm:grid-cols-3">
                  <RatingSelect id="pf-fpe" label="First-Party Evidence" value={f.fpe} onChange={(v) => set("fpe", v)} />
                  <RatingSelect id="pf-ro" label="Ranking Opportunity" value={f.ro} onChange={(v) => set("ro", v)} />
                  <RatingSelect id="pf-qu" label="Query-to-URL Evidence" value={f.qu} onChange={(v) => set("qu", v)} />
                </div>
              </div>
            )}
          </div>

          {errors.form && (
            <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-600">
              ⚠️ {errors.form}
            </p>
          )}
        </div>

        <footer className="flex items-center justify-end gap-3 border-t border-slate-200 bg-slate-50 px-5 py-3">
          <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100">
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save Priority"}
          </button>
        </footer>
      </form>
    </div>
  );
}

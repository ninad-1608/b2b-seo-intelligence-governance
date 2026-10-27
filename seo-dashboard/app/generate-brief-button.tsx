"use client";

import { useState } from "react";

type Props = { keyword: string };

export default function GenerateBriefButton({ keyword }: Props) {
  const [state, setState] = useState<"idle" | "loading" | "queued">("idle");

  async function handleClick() {
    setState("loading");
    // Placeholder: wire this to your brief-generation endpoint.
    await new Promise((resolve) => setTimeout(resolve, 800));
    setState("queued");
  }

  if (state === "queued") {
    return (
      <span className="inline-flex items-center gap-1 text-sm font-medium text-emerald-700">
        <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
          <path
            fillRule="evenodd"
            d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 9.7a1 1 0 1 1 1.4-1.4l3.8 3.8 6.8-6.8a1 1 0 0 1 1.4 0Z"
            clipRule="evenodd"
          />
        </svg>
        Brief queued
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={state === "loading"}
      aria-label={`Generate brief for ${keyword}`}
      className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
    >
      {state === "loading" ? "Generating…" : "Generate Brief"}
    </button>
  );
}

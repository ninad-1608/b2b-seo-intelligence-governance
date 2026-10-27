"use client";

import { useState } from "react";

export type FixSnippets = { nextjs: string; htaccess: string; nginx: string; html_meta: string };

const tabs: { key: keyof FixSnippets; label: string }[] = [
  { key: "nextjs", label: "Next.js" },
  { key: "htaccess", label: ".htaccess" },
  { key: "nginx", label: "Nginx" },
  { key: "html_meta", label: "HTML Meta" },
];

export default function FixCodeViewer({ snippets }: { snippets: FixSnippets }) {
  const [active, setActive] = useState<keyof FixSnippets>("nextjs");
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(snippets[active]);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="mt-3 overflow-hidden rounded-md border border-slate-200">
      <div className="flex items-center justify-between bg-slate-100 pr-2">
        <div role="tablist" className="flex">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={active === t.key}
              onClick={() => {
                setActive(t.key);
                setCopied(false);
              }}
              className={`px-3 py-2 text-xs font-medium transition ${
                active === t.key
                  ? "bg-slate-900 text-white"
                  : "text-slate-600 hover:bg-slate-200 hover:text-slate-900"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={copy}
          className="rounded bg-white px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
        >
          {copied ? "Copied ✓" : "Copy Code"}
        </button>
      </div>
      <pre className="max-h-80 overflow-auto bg-slate-900 p-3 text-xs leading-relaxed text-slate-100">
        <code className="font-mono">{snippets[active]}</code>
      </pre>
    </div>
  );
}

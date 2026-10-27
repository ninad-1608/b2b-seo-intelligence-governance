import type { Components } from "react-markdown";

export const markdownComponents: Components = {
  h1: (p) => <h1 className="mb-3 mt-5 text-lg font-bold text-slate-900 first:mt-0" {...p} />,
  h2: (p) => <h2 className="mb-2 mt-5 text-base font-semibold text-slate-900 first:mt-0" {...p} />,
  h3: (p) => <h3 className="mb-2 mt-4 text-sm font-semibold text-slate-900 first:mt-0" {...p} />,
  p: (p) => <p className="my-2" {...p} />,
  strong: (p) => <strong className="font-semibold text-slate-900" {...p} />,
  ul: (p) => <ul className="my-2 list-disc space-y-1 pl-5" {...p} />,
  ol: (p) => <ol className="my-2 list-decimal space-y-1 pl-5" {...p} />,
  a: (p) => <a className="text-indigo-600 underline" target="_blank" rel="noreferrer" {...p} />,
  blockquote: (p) => <blockquote className="my-2 border-l-4 border-slate-300 pl-3 text-slate-600" {...p} />,
  hr: () => <hr className="my-4 border-slate-200" />,
  pre: (p) => <pre className="my-3 overflow-x-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100" {...p} />,
  code: ({ className, ...p }) =>
    className ? (
      <code className={`font-mono ${className}`} {...p} />
    ) : (
      <code className="rounded bg-slate-200 px-1 py-0.5 font-mono text-xs text-slate-800" {...p} />
    ),
};

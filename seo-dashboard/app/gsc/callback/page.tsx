"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8010";

function CallbackInner() {
  const params = useSearchParams();
  const router = useRouter();
  const started = useRef(false); // the authorization code is single-use: never exchange it twice (React StrictMode runs effects twice in dev)
  const [error, setError] = useState<string | null>(null);

  const code = params.get("code");
  const state = params.get("state");
  const oauthError = params.get("error");
  const early = oauthError
    ? oauthError === "access_denied"
      ? "Access was denied on Google's consent screen, so nothing was connected."
      : `Google returned an error: ${oauthError}.`
    : !code || !state
      ? "This page is the return point for Google sign-in and is missing its sign-in parameters. Start the connection from the dashboard."
      : null;

  useEffect(() => {
    if (early || started.current || !code || !state) return;
    started.current = true;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/v1/gsc/callback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, state }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          const detail = Array.isArray(data.detail) ? data.detail[0]?.msg : data.detail;
          throw new Error(typeof detail === "string" ? detail : `Request failed (${res.status})`);
        }
        router.replace("/?gsc=connected");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not reach the API. Is the FastAPI server running?");
      }
    })();
  }, [early, code, state, router]);

  const message = early ?? error;
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      {message ? (
        <>
          <h1 className="text-lg font-semibold text-slate-900">Couldn’t connect Google</h1>
          <p role="alert" className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
            {message}
          </p>
          <Link href="/" className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">
            Back to the dashboard
          </Link>
        </>
      ) : (
        <p className="text-sm text-slate-600">Finishing the Google connection…</p>
      )}
    </main>
  );
}

export default function GscCallbackPage() {
  return (
    <Suspense fallback={<p className="p-8 text-sm text-slate-500">Loading…</p>}>
      <CallbackInner />
    </Suspense>
  );
}

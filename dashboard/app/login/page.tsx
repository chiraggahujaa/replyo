"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useReplyo } from "../providers";
import { SparkIcon } from "../components/icons";

export default function LoginPage() {
  const { session, ready } = useReplyo();
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Already signed in -> go to the console.
  useEffect(() => {
    if (ready && session) router.replace("/");
  }, [ready, session, router]);

  async function google() {
    setErr(null);
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: typeof window !== "undefined" ? window.location.origin : undefined },
    });
  }

  async function emailPassword(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        setMsg("Check your email to confirm your account, then sign in.");
        setMode("signin");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.replace("/");
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-10 bg-[var(--color-bg)]">
      <div className="w-full max-w-[380px]">
        <div className="flex items-center gap-2.5 justify-center mb-7">
          <div className="grid h-10 w-10 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-500 text-white shadow">
            <SparkIcon className="w-5 h-5" />
          </div>
          <div className="text-[19px] font-semibold tracking-tight">Replyo</div>
        </div>

        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-sm">
          <h1 className="text-[17px] font-semibold tracking-tight">
            {mode === "signin" ? "Sign in" : "Create your account"}
          </h1>
          <p className="mt-1 text-[13px] text-[var(--color-faint)]">
            Build AI assistants for your business.
          </p>

          <button
            onClick={google}
            className="mt-5 w-full inline-flex items-center justify-center gap-2 rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 py-2.5 text-[13.5px] font-semibold hover:bg-[var(--color-bg-soft)] transition"
          >
            <GoogleMark /> Continue with Google
          </button>

          <div className="my-4 flex items-center gap-3 text-[11px] text-[var(--color-faint)]">
            <div className="h-px flex-1 bg-[var(--color-border)]" /> or <div className="h-px flex-1 bg-[var(--color-border)]" />
          </div>

          <form onSubmit={emailPassword} className="space-y-2.5">
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@business.com"
              className="w-full rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3.5 py-2.5 text-[13.5px] outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--ring)]"
            />
            <input
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              className="w-full rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3.5 py-2.5 text-[13.5px] outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--ring)]"
            />
            <button
              disabled={busy}
              className="w-full rounded-xl bg-[var(--color-accent)] px-4 py-2.5 text-[13.5px] font-semibold text-white hover:opacity-90 disabled:opacity-60 transition"
            >
              {busy ? "…" : mode === "signin" ? "Sign in" : "Create account"}
            </button>
          </form>

          {err && <p className="mt-3 text-[12.5px] text-rose-500">{err}</p>}
          {msg && <p className="mt-3 text-[12.5px] text-emerald-600">{msg}</p>}

          <button
            onClick={() => {
              setMode((m) => (m === "signin" ? "signup" : "signin"));
              setErr(null);
              setMsg(null);
            }}
            className="mt-4 w-full text-center text-[12.5px] text-[var(--color-muted)] hover:text-[var(--color-text)]"
          >
            {mode === "signin" ? "New here? Create an account" : "Already have an account? Sign in"}
          </button>
        </div>
      </div>
    </div>
  );
}

function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.2 0 24 0 14.6 0 6.4 5.4 2.5 13.3l7.8 6.1C12.2 13.5 17.6 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.5 3-2.2 5.5-4.7 7.2l7.3 5.7c4.3-4 6.8-9.9 6.8-17.4z" />
      <path fill="#FBBC05" d="M10.3 28.6a14.5 14.5 0 0 1 0-9.2l-7.8-6.1a24 24 0 0 0 0 21.4l7.8-6.1z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.3-5.7c-2 1.4-4.7 2.3-8.6 2.3-6.4 0-11.8-4-13.7-9.9l-7.8 6.1C6.4 42.6 14.6 48 24 48z" />
    </svg>
  );
}

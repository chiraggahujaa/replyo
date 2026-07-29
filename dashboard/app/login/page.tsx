"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useReplyo } from "../providers";
import { Button, Card, TextInput } from "../components/ui";
import { SparkIcon, ArrowRightIcon } from "../components/icons";

export default function LoginPage() {
  const { session, ready } = useReplyo();
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Already signed in -> go to the console (the root is the public landing page).
  useEffect(() => {
    if (ready && session) router.replace("/queue");
  }, [ready, session, router]);

  async function google() {
    setErr(null);
    // Land straight in the console. If this URL isn't in Supabase's redirect allowlist
    // it falls back to the Site URL (the landing page) — which also forwards signed-in
    // visitors to /queue, so either way login always ends in the console.
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: typeof window !== "undefined" ? `${window.location.origin}/queue` : undefined,
      },
    });
  }

  async function emailPassword(e: React.SubmitEvent<HTMLFormElement>) {
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
        router.replace("/queue");
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-10">
      <div className="animate-in w-full max-w-[400px]">
        {/* Hero mark */}
        <div className="mb-8 flex flex-col items-center gap-4 text-center">
          <div className="animate-float grid h-16 w-16 place-items-center rounded-[20px] bg-cta text-white glow-accent-lg">
            <SparkIcon className="h-8 w-8" />
          </div>
          <div>
            <div className="text-gradient-animated font-display text-[30px] font-semibold tracking-tight">
              Replyo
            </div>
            <p className="mt-1 text-[14px] text-[var(--color-muted)]">
              Build AI assistants for your business.
            </p>
          </div>
        </div>

        <Card className="p-7 animate-pop">
          <h1 className="font-display text-[20px] font-semibold tracking-tight">
            {mode === "signin" ? "Welcome back" : "Create your account"}
          </h1>
          <p className="mt-1.5 text-[14px] text-[var(--color-muted)]">
            {mode === "signin"
              ? "Sign in to continue to your console."
              : "Start building your assistant in minutes."}
          </p>

          <Button
            type="button"
            variant="secondary"
            full
            className="mt-6"
            onClick={google}
            icon={<GoogleMark />}
          >
            Continue with Google
          </Button>

          <div className="my-5 flex items-center gap-3 text-[12.5px] text-[var(--color-faint)]">
            <div className="h-px flex-1 bg-[var(--color-border)]" />
            or
            <div className="h-px flex-1 bg-[var(--color-border)]" />
          </div>

          <form onSubmit={emailPassword} className="space-y-3">
            <TextInput
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@business.com"
            />
            <TextInput
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
            />
            <Button
              type="submit"
              full
              loading={busy}
              icon={<ArrowRightIcon className="h-4 w-4" />}
            >
              {mode === "signin" ? "Sign in" : "Create account"}
            </Button>
          </form>

          {err && (
            <p className="animate-in mt-4 text-[13px] font-medium text-[var(--color-danger)]">
              {err}
            </p>
          )}
          {msg && (
            <p className="animate-in mt-4 text-[13px] font-medium text-[var(--color-success)]">
              {msg}
            </p>
          )}

          <button
            type="button"
            onClick={() => {
              setMode((m) => (m === "signin" ? "signup" : "signin"));
              setErr(null);
              setMsg(null);
            }}
            className="mt-5 w-full rounded-full py-1 text-center text-[13px] text-[var(--color-muted)] transition-colors hover:text-[var(--color-accent-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            {mode === "signin" ? "New here? Create an account" : "Already have an account? Sign in"}
          </button>
        </Card>
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

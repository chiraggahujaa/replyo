"use client";

import Link from "next/link";
import { Shell } from "../components/Shell";
import { useReplyo } from "../providers";

export default function PersonasPage() {
  return (
    <Shell>
      <PersonaList />
    </Shell>
  );
}

function PersonaList() {
  const { personas, active, setActiveId } = useReplyo();

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">Personas</h1>
          <p className="mt-1 text-[13px] text-[var(--color-faint)]">
            Each persona is a separate business assistant — its own knowledge, prompt, embed key and queue.
          </p>
        </div>
        <Link
          href="/personas/new"
          className="rounded-xl bg-[var(--color-accent)] px-4 py-2.5 text-[13px] font-semibold text-white hover:opacity-90"
        >
          ＋ New persona
        </Link>
      </div>

      <div className="mt-6 space-y-2.5">
        {personas.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[var(--color-border-strong)] px-6 py-12 text-center text-[13px] text-[var(--color-faint)]">
            No personas yet — create your first one.
          </div>
        ) : (
          personas.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[15px] font-semibold tracking-tight">{p.name}</span>
                  {active?.id === p.id && (
                    <span className="rounded-full bg-[var(--color-accent-wash,rgba(99,102,241,.12))] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-accent-ink)]">
                      Active
                    </span>
                  )}
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                      p.onboarding_status === "ready"
                        ? "bg-emerald-500/10 text-emerald-600"
                        : "bg-amber-500/10 text-amber-600"
                    }`}
                  >
                    {p.onboarding_status}
                  </span>
                </div>
                <div className="mt-1 font-mono text-[11px] text-[var(--color-faint)] truncate">{p.public_key}</div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {active?.id !== p.id && (
                  <button
                    onClick={() => setActiveId(p.id)}
                    className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-1.5 text-[12.5px] font-medium hover:bg-[var(--color-bg-soft)]"
                  >
                    Switch to
                  </button>
                )}
                <Link
                  href="/knowledge"
                  onClick={() => setActiveId(p.id)}
                  className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border-strong)] px-3 py-1.5 text-[12.5px] font-medium hover:bg-[var(--color-bg-soft)]"
                >
                  Manage
                </Link>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

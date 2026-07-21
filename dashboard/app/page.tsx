"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DecisionAction, Review, decideReview, listReviews } from "@/lib/api";
import { ReviewList } from "./components/ReviewList";
import { ReviewDetail } from "./components/ReviewDetail";
import { InboxIcon, SparkIcon } from "./components/icons";

const POLL_MS = 4000;

type Toast = { id: number; kind: "success" | "error"; text: string };

export default function Home() {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(true);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(0);

  const pushToast = useCallback((kind: Toast["kind"], text: string) => {
    const id = ++toastSeq.current;
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3800);
  }, []);

  // Poll the review queue. Each tick only touches state after an `await`, so it
  // never triggers a synchronous cascading render; a cancel flag drops results
  // that land after unmount.
  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const data = await listReviews();
        if (cancelled) return;
        setConnected(true);
        setReviews(data);
        setSelectedId((cur) => (cur && data.some((r) => r.id === cur) ? cur : data[0]?.id ?? null));
      } catch {
        if (!cancelled) setConnected(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const handleResolved = useCallback(
    (id: string, action: DecisionAction) => {
      setReviews((prev) => {
        const next = prev.filter((r) => r.id !== id);
        setSelectedId((cur) => (cur === id ? next[0]?.id ?? null : cur));
        return next;
      });
      const label =
        action === "approve"
          ? "Reply approved & sent"
          : action === "edit"
            ? "Edited reply sent"
            : "Escalated — handoff sent";
      pushToast("success", label);
    },
    [pushToast],
  );

  const selected = reviews.find((r) => r.id === selectedId) ?? null;

  return (
    <div className="flex flex-1 flex-col min-h-0">
      {/* Header */}
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-bg)_82%,transparent)] px-5 py-3 backdrop-blur-xl">
        <div className="flex items-center gap-2.5">
          <div className="grid h-8 w-8 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-500 text-white shadow-sm">
            <SparkIcon className="w-[18px] h-[18px]" />
          </div>
          <div className="leading-tight">
            <div className="text-[14px] font-semibold tracking-tight">Replyo</div>
            <div className="text-[11px] text-[var(--color-faint)]">Human review queue</div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[var(--color-muted)]">
            <span className={`h-2 w-2 rounded-full ${connected ? "bg-emerald-500 live-dot" : "bg-rose-500"}`} />
            {connected ? "Live" : "Disconnected"}
          </span>
          <span className="rounded-full bg-[var(--color-surface)] border border-[var(--color-border)] px-2.5 py-1 text-[11px] font-semibold tabular-nums">
            {reviews.length} pending
          </span>
        </div>
      </header>

      {/* Body */}
      <div className="flex flex-1 min-h-0">
        {/* Queue */}
        <aside className="w-[340px] shrink-0 border-r border-[var(--color-border)] bg-[var(--color-bg-soft)] overflow-y-auto">
          <div className="px-4 pt-4 pb-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-faint)]">
            Pending
          </div>
          {loading ? (
            <div className="p-6 text-[13px] text-[var(--color-faint)]">Loading…</div>
          ) : reviews.length === 0 ? (
            <div className="px-4 py-10 text-center text-[13px] text-[var(--color-faint)]">Nothing pending.</div>
          ) : (
            <ReviewList reviews={reviews} selectedId={selectedId} onSelect={setSelectedId} />
          )}
        </aside>

        {/* Detail */}
        <main className="flex flex-1 flex-col min-h-0 bg-[var(--color-bg)]">
          {selected ? (
            <ReviewDetail
              key={selected.id}
              review={selected}
              onResolved={handleResolved}
              onError={(m) => pushToast("error", m)}
              decide={decideReview}
            />
          ) : (
            <EmptyDetail />
          )}
        </main>
      </div>

      {/* Toasts */}
      <div className="pointer-events-none fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`animate-toast pointer-events-auto rounded-xl px-4 py-2.5 text-[13px] font-medium text-white shadow-lg ${
              t.kind === "success" ? "bg-emerald-600" : "bg-rose-600"
            }`}
          >
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyDetail() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center px-6">
      <div className="grid h-14 w-14 place-items-center rounded-2xl bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-faint)]">
        <InboxIcon className="w-7 h-7" />
      </div>
      <div>
        <p className="text-[15px] font-semibold tracking-tight">All caught up</p>
        <p className="mt-1 text-[13px] text-[var(--color-faint)] max-w-xs">
          No conversations need review right now. New escalations appear here automatically.
        </p>
      </div>
    </div>
  );
}

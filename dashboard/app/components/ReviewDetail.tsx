"use client";

import { useEffect, useRef, useState } from "react";
import { DecisionAction, Review, timeAgo } from "@/lib/api";
import { AlertIcon, CheckIcon, SendIcon, SpinnerIcon, XIcon } from "./icons";

function Bubble({ role, content }: { role: "human" | "ai"; content: string }) {
  const isCustomer = role === "human";
  return (
    <div className={`flex ${isCustomer ? "justify-start" : "justify-end"}`}>
      <div
        className={`max-w-[82%] rounded-2xl px-3.5 py-2.5 text-[13.5px] leading-relaxed
          ${
            isCustomer
              ? "bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-tl-md text-[var(--color-text)]"
              : "bg-[var(--color-accent)] text-white rounded-tr-md"
          }`}
      >
        <div className={`mb-0.5 text-[10px] font-semibold uppercase tracking-wide ${isCustomer ? "text-[var(--color-faint)]" : "text-white/70"}`}>
          {isCustomer ? "Customer" : "Assistant"}
        </div>
        {content}
      </div>
    </div>
  );
}

export function ReviewDetail({
  review,
  onResolved,
  onError,
  decide,
}: {
  review: Review;
  onResolved: (id: string, action: DecisionAction, finalReply: string) => void;
  onError: (msg: string) => void;
  decide: (id: string, action: DecisionAction, text?: string) => Promise<{ final_reply: string }>;
}) {
  // The parent renders this with `key={review.id}`, so switching reviews remounts
  // the component — draft/busy initialise fresh per review with no reset effect.
  const [draft, setDraft] = useState(review.draft ?? "");
  const [busy, setBusy] = useState<DecisionAction | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // On mount, drop the transcript to the latest message.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, []);

  const edited = draft.trim() !== (review.draft ?? "").trim();

  async function act(action: DecisionAction) {
    if (busy) return;
    setBusy(action);
    try {
      // "approve" sends the draft as-is; "edit" sends the edited text.
      const text = action === "approve" ? undefined : draft;
      const res = await decide(review.id, action, text);
      onResolved(review.id, action, res.final_reply);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Something went wrong");
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-1 flex-col min-h-0 animate-in">
      {/* header */}
      <div className="px-6 py-4 border-b border-[var(--color-border)] flex items-start justify-between gap-4">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full bg-amber-500/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
            <AlertIcon className="w-3.5 h-3.5" />
            {review.reason || "Needs review"}
          </div>
          <div className="mt-2 flex items-center gap-2 text-[12px] text-[var(--color-faint)]">
            <span className="capitalize">{review.channel}</span>
            <span>·</span>
            <span className="font-mono">{review.thread_id}</span>
            <span>·</span>
            <span>{timeAgo(review.created_at)}</span>
          </div>
        </div>
      </div>

      {/* conversation */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-2.5">
        {(review.conversation ?? []).map((t, i) => (
          <Bubble key={i} role={t.role} content={t.content} />
        ))}
        {(!review.conversation || review.conversation.length === 0) && (
          <p className="text-[13px] text-[var(--color-faint)]">No prior messages captured.</p>
        )}
      </div>

      {/* draft editor + actions */}
      <div className="border-t border-[var(--color-border)] bg-[var(--color-surface-2)] px-6 py-4">
        <div className="flex items-center justify-between mb-2">
          <label className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
            Suggested reply
            <span className="normal-case font-medium text-[var(--color-faint)]"> · AI draft, not sent yet</span>
            {edited && <span className="text-[var(--color-accent-ink)] normal-case font-medium"> · edited</span>}
          </label>
          <span className="text-[11px] text-[var(--color-faint)]">{draft.length} chars</span>
        </div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={4}
          spellCheck
          className="w-full resize-none rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3.5 py-3 text-[13.5px] leading-relaxed text-[var(--color-text)] outline-none transition focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--ring)]"
          placeholder="The reply that will be sent to the customer…"
        />
        <div className="mt-3 flex items-center gap-2.5">
          <button
            onClick={() => act(edited ? "edit" : "approve")}
            disabled={!!busy}
            className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-[13px] font-semibold text-white shadow-sm transition hover:bg-emerald-500 active:scale-[0.98] disabled:opacity-60"
          >
            {busy === "approve" || busy === "edit" ? (
              <SpinnerIcon className="w-4 h-4 animate-spin" />
            ) : edited ? (
              <SendIcon className="w-4 h-4" />
            ) : (
              <CheckIcon className="w-4 h-4" />
            )}
            {edited ? "Send edited reply" : "Approve & send"}
          </button>
          <button
            onClick={() => act("reject")}
            disabled={!!busy}
            className="inline-flex items-center gap-2 rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 py-2.5 text-[13px] font-semibold text-rose-600 dark:text-rose-400 transition hover:bg-rose-500/10 active:scale-[0.98] disabled:opacity-60"
          >
            {busy === "reject" ? <SpinnerIcon className="w-4 h-4 animate-spin" /> : <XIcon className="w-4 h-4" />}
            Reject
          </button>
          <span className="ml-auto text-[11px] text-[var(--color-faint)]">
            Reject sends a safe handoff message · edits override the draft
          </span>
        </div>
      </div>
    </div>
  );
}

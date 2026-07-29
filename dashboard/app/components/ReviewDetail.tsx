"use client";

import { useEffect, useRef, useState } from "react";
import { DecisionAction, Review, timeAgo } from "@/lib/api";
import { Badge, Button, TextArea } from "./ui";
import { AlertIcon, CheckIcon, SendIcon, XIcon } from "./icons";

function Bubble({ role, content }: { role: "human" | "ai"; content: string }) {
  const isCustomer = role === "human";
  return (
    <div className={`animate-in flex ${isCustomer ? "justify-start" : "justify-end"}`}>
      <div
        className={`max-w-[82%] rounded-3xl px-4 py-3 text-[14.5px] leading-relaxed
          ${
            isCustomer
              ? "bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-tl-lg text-[var(--color-text)]"
              : "bg-cta text-white rounded-tr-lg glow-accent"
          }`}
      >
        <div className={`mb-0.5 text-[11px] font-semibold uppercase tracking-wide ${isCustomer ? "text-[var(--color-faint)]" : "text-white/70"}`}>
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
      // "approve" sends the draft as-is; "edit" sends the edited text. "reject" only
      // sends the textarea if the reviewer actually rewrote it — an untouched draft
      // is the thing being rejected, so sending it would defeat the whole rejection;
      // with no text the backend substitutes its safe handoff message.
      const text = action === "approve" || (action === "reject" && !edited) ? undefined : draft;
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
          <Badge tone="warning">
            <AlertIcon className="h-3.5 w-3.5" />
            {review.reason || "Needs review"}
          </Badge>
          <div className="mt-2 flex items-center gap-2 text-[12.5px] text-[var(--color-muted)]">
            <span className="capitalize">{review.channel}</span>
            <span>·</span>
            <span className="font-mono">{review.thread_id}</span>
            <span>·</span>
            <span>{timeAgo(review.created_at)}</span>
          </div>
        </div>
      </div>

      {/* conversation */}
      <div ref={scrollRef} className="stagger flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-3">
        {(review.conversation ?? []).map((t, i) => (
          <Bubble key={i} role={t.role} content={t.content} />
        ))}
        {(!review.conversation || review.conversation.length === 0) && (
          <p className="text-[14px] text-[var(--color-faint)]">No prior messages captured.</p>
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
          <span className="text-[11px] tabular-nums text-[var(--color-faint)]">{draft.length} chars</span>
        </div>
        <TextArea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={4}
          spellCheck
          className="resize-none"
          placeholder="The reply that will be sent to the customer…"
        />
        <div className="mt-3 flex items-center gap-2.5">
          <Button
            variant="success"
            loading={busy === "approve" || busy === "edit"}
            disabled={!!busy}
            icon={edited ? <SendIcon className="h-4 w-4" /> : <CheckIcon className="h-4 w-4" />}
            onClick={() => act(edited ? "edit" : "approve")}
          >
            {edited ? "Send edited reply" : "Approve & send"}
          </Button>
          <Button
            variant="danger"
            loading={busy === "reject"}
            disabled={!!busy}
            icon={<XIcon className="h-4 w-4" />}
            onClick={() => act("reject")}
          >
            Reject
          </Button>
          <span className="ml-auto text-[12.5px] text-[var(--color-faint)]">
            Reject sends a safe handoff (or your rewrite) · edits override the draft
          </span>
        </div>
      </div>
    </div>
  );
}

"use client";

import { Review, timeAgo } from "@/lib/api";
import { AlertIcon, GlobeIcon, TelegramIcon } from "./icons";

function ChannelBadge({ channel }: { channel: string }) {
  const isTg = channel === "telegram";
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--color-faint)]">
      {isTg ? <TelegramIcon className="w-3.5 h-3.5 text-sky-500" /> : <GlobeIcon className="w-3.5 h-3.5" />}
      {isTg ? "Telegram" : channel}
    </span>
  );
}

function lastCustomerMessage(r: Review): string {
  const humans = r.conversation?.filter((t) => t.role === "human") ?? [];
  return humans.length ? humans[humans.length - 1].content : r.draft ?? "";
}

export function ReviewList({
  reviews,
  selectedId,
  onSelect,
}: {
  reviews: Review[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <ul className="flex flex-col gap-1.5 p-2.5">
      {reviews.map((r) => {
        const active = r.id === selectedId;
        return (
          <li key={r.id}>
            <button
              onClick={() => onSelect(r.id)}
              className={`w-full text-left rounded-xl border p-3.5 transition-all duration-150 animate-in
                ${
                  active
                    ? "border-[var(--color-accent)] bg-[var(--color-surface)] shadow-sm ring-1 ring-[var(--ring)]"
                    : "border-transparent bg-transparent hover:bg-[var(--color-surface)] hover:border-[var(--color-border)]"
                }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                  <AlertIcon className="w-3.5 h-3.5" />
                  {r.reason?.replace(/\s*\(.*\)/, "") || "Review"}
                </span>
                <span className="text-[11px] text-[var(--color-faint)] shrink-0">{timeAgo(r.created_at)}</span>
              </div>
              <p className="mt-1.5 text-[13px] leading-snug text-[var(--color-text)] line-clamp-2">
                {lastCustomerMessage(r)}
              </p>
              <div className="mt-2 flex items-center justify-between">
                <ChannelBadge channel={r.channel} />
                <span className="font-mono text-[10px] text-[var(--color-faint)]">{r.thread_id}</span>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

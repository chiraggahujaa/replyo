"use client";

import { Review, timeAgo } from "@/lib/api";
import { Badge } from "./ui";
import { AlertIcon, GlobeIcon, TelegramIcon } from "./icons";

function ChannelBadge({ channel }: { channel: string }) {
  const isTg = channel === "telegram";
  return (
    <span className="inline-flex items-center gap-1 text-[12.5px] font-medium text-[var(--color-muted)]">
      {isTg ? <TelegramIcon className="h-3.5 w-3.5 text-[var(--color-accent)]" /> : <GlobeIcon className="h-3.5 w-3.5" />}
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
    <ul className="stagger flex flex-col gap-1.5 p-2.5">
      {reviews.map((r) => {
        const active = r.id === selectedId;
        return (
          <li key={r.id} className="animate-in">
            <button
              onClick={() => onSelect(r.id)}
              className={`w-full text-left rounded-2xl border p-3.5 transition-all duration-150
                ${
                  active
                    ? "border-[var(--color-accent)] bg-[var(--color-surface)] glow-accent ring-1 ring-[var(--ring)]"
                    : "border-transparent bg-transparent hover:bg-[var(--color-surface)] card-hover"
                }`}
            >
              <div className="flex items-center justify-between gap-2">
                <Badge tone="warning">
                  <AlertIcon className="h-3.5 w-3.5" />
                  {r.reason?.replace(/\s*\(.*\)/, "") || "Review"}
                </Badge>
                <span className="text-[12.5px] text-[var(--color-muted)] shrink-0">{timeAgo(r.created_at)}</span>
              </div>
              <p className="mt-2 text-[14px] leading-snug text-[var(--color-text)] line-clamp-2">
                {lastCustomerMessage(r)}
              </p>
              <div className="mt-2 flex items-center justify-between">
                <ChannelBadge channel={r.channel} />
                <span className="font-mono text-[11px] text-[var(--color-muted)]">{r.thread_id}</span>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

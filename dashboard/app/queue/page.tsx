"use client";

import { useCallback, useRef, useState } from "react";
import { DecisionAction, Review, decideReview, listReviews } from "@/lib/api";
import { useLiveResource, useRefetch } from "@/lib/live";
import { Shell } from "../components/Shell";
import { useReplyo } from "../providers";
import { ReviewList } from "../components/ReviewList";
import { ReviewDetail } from "../components/ReviewDetail";
import { Badge, Button, EmptyState, SkeletonCard, ToastShelf, type ToastItem } from "../components/ui";
import { InboxIcon, PlusIcon, RocketIcon } from "../components/icons";

// Fallback cadence when the websocket is down; while it's up, changes push instantly.
const POLL_MS = 4000;

export default function QueuePage() {
  return (
    <Shell>
      <QueueForActive />
    </Shell>
  );
}

// Remount the queue on persona switch so its state (loading, list, selection) resets
// cleanly without a reset effect.
function QueueForActive() {
  const { active } = useReplyo();
  if (!active) return <NoPersona />;
  return <Queue key={active.id} active={active} />;
}

function Queue({ active }: { active: NonNullable<ReturnType<typeof useReplyo>["active"]> }) {
  const tenantId = active.id;

  const [reviews, setReviews] = useState<Review[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastSeq = useRef(0);

  const pushToast = useCallback((kind: ToastItem["kind"], text: string) => {
    const id = ++toastSeq.current;
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3800);
  }, []);

  // Socket-pushed updates with polling fallback. Errors must propagate (they drive
  // `connected`), so the finally clears the skeleton without swallowing them.
  const refetch = useRefetch(async () => {
    try {
      const data = await listReviews(tenantId);
      setReviews(data);
      setSelectedId((cur) => (cur && data.some((r) => r.id === cur) ? cur : data[0]?.id ?? null));
    } finally {
      setLoading(false);
    }
  });
  const { live, connected } = useLiveResource({ tenantId, topic: "reviews", refetch, pollMs: POLL_MS });

  const handleResolved = useCallback(
    (id: string, action: DecisionAction) => {
      setReviews((prev) => {
        const next = prev.filter((r) => r.id !== id);
        setSelectedId((cur) => (cur === id ? next[0]?.id ?? null : cur));
        return next;
      });
      pushToast(
        "success",
        action === "approve" ? "Reply approved & sent" : action === "edit" ? "Edited reply sent" : "Escalated — handoff sent",
      );
    },
    [pushToast],
  );

  const selected = reviews.find((r) => r.id === selectedId) ?? null;

  return (
    <div className="animate-in flex flex-1 flex-col min-h-0">
      <header className="glass sticky top-0 z-10 flex items-center justify-between border-b border-[var(--color-border)] px-5 py-3">
        <div>
          <div className="font-display text-[17px] font-semibold tracking-tight">Review queue</div>
          <div className="text-[12.5px] text-[var(--color-muted)]">{active.name}</div>
        </div>
        <div className="flex items-center gap-2.5">
          {/* Live = socket push and fetches succeeding; Polling = HTTP fallback (still
              fresh, just slower); Offline = the data on screen may be stale. `connected`
              wins over `live`: a green badge must never sit above data we can't fetch. */}
          <Badge tone={connected ? (live ? "success" : "warning") : "danger"} pulse={connected}>
            {connected ? (live ? "Live" : "Polling") : "Offline"}
          </Badge>
          <Badge tone="accent" className="tabular-nums">
            {reviews.length} pending
          </Badge>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        <aside className="w-[340px] shrink-0 border-r border-[var(--color-border)] bg-[var(--color-bg-soft)] overflow-y-auto">
          <div className="px-4 pt-4 pb-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-muted)]">Pending</div>
          {loading ? (
            <div className="stagger flex flex-col gap-2 p-2.5">
              <div className="animate-in">
                <SkeletonCard />
              </div>
              <div className="animate-in">
                <SkeletonCard />
              </div>
              <div className="animate-in">
                <SkeletonCard />
              </div>
            </div>
          ) : reviews.length === 0 ? (
            <EmptyState
              icon={<InboxIcon className="h-6 w-6" />}
              title="Inbox zero"
              description="Nothing pending right now."
            />
          ) : (
            <ReviewList reviews={reviews} selectedId={selectedId} onSelect={setSelectedId} />
          )}
        </aside>

        <main className="flex flex-1 flex-col min-h-0 bg-[var(--color-bg)]">
          {selected ? (
            <ReviewDetail
              key={selected.id}
              review={selected}
              onResolved={handleResolved}
              onError={(m) => pushToast("error", m)}
              decide={(id, action, text) => decideReview(tenantId!, id, action, text)}
            />
          ) : (
            <EmptyDetail />
          )}
        </main>
      </div>

      <ToastShelf toasts={toasts} />
    </div>
  );
}

function EmptyDetail() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center">
      <EmptyState
        icon={<InboxIcon className="h-7 w-7" />}
        title="All caught up"
        description="No conversations need review right now. New escalations appear here automatically."
      />
    </div>
  );
}

function NoPersona() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center">
      <EmptyState
        icon={<RocketIcon className="h-7 w-7" />}
        title="Create your first persona"
        description="A persona is one business's assistant — its knowledge, its prompt, its own review queue."
        action={
          <Button href="/personas/new" icon={<PlusIcon className="h-4 w-4" />}>
            New persona
          </Button>
        }
      />
    </div>
  );
}

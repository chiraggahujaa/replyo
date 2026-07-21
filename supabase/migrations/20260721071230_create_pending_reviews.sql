-- Human-review queue.
--
-- One row per conversation paused at the graph's `human_review` node: it links the
-- paused thread (thread_id + channel + chat_id) to the AI draft and a conversation
-- snapshot, until a human approves/edits/rejects it from the dashboard. On resolution
-- the row is marked resolved with the human's decision and the final text sent.
create table if not exists pending_reviews (
    id           uuid primary key default gen_random_uuid(),
    thread_id    text not null,
    channel      text not null,
    chat_id      text,
    reason       text,
    draft        text,
    conversation jsonb,
    status       text not null default 'pending',   -- pending | resolved
    decision     text,                              -- approve | edit | reject
    final_text   text,
    created_at   timestamptz not null default now(),
    resolved_at  timestamptz
);

-- The dashboard only ever lists pending items, oldest first. A partial index keyed on
-- created_at (restricted to pending rows) serves both the filter and the ordering, and
-- stays small because resolved rows drop out of it.
create index if not exists pending_reviews_pending_idx
    on pending_reviews (created_at)
    where status = 'pending';

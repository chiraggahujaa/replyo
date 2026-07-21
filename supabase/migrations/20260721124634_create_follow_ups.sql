-- Scheduled re-engagement follow-ups.
--
-- One row per conversation (thread_id is unique), so each new inbound message just
-- upserts it and pushes `due_at` out again — the 48h clock restarts from the
-- patient's last message rather than from when they first wrote. The worker
-- (scripts/run_followups.py) picks up rows whose due_at has passed.
--
-- status: pending   -> waiting for due_at, will be sent
--         sent      -> nudge delivered (sent_count caps repeat nudges)
--         cancelled -> converted (booked) or escalated to a human; don't nudge
create table if not exists follow_ups (
    id           uuid primary key default gen_random_uuid(),
    thread_id    text not null unique,
    channel      text not null,
    chat_id      text,
    reason       text,                              -- why we're re-engaging
    due_at       timestamptz not null,
    status       text not null default 'pending',   -- pending | sent | cancelled
    sent_count   integer not null default 0,
    message      text,                              -- the last nudge we sent
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    last_sent_at timestamptz
);

-- The worker only ever scans for due, pending rows; a partial index keyed on due_at
-- serves both the filter and the ordering, and stays small as rows are resolved.
create index if not exists follow_ups_due_idx
    on follow_ups (due_at)
    where status = 'pending';

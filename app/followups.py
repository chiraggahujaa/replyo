"""Scheduled re-engagement follow-ups (Postgres).

After every turn we decide whether this conversation deserves a nudge later — a lead
who asked about treatment but never booked, or a booking that stalled half-way. The
row is upserted per thread, so each new message pushes `due_at` out again: the 48h
clock runs from the patient's LAST message, and we only chase people who actually
went quiet.

A worker (`scripts/run_followups.py`) later picks up due rows, writes a short
personalised message from the conversation, and delivers it on the patient's channel.

The table is provisioned by a Supabase migration (`supabase db push`), not at runtime;
see `supabase/migrations/*_create_follow_ups.sql`.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from app.config import settings
from app.tenancy import admin_connection, scoped_connection

logger = logging.getLogger("replyo.followups")


# ---- Decision: does this conversation deserve a nudge? ----

def follow_up_reason(result: dict) -> Optional[str]:
    """Why we should re-engage this conversation later, or None to cancel any nudge.

    Deliberately conservative — we'd rather miss a nudge than pester someone:
      - a confirmed booking is a conversion, so there's nothing to chase
      - an escalated complaint belongs to a human, who owns the next message
      - spam never gets followed up
    """
    booking = result.get("booking_info") or {}
    lead = result.get("lead_info") or {}
    intent = result.get("intent")

    if booking.get("status") == "confirmed":
        return None  # converted
    if result.get("needs_human"):
        return None  # a teammate owns the next message
    if intent == "spam":
        return None

    if booking.get("status") in ("collecting", "conflict"):
        return "Started booking an appointment but never confirmed a time"
    if lead:
        need = lead.get("need")
        return f"Enquired about {need} but hasn't booked" if need else "Enquired but hasn't booked"
    if intent == "question":
        return "Asked about the clinic but hasn't booked"
    return None


# ---- Postgres layer ----
#
# Writes tied to a live conversation (schedule/cancel/record_turn) run tenant-scoped,
# so RLS keeps each persona's nudges separate. The worker's read (list_due) is the one
# deliberate exception: it must see EVERY tenant's due rows, so it uses an admin
# connection — the same trust level as a cron job — and carries each row's tenant_id
# forward so the send/mark-sent happen in the right persona's context.


async def schedule(
    *, tenant_id: str, thread_id: str, channel: str, chat_id: Optional[str], reason: str,
    delay_hours: Optional[float] = None,
) -> None:
    """Upsert a pending nudge for this thread, due `delay_hours` from now.

    Called on every turn — that's what rolls the timer forward while the patient is
    still replying. Threads that already hit `followup_max_sends` are left untouched
    by the ON CONFLICT guard, so a cold lead is never nagged twice.
    """
    delay = settings.followup_delay_hours if delay_hours is None else delay_hours
    due_at = datetime.now(timezone.utc) + timedelta(hours=delay)
    async with await scoped_connection(tenant_id=tenant_id) as conn:
        await conn.execute(
            """insert into follow_ups (tenant_id, thread_id, channel, chat_id, reason, due_at, status)
                    values (%s, %s, %s, %s, %s, %s, 'pending')
               on conflict (tenant_id, thread_id) do update
                      set channel = excluded.channel,
                          chat_id = excluded.chat_id,
                          reason = excluded.reason,
                          due_at = excluded.due_at,
                          status = 'pending',
                          updated_at = now()
                    where follow_ups.sent_count < %s""",
            (tenant_id, thread_id, channel, chat_id, reason, due_at, settings.followup_max_sends),
        )


async def cancel(*, tenant_id: str, thread_id: str) -> None:
    """Stop nudging this thread — they converted, or a human took over."""
    async with await scoped_connection(tenant_id=tenant_id) as conn:
        await conn.execute(
            "update follow_ups set status = 'cancelled', updated_at = now() "
            "where thread_id = %s and status = 'pending'",
            (thread_id,),
        )


async def record_turn(
    *, tenant_id: str, thread_id: str, channel: str, chat_id: Optional[str], result: dict
) -> Optional[str]:
    """Schedule or cancel this thread's nudge based on how the turn ended.

    Never raises: a follow-up is a side effect, so a database hiccup here must not
    break the reply the patient is waiting on.
    """
    try:
        reason = follow_up_reason(result)
        if reason is None:
            await cancel(tenant_id=tenant_id, thread_id=thread_id)
            return None
        await schedule(
            tenant_id=tenant_id, thread_id=thread_id, channel=channel, chat_id=chat_id, reason=reason
        )
        return reason
    except Exception:
        logger.exception("Could not record follow-up state for thread %s", thread_id)
        return None


async def list_due(*, force: bool = False) -> list[dict[str, Any]]:
    """Pending nudges whose `due_at` has passed, across ALL tenants (worker/admin path).

    Each row carries its `tenant_id`, so the worker sends and records in the right
    persona's context. Paused personas are skipped, not cancelled: their rows stay
    `pending`, so nudges resume (late) if the owner reactivates. Deleted personas
    need no handling — the cascade already removed their rows.
    """
    where = "f.status = 'pending'" if force else "f.status = 'pending' and f.due_at <= now()"
    async with await admin_connection() as conn:
        cur = await conn.execute(
            f"""select f.* from follow_ups f
                join tenants t on t.id = f.tenant_id
                where {where} and t.status = 'active'
                order by f.due_at asc"""
        )
        return await cur.fetchall()


async def mark_sent(*, tenant_id: str, thread_id: str, message: str) -> None:
    async with await scoped_connection(tenant_id=tenant_id) as conn:
        await conn.execute(
            """update follow_ups
                  set status = 'sent', sent_count = sent_count + 1, message = %s,
                      last_sent_at = now(), updated_at = now()
                where thread_id = %s""",
            (message, thread_id),
        )

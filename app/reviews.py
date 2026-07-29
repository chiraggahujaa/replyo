"""Pending human-review queue (Postgres) — tenant-scoped.

When the graph pauses at `human_review`, the caller records a row here so the
dashboard can list it and act on it. Every row belongs to a tenant, and every query
runs on a tenant-scoped connection (`app.tenancy.scoped_connection`), so RLS confines
each call to one persona automatically — a review from another tenant simply isn't
visible, which is what turns `get_review` into a free cross-tenant 404.

The table + its RLS are provisioned by Supabase migrations, not at runtime.
"""

from __future__ import annotations

import json
from typing import Any

from app.tenancy import scoped_connection


async def create_review(
    *, tenant_id: str, thread_id: str, channel: str, chat_id: str | None, review: dict
) -> str:
    async with await scoped_connection(tenant_id=tenant_id) as conn:
        cur = await conn.execute(
            """insert into pending_reviews (tenant_id, thread_id, channel, chat_id, reason, draft, conversation)
               values (%s, %s, %s, %s, %s, %s, %s) returning id""",
            (
                tenant_id,
                thread_id,
                channel,
                chat_id,
                review.get("reason"),
                review.get("draft"),
                json.dumps(review.get("conversation", [])),
            ),
        )
        row = await cur.fetchone()
        assert row is not None  # INSERT .. RETURNING always yields the new row
        return str(row["id"])


async def list_pending(*, tenant_id: str) -> list[dict[str, Any]]:
    async with await scoped_connection(tenant_id=tenant_id) as conn:
        cur = await conn.execute(
            "select * from pending_reviews where status = 'pending' order by created_at asc"
        )
        return await cur.fetchall()


async def get_review(review_id: str, *, tenant_id: str) -> dict[str, Any] | None:
    async with await scoped_connection(tenant_id=tenant_id) as conn:
        cur = await conn.execute("select * from pending_reviews where id = %s", (review_id,))
        return await cur.fetchone()


async def claim_pending(review_id: str, *, tenant_id: str, decision: str) -> bool:
    """Atomically take a review out of the pending queue. Returns False if someone
    else already did — the `status = 'pending'` guard in the UPDATE itself is what
    makes two concurrent decisions safe: exactly one caller wins the row, so only
    one resumes the graph and the customer can never be double-replied."""
    async with await scoped_connection(tenant_id=tenant_id) as conn:
        cur = await conn.execute(
            """update pending_reviews
                  set status = 'resolved', decision = %s, resolved_at = now()
                where id = %s and status = 'pending'
                returning id""",
            (decision, review_id),
        )
        return await cur.fetchone() is not None


async def release_claim(review_id: str, *, tenant_id: str) -> None:
    """Put a claimed review back in the queue. Only safe while nothing has actually
    happened yet — i.e. resuming the graph failed, so a retry starts clean."""
    async with await scoped_connection(tenant_id=tenant_id) as conn:
        await conn.execute(
            """update pending_reviews
                  set status = 'pending', decision = null, resolved_at = null
                where id = %s""",
            (review_id,),
        )


async def store_final(review_id: str, *, tenant_id: str, final_text: str) -> None:
    """Record the reply that actually went out (the claim happened earlier)."""
    async with await scoped_connection(tenant_id=tenant_id) as conn:
        await conn.execute(
            "update pending_reviews set final_text = %s where id = %s",
            (final_text, review_id),
        )

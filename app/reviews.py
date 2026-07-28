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
from typing import Any, Optional

from app.tenancy import scoped_connection


async def create_review(
    *, tenant_id: str, thread_id: str, channel: str, chat_id: Optional[str], review: dict
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
        return str(row["id"])


async def list_pending(*, tenant_id: str) -> list[dict[str, Any]]:
    async with await scoped_connection(tenant_id=tenant_id) as conn:
        cur = await conn.execute(
            "select * from pending_reviews where status = 'pending' order by created_at asc"
        )
        return await cur.fetchall()


async def get_review(review_id: str, *, tenant_id: str) -> Optional[dict[str, Any]]:
    async with await scoped_connection(tenant_id=tenant_id) as conn:
        cur = await conn.execute("select * from pending_reviews where id = %s", (review_id,))
        return await cur.fetchone()


async def mark_resolved(review_id: str, *, tenant_id: str, decision: str, final_text: str) -> None:
    async with await scoped_connection(tenant_id=tenant_id) as conn:
        await conn.execute(
            """update pending_reviews
                  set status = 'resolved', decision = %s, final_text = %s, resolved_at = now()
                where id = %s""",
            (decision, final_text, review_id),
        )

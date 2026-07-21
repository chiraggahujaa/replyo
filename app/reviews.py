"""Pending human-review queue (Postgres).

When the graph pauses at `human_review`, the caller records a row here so the
dashboard can list it and act on it. A row links a paused conversation (thread_id
+ channel + chat_id) to the AI draft and conversation snapshot. On resolution we
mark it resolved and store the human's decision + final text.

Kept deliberately small — a thin async psycopg layer over one table. The table
itself is provisioned by a Supabase migration (`supabase db push`), not at runtime;
see `supabase/migrations/*_create_pending_reviews.sql`.
"""

from __future__ import annotations

import json
from typing import Any, Optional

import psycopg
from psycopg.rows import dict_row

from app.config import settings


async def _connect() -> psycopg.AsyncConnection:
    # autocommit keeps these single-statement ops simple and pooler-friendly.
    return await psycopg.AsyncConnection.connect(
        settings.database_url, autocommit=True, row_factory=dict_row
    )


async def create_review(
    *, thread_id: str, channel: str, chat_id: Optional[str], review: dict
) -> str:
    async with await _connect() as conn:
        cur = await conn.execute(
            """insert into pending_reviews (thread_id, channel, chat_id, reason, draft, conversation)
               values (%s, %s, %s, %s, %s, %s) returning id""",
            (
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


async def list_pending() -> list[dict[str, Any]]:
    async with await _connect() as conn:
        cur = await conn.execute(
            "select * from pending_reviews where status = 'pending' order by created_at asc"
        )
        return await cur.fetchall()


async def get_review(review_id: str) -> Optional[dict[str, Any]]:
    async with await _connect() as conn:
        cur = await conn.execute("select * from pending_reviews where id = %s", (review_id,))
        return await cur.fetchone()


async def mark_resolved(review_id: str, *, decision: str, final_text: str) -> None:
    async with await _connect() as conn:
        await conn.execute(
            """update pending_reviews
                  set status = 'resolved', decision = %s, final_text = %s, resolved_at = now()
                where id = %s""",
            (decision, final_text, review_id),
        )

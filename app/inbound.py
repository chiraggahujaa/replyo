"""One inbound message -> one graph turn -> the side effects every channel needs.

Telegram, WhatsApp and the web widget all do exactly the same thing after a turn:
queue an escalated reply for human approval, and arm (or clear) the re-engagement
nudge. Keeping that here means a new channel is a thin adapter — parse the payload,
send the reply — rather than another copy of this logic that can drift.

Deliberately NOT in app/graph/build.py: the graph layer shouldn't know about review
queues or follow-up scheduling.
"""

from __future__ import annotations

import logging

from app import catalog, followups, reviews
from app.graph.build import run_turn

logger = logging.getLogger("replyo.inbound")


def scoped_thread(tenant_id: str, thread_id: str) -> str:
    """Bind a conversation to its tenant inside the checkpointer key itself.

    The LangGraph checkpointer runs on the RLS-bypassing connection and its tables have
    no tenant_id column, so the graph's conversation state is a single global namespace.
    Prefixing the key with the tenant id — which always comes from trusted resolution
    (membership or a valid public_key), never from the client — is what stops one tenant
    from naming, reading, or resuming another tenant's thread. Every entry point scopes
    the client-supplied thread id through here before it reaches the graph, the review
    queue, or the realtime hub, so the stored id and the checkpointer key always agree.
    """
    return f"{tenant_id}:{thread_id}"


async def handle_inbound(
    graph, *, tenant: dict, thread_id: str, channel: str, chat_id: str | None,
    text: str, on_token=None, images: list[str] | None = None,
) -> dict:
    """Run one turn for `text` under `tenant`, then apply the post-turn side effects.

    `tenant` is the full persona row: the graph uses its prompt + knowledge collection,
    and the side effects are written under its id. Returns `run_turn`'s result dict plus
    `review_id` (set when the reply was held for approval). `on_token` streams the reply
    (websocket channel); the others don't. `images` are data-URL attachments riding the
    same turn (the web widget's HTTP path today) — validated upstream, opaque here.
    """
    tenant_id = str(tenant["id"])
    # Enrich the persona with its curated catalog + guidelines blocks (app/catalog.py)
    # so the graph can ground answers in owner-reviewed data. Best-effort: a context
    # load failing must never break the reply — same posture as record_turn below.
    try:
        tenant = {**tenant, **await catalog.load_business_context(tenant_id)}
    except Exception:
        logger.exception("Could not load business context for tenant %s", tenant_id)
    result = await run_turn(
        graph, thread_id, text, channel=channel, tenant=tenant, on_token=on_token, images=images
    )

    review_id = None
    if result.get("held"):
        review_id = await reviews.create_review(
            tenant_id=tenant_id, thread_id=thread_id, channel=channel,
            chat_id=chat_id, review=result["review"],
        )
        logger.info("Queued review %s for %s (tenant %s)", review_id, thread_id, tenant_id)
    result["review_id"] = review_id

    # Arm (or clear) the 48h re-engagement nudge for this conversation.
    reason = await followups.record_turn(
        tenant_id=tenant_id, thread_id=thread_id, channel=channel, chat_id=chat_id, result=result
    )
    logger.info("Follow-up for %s: %s", thread_id, reason or "cancelled/none")

    return result

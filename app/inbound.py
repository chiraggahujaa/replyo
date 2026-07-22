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
from typing import Optional

from app import followups, reviews
from app.graph.build import run_turn

logger = logging.getLogger("replyo.inbound")


async def handle_inbound(
    graph, *, thread_id: str, channel: str, chat_id: Optional[str], text: str, on_token=None
) -> dict:
    """Run one turn for `text`, then apply the post-turn side effects.

    Returns `run_turn`'s result dict plus `review_id` — set when the reply was held
    for human approval, None otherwise. `on_token` streams the reply as it's
    generated (used by the websocket channel); the others don't stream.
    """
    result = await run_turn(graph, thread_id, text, channel=channel, on_token=on_token)

    review_id = None
    if result.get("held"):
        review_id = await reviews.create_review(
            thread_id=thread_id, channel=channel, chat_id=chat_id, review=result["review"]
        )
        logger.info("Queued review %s for %s", review_id, thread_id)
    result["review_id"] = review_id

    # Arm (or clear) the 48h re-engagement nudge for this conversation.
    reason = await followups.record_turn(
        thread_id=thread_id, channel=channel, chat_id=chat_id, result=result
    )
    logger.info("Follow-up for %s: %s", thread_id, reason or "cancelled/none")

    return result

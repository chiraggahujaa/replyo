"""Send scheduled re-engagement follow-ups.

Finds conversations that went quiet without converting, writes a short personalised
nudge from what the thread already knows, delivers it on the patient's own channel,
and appends it to the conversation so their reply lands in context (the graph picks
the thread up mid-conversation, exactly as if they'd messaged first).

Run once (cron-friendly):    uv run python scripts/run_followups.py
Preview without sending:     uv run python scripts/run_followups.py --dry-run
Ignore the 48h timer:        uv run python scripts/run_followups.py --force
Keep running:                uv run python scripts/run_followups.py --loop --interval 300

To test without waiting two days, either pass --force or set
FOLLOWUP_DELAY_HOURS=0 in .env so nudges fall due immediately.
"""

from __future__ import annotations

import argparse
import asyncio
import logging

from langchain_core.messages import AIMessage, SystemMessage

from app import followups, realtime
from app.graph.build import graph_with_checkpointer
from app.graph.nodes import PERSONA
from app.llm import get_chat_model
from app.notify import send_to_channel

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger("replyo.followups.worker")


async def compose(graph, row: dict) -> str | None:
    """Write the nudge from the thread's own conversation history."""
    config = {"configurable": {"thread_id": row["thread_id"]}}
    snapshot = await graph.aget_state(config)
    messages = (snapshot.values or {}).get("messages", [])
    if not messages:
        logger.warning("No conversation for thread %s — skipping.", row["thread_id"])
        return None

    system = SystemMessage(
        content=(
            f"{PERSONA}\n\n"
            "This conversation went quiet a while ago and never reached a booking. "
            f"Context: {row.get('reason') or 'they enquired but did not book'}.\n"
            "Write ONE short, warm message (1–2 sentences) checking back in. Reference what "
            "they were actually interested in, and offer a clear next step such as booking a "
            "visit. Do NOT invent prices, availability, or claim anything was already booked. "
            "Don't over-apologise and don't sound automated."
        )
    )
    reply = get_chat_model(temperature=0.5).invoke([system, *messages])
    return reply.content


async def process(graph, row: dict, *, dry_run: bool) -> bool:
    """Compose + deliver one nudge. Returns True if it was actually sent."""
    thread_id = row["thread_id"]
    text = await compose(graph, row)
    if not text:
        return False

    if dry_run:
        logger.info("[dry-run] %s (%s) -> %s", thread_id, row.get("reason"), text)
        return False

    # Deliver first; only record it as sent once it's actually gone out, so a
    # transient send failure is retried on the next run rather than silently lost.
    await send_to_channel(row["channel"], row.get("chat_id"), text)
    # This worker is a different process from the API that holds the widget sockets,
    # so the nudge goes out over Postgres NOTIFY — the API relays it to any open one.
    await realtime.publish_message(thread_id, text, source="followup")
    # Keep the transcript coherent: the nudge becomes part of the conversation.
    await graph.aupdate_state(
        {"configurable": {"thread_id": thread_id}}, {"messages": [AIMessage(content=text)]}
    )
    await followups.mark_sent(thread_id, text)
    logger.info("Sent follow-up to %s (%s)", thread_id, row.get("reason"))
    return True


async def run_once(*, force: bool, dry_run: bool) -> int:
    due = await followups.list_due(force=force)
    if not due:
        logger.info("Nothing due.")
        return 0

    logger.info("%d follow-up(s) due.", len(due))
    sent = 0
    async with graph_with_checkpointer() as graph:
        for row in due:
            try:
                if await process(graph, row, dry_run=dry_run):
                    sent += 1
            except Exception:
                # One bad thread must not stop the rest of the batch.
                logger.exception("Follow-up failed for thread %s", row["thread_id"])
    return sent


async def main() -> None:
    parser = argparse.ArgumentParser(description="Send scheduled re-engagement follow-ups.")
    parser.add_argument("--force", action="store_true", help="Ignore due_at; process all pending.")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be sent, send nothing.")
    parser.add_argument("--loop", action="store_true", help="Keep polling instead of exiting.")
    parser.add_argument("--interval", type=int, default=300, help="Seconds between polls with --loop.")
    args = parser.parse_args()

    if not args.loop:
        sent = await run_once(force=args.force, dry_run=args.dry_run)
        logger.info("Done — %d sent.", sent)
        return

    logger.info("Polling every %ss (Ctrl-C to stop)...", args.interval)
    while True:
        try:
            await run_once(force=args.force, dry_run=args.dry_run)
        except Exception:
            logger.exception("Follow-up sweep failed; will retry.")
        await asyncio.sleep(args.interval)


if __name__ == "__main__":
    asyncio.run(main())

"""Telegram channel — long-polling worker.

Long-polling (not webhooks) means we need NO public URL / ngrok for local dev:
python-telegram-bot pulls updates from Telegram's servers over an outbound
connection.

Each Telegram chat maps to a graph thread_id of the form `telegram:<chat_id>`.
The prefix keeps channels from colliding when we add web chat / WhatsApp later.

Run:  python -m app.channels.telegram_bot
"""

from __future__ import annotations

import logging

from telegram import Update
from telegram.ext import (
    Application,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from app.config import settings
from app.graph.build import graph_with_checkpointer
from app.inbound import handle_inbound

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger("replyo.telegram")


async def handle_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """/start — greet. (Telegram sends this automatically on first open.)"""
    await update.message.reply_text(
        "👋 Hi! I'm the BrightSmile Dental assistant. Ask about our services, "
        "book a visit, or tell me what you need. Send /reset anytime to start over."
    )


async def handle_reset(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """/reset — wipe this chat's server-side memory so the next message is a clean start.

    Because conversation state lives in Postgres (keyed by telegram:<chat_id>), the
    only way to truly start fresh in a 1:1 bot chat is to delete that thread.
    """
    chat_id = update.effective_chat.id
    thread_id = f"telegram:{chat_id}"
    graph = context.bot_data["graph"]
    await graph.checkpointer.adelete_thread(thread_id)
    logger.info("reset thread %s", thread_id)
    await update.message.reply_text("🧹 Conversation reset — we're starting fresh.")


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Route an inbound Telegram message through the graph and reply."""
    if not update.message or not update.message.text:
        return

    chat_id = update.effective_chat.id
    thread_id = f"telegram:{chat_id}"
    text = update.message.text

    # The compiled graph is stashed on bot_data at startup (see main()).
    # handle_inbound also queues an escalated reply for approval and arms the
    # re-engagement nudge, so this handler only has to send the reply.
    graph = context.bot_data["graph"]
    result = await handle_inbound(
        graph, thread_id=thread_id, channel="telegram", chat_id=str(chat_id), text=text
    )

    logger.info("chat=%s intent=%s held=%s", chat_id, result["intent"], result.get("held"))
    await update.message.reply_text(result["reply"])


async def _post_init(application: Application) -> None:
    """Open the checkpointer-backed graph once and keep it for the process."""
    # Enter the async context manually and stash both the graph and the context
    # manager so we can close the Postgres pool on shutdown. (The pending_reviews
    # table is provisioned via Supabase migrations, not here.)
    cm = graph_with_checkpointer()
    graph = await cm.__aenter__()
    application.bot_data["graph"] = graph
    application.bot_data["_graph_cm"] = cm


async def _post_shutdown(application: Application) -> None:
    cm = application.bot_data.get("_graph_cm")
    if cm is not None:
        await cm.__aexit__(None, None, None)


def main() -> None:
    if not settings.telegram_bot_token:
        raise SystemExit(
            "TELEGRAM_BOT_TOKEN is not set. Create a bot with @BotFather and add it to .env."
        )

    application = (
        Application.builder()
        .token(settings.telegram_bot_token)
        .post_init(_post_init)
        .post_shutdown(_post_shutdown)
        .build()
    )
    application.add_handler(CommandHandler("start", handle_start))
    application.add_handler(CommandHandler("reset", handle_reset))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    logger.info("Replyo Telegram bot starting (long-polling)...")
    application.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()

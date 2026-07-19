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
    ContextTypes,
    MessageHandler,
    filters,
)

from app.config import settings
from app.graph.build import graph_with_checkpointer, run_turn

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger("replyo.telegram")


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Route an inbound Telegram message through the graph and reply."""
    if not update.message or not update.message.text:
        return

    chat_id = update.effective_chat.id
    thread_id = f"telegram:{chat_id}"
    text = update.message.text

    # The compiled graph is stashed on bot_data at startup (see main()).
    graph = context.bot_data["graph"]
    result = await run_turn(graph, thread_id, text)

    logger.info("chat=%s intent=%s", chat_id, result["intent"])
    await update.message.reply_text(result["reply"])


async def _post_init(application: Application) -> None:
    """Open the checkpointer-backed graph once and keep it for the process."""
    # Enter the async context manually and stash both the graph and the context
    # manager so we can close the Postgres pool on shutdown.
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
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    logger.info("Replyo Telegram bot starting (long-polling)...")
    application.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()

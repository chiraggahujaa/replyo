"""Outbound channel delivery.

After a review is resolved, the final reply must reach the customer on whatever
channel they messaged from. FastAPI (which handles the dashboard action) may be a
different process from the Telegram worker, so we send directly via the Telegram
Bot HTTP API rather than through a running bot instance.
"""

from __future__ import annotations

import logging

import httpx

from app.config import settings

logger = logging.getLogger("replyo.notify")


async def send_to_channel(channel: str, chat_id: str | None, text: str) -> None:
    """Deliver `text` to the customer on their channel. No-op for channels we can't push to."""
    if channel == "telegram" and chat_id:
        await _send_telegram(chat_id, text)
    else:
        # e.g. the 'api'/web channel has no push target here; the final text is
        # stored on the review row for retrieval instead.
        logger.info("No push target for channel=%s; final text stored on review only.", channel)


async def _send_telegram(chat_id: str, text: str) -> None:
    url = f"https://api.telegram.org/bot{settings.telegram_bot_token}/sendMessage"
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(url, json={"chat_id": chat_id, "text": text})
        if resp.status_code != 200:
            logger.error("Telegram send failed (%s): %s", resp.status_code, resp.text)

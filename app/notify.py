"""Outbound channel delivery.

Anything sent to a customer *outside* a live request goes through here: a reply a
human approved in the dashboard, and the scheduled re-engagement nudges. The
process doing the sending (FastAPI, or the follow-up worker) is usually not the
process that received the message, so we call each provider's HTTP API directly
rather than reaching into a running bot instance.

Adding a channel here is what makes both of those features work on it — neither
the review flow nor the follow-up worker needs to know the channel exists.
"""

from __future__ import annotations

import logging

import httpx

from app.config import settings

logger = logging.getLogger("replyo.notify")


async def send_to_channel(channel: str, chat_id: str | None, text: str) -> None:
    """Deliver `text` to the customer on their channel. No-op where we can't push."""
    if channel == "telegram" and chat_id:
        await _send_telegram(chat_id, text)
    elif channel == "whatsapp" and chat_id:
        await _send_whatsapp(chat_id, text)
    else:
        # The 'web'/'api' channel has no push target: the browser has no address we
        # can reach. It doesn't need one — the message is written into graph state,
        # and the widget picks it up by polling /chat/{thread_id}/messages.
        logger.info("No push target for channel=%s; message left in thread state.", channel)


async def _send_telegram(chat_id: str, text: str) -> None:
    url = f"https://api.telegram.org/bot{settings.telegram_bot_token}/sendMessage"
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(url, json={"chat_id": chat_id, "text": text})
        if resp.status_code != 200:
            logger.error("Telegram send failed (%s): %s", resp.status_code, resp.text)


async def _send_whatsapp(to: str, text: str) -> None:
    """Send a WhatsApp text via the Meta Cloud API.

    Only valid inside the 24-hour customer-service window (i.e. replying to someone
    who messaged us) — which is exactly what this app does, and why it stays free.
    Outside that window Meta requires a pre-approved template instead.
    """
    if not settings.whatsapp_enabled:
        logger.warning("WhatsApp not configured; dropping message to %s.", to)
        return

    url = (
        f"https://graph.facebook.com/{settings.whatsapp_api_version}"
        f"/{settings.whatsapp_phone_number_id}/messages"
    )
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            url,
            headers={"Authorization": f"Bearer {settings.whatsapp_access_token}"},
            json={
                "messaging_product": "whatsapp",
                "to": to,
                "type": "text",
                "text": {"body": text},
            },
        )
        if resp.status_code >= 400:
            logger.error("WhatsApp send failed (%s): %s", resp.status_code, resp.text)

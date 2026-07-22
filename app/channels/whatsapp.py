"""WhatsApp channel — Meta Cloud API webhook.

Unlike Telegram (long-polling, no public URL needed), WhatsApp *pushes* to us, so
this is a webhook mounted on the FastAPI app and the API must be reachable over
HTTPS — use a tunnel in dev:

    cloudflared tunnel --url http://localhost:8000

Two routes, both under /webhooks/whatsapp:

  GET   Meta's one-time verification handshake. It calls us with hub.mode,
        hub.verify_token and hub.challenge; we echo the challenge back as PLAIN
        TEXT (not JSON) if the token matches, and Meta marks the webhook verified.
  POST  Inbound messages.

`parse_inbound()` is deliberately a pure function over the payload so the awkward
nesting Meta uses is unit-testable without a live webhook (see
scripts/test_whatsapp.py).
"""

from __future__ import annotations

import logging
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request, Response

from app.config import settings
from app.inbound import handle_inbound
from app.notify import send_to_channel

logger = logging.getLogger("replyo.whatsapp")

router = APIRouter(prefix="/webhooks/whatsapp", tags=["whatsapp"])


@dataclass(frozen=True)
class InboundMessage:
    message_id: str  # Meta's wamid — used to drop duplicate deliveries
    from_number: str  # the patient's phone number, digits only
    text: str

    @property
    def thread_id(self) -> str:
        # Namespaced like telegram:<chat_id> / web:<uuid> so channels never collide.
        return f"whatsapp:{self.from_number}"


def parse_inbound(payload: dict[str, Any]) -> list[InboundMessage]:
    """Pull text messages out of a Meta webhook payload.

    The shape is entry[].changes[].value.messages[]. Everything that isn't a text
    message is ignored on purpose: `statuses` callbacks (delivered/read receipts)
    arrive on the same webhook and would otherwise be treated as user input, and
    media/location/button messages have no `text.body` for the graph to read.
    """
    out: list[InboundMessage] = []
    for entry in payload.get("entry") or []:
        for change in entry.get("changes") or []:
            value = change.get("value") or {}
            for msg in value.get("messages") or []:
                if msg.get("type") != "text":
                    continue
                body = ((msg.get("text") or {}).get("body") or "").strip()
                sender = msg.get("from")
                msg_id = msg.get("id")
                if not body or not sender or not msg_id:
                    continue
                out.append(InboundMessage(message_id=msg_id, from_number=sender, text=body))
    return out


class _SeenMessages:
    """Remembers recently handled message ids so Meta's retries are no-ops.

    Meta re-delivers a webhook if we don't 200 quickly, and re-running the graph
    would double-charge OpenAI and double-reply to the patient. An in-process
    bounded set is enough here; a multi-process deployment would move this to
    Postgres (one row per wamid) — noted rather than built.
    """

    def __init__(self, maxlen: int = 512) -> None:
        self._ids: OrderedDict[str, None] = OrderedDict()
        self._maxlen = maxlen

    def seen(self, message_id: str) -> bool:
        if message_id in self._ids:
            return True
        self._ids[message_id] = None
        if len(self._ids) > self._maxlen:
            self._ids.popitem(last=False)
        return False


_seen = _SeenMessages()


@router.get("")
async def verify(
    mode: str | None = Query(None, alias="hub.mode"),
    token: str | None = Query(None, alias="hub.verify_token"),
    challenge: str | None = Query(None, alias="hub.challenge"),
) -> Response:
    """Meta's subscription handshake — echo the challenge back as plain text."""
    if mode == "subscribe" and token and token == settings.whatsapp_verify_token:
        logger.info("WhatsApp webhook verified.")
        return Response(content=challenge or "", media_type="text/plain")
    logger.warning("WhatsApp webhook verification failed (mode=%s).", mode)
    raise HTTPException(status_code=403, detail="Verification failed")


@router.post("")
async def receive(request: Request) -> dict:
    """Handle inbound WhatsApp messages.

    Always returns 200: a non-2xx makes Meta retry the same payload, which would
    just repeat whatever failed. Errors are logged instead.
    """
    payload = await request.json()
    messages = parse_inbound(payload)
    if not messages:
        return {"status": "ignored"}

    graph = request.app.state.graph
    handled = 0
    for msg in messages:
        if _seen.seen(msg.message_id):
            logger.info("Duplicate WhatsApp delivery %s — skipping.", msg.message_id)
            continue
        try:
            result = await handle_inbound(
                graph,
                thread_id=msg.thread_id,
                channel="whatsapp",
                chat_id=msg.from_number,
                text=msg.text,
            )
            await send_to_channel("whatsapp", msg.from_number, result["reply"])
            logger.info(
                "whatsapp=%s intent=%s held=%s", msg.from_number, result["intent"], result.get("held")
            )
            handled += 1
        except Exception:
            logger.exception("Failed to handle WhatsApp message %s", msg.message_id)

    return {"status": "ok", "handled": handled}

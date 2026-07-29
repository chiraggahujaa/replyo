"""Realtime fan-out to open chat widgets and dashboard consoles.

Three kinds of event need to reach a browser that isn't in the middle of a request:

  * a reply a human just approved in the dashboard  (published by the API process)
  * a scheduled 48h re-engagement nudge             (published by the follow-up worker)
  * a queue/knowledge change for the dashboard      (published by Postgres triggers —
    see the admin_change_notify migration)

The awkward part is that events come from *different processes* than the one holding
the websocket (the follow-up worker, the Telegram worker escalating a message, another
uvicorn worker). Postgres LISTEN/NOTIFY solves all of it without adding Redis or any
other infrastructure — any process (or trigger) NOTIFYs on one channel, and every API
process LISTENs and forwards the event to whichever sockets it happens to be holding.

Sockets register under an opaque routing key: chat widgets use their tenant-scoped
thread id, dashboard consoles use `admin:<tenant_id>` (see `admin_key`). The NOTIFY
envelope is `{"key": ..., "event": {...}}`.

Verified working through Supabase's **session** pooler (port 5432). It would NOT work
through the transaction pooler on 6543 — the same reason the README insists on the
session pooler for `DATABASE_URL`.

Interactive turns don't go through here: those tokens are written straight to the
requesting socket, since the process serving the socket is the one generating them.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections import defaultdict
from typing import Any

import psycopg

from app.config import settings

logger = logging.getLogger("replyo.realtime")

CHANNEL = "replyo_events"  # the admin_change_notify migration hardcodes this name too
# Postgres hard-limits a NOTIFY payload to 8000 bytes; stay well under it and fall
# back to telling the client to re-sync over HTTP if an event is ever too big.
MAX_PAYLOAD = 7000


def admin_key(tenant_id: str) -> str:
    """Routing key a dashboard console registers under. The admin_change_notify
    migration builds the same 'admin:<tenant_id>' string in SQL — keep them in step.

    The 'admin:' prefix is deliberately outside the namespace widget sockets can
    claim: ws_chat registers scoped_thread() keys, which always start with a
    resolved tenant UUID — never the literal 'admin' — so an anonymous visitor
    can't register here and receive a tenant's queue events."""
    return f"admin:{tenant_id}"


class Hub:
    """Tracks the websockets this process holds and bridges them to Postgres."""

    def __init__(self) -> None:
        self._sockets: dict[str, set[Any]] = defaultdict(set)
        self._task: asyncio.Task | None = None

    # ---- local socket registry ----

    def register(self, key: str, ws: Any) -> None:
        self._sockets[key].add(ws)

    def unregister(self, key: str, ws: Any) -> None:
        conns = self._sockets.get(key)
        if not conns:
            return
        conns.discard(ws)
        if not conns:
            self._sockets.pop(key, None)

    def connection_count(self, key: str) -> int:
        return len(self._sockets.get(key, ()))

    async def deliver_local(self, key: str, event: dict) -> None:
        """Send an event to every socket this process holds for the routing key."""
        for ws in list(self._sockets.get(key, ())):
            try:
                await ws.send_json(event)
            except Exception:
                # A dead socket shouldn't stop the others; the endpoint's finally
                # block unregisters it on disconnect anyway.
                logger.debug("Dropping a closed socket for %s", key, exc_info=True)
                self.unregister(key, ws)

    # ---- cross-process publish ----

    async def publish(self, key: str, event: dict) -> None:
        """Broadcast an event to every process (including this one).

        Never raises: realtime delivery is a nicety layered on top of state that is
        already persisted, so a failure here must not break an approval or a nudge.
        The widget re-syncs on its next connect regardless.
        """
        try:
            payload = json.dumps({"key": key, "event": event})
            if len(payload.encode()) > MAX_PAYLOAD:
                # Too big to ship through NOTIFY — tell the client to pull instead.
                payload = json.dumps({"key": key, "event": {"type": "refresh"}})
            # Publishes are rare (an approval, a nudge), so a short-lived connection
            # is simpler than keeping a dedicated publisher pool warm.
            conn = await psycopg.AsyncConnection.connect(settings.database_url, autocommit=True)
            try:
                await conn.execute("select pg_notify(%s, %s)", (CHANNEL, payload))
            finally:
                await conn.close()
        except Exception:
            logger.exception("Realtime publish failed for %s", key)

    # ---- listener ----

    async def _listen_forever(self) -> None:
        attached_before = False
        while True:
            try:
                conn = await psycopg.AsyncConnection.connect(
                    settings.database_url, autocommit=True
                )
                await conn.execute(f"LISTEN {CHANNEL}")
                logger.info("Realtime listener attached (channel=%s).", CHANNEL)
                if attached_before:
                    # NOTIFY is fire-and-forget: anything published while we were
                    # detached is gone. Tell every socket we hold to re-pull over
                    # HTTP (both the widget and the dashboard handle "refresh").
                    for key in list(self._sockets):
                        await self.deliver_local(key, {"type": "refresh"})
                attached_before = True
                async for note in conn.notifies():
                    try:
                        data = json.loads(note.payload)
                        # "thread_id" kept for any publisher predating the key rename.
                        key = data.get("key") or data.get("thread_id")
                        if key:
                            await self.deliver_local(key, data["event"])
                    except Exception:
                        logger.exception("Bad realtime payload: %s", note.payload[:200])
            except asyncio.CancelledError:
                raise
            except Exception:
                # Connection dropped (restart, network blip) — back off and retry.
                logger.exception("Realtime listener died; reconnecting in 3s.")
                await asyncio.sleep(3)

    async def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._listen_forever())

    async def stop(self) -> None:
        if self._task is None:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None


hub = Hub()


async def publish_message(thread_id: str, content: str, *, source: str) -> None:
    """Push an assistant message that was produced outside a live request.

    `source` is informational for the client ("approval" | "followup").
    """
    await hub.publish(
        thread_id,
        {"type": "message", "role": "ai", "content": content, "source": source},
    )

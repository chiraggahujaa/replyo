"""FastAPI entry point.

Endpoints:
  GET  /health                    -> liveness check
  POST /chat                      -> run one graph turn for a given thread_id
  GET  /chat/{id}/messages        -> that thread's transcript (widget history +
                                     fallback when a websocket can't be opened)
  WS   /ws/chat/{id}              -> live chat: streams reply tokens, and pushes
                                     approved replies / follow-up nudges
  WS   /ws/admin                  -> dashboard change feed: pushes "queue/knowledge
                                     changed" signals so the console needn't poll
  GET  /reviews                   -> list pending human-review items
  GET  /reviews/{id}              -> one review (with conversation + draft)
  POST /reviews/{id}/decision     -> approve/edit/reject; resumes the graph and
                                     delivers the final reply to the customer
  /widget/widget.js               -> the embeddable chat widget (drop-in script)

The compiled graph (and its Postgres pool) is created once at startup and reused.

Run:  uvicorn app.api:app --reload
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import logging
import re
import time
import uuid
from contextlib import AsyncExitStack, asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator, model_validator

from app import realtime, reviews
from app.admin_api import router as admin_router
from app.channels.whatsapp import router as whatsapp_router
from app.graph.build import graph_with_checkpointer, resume_review
from app.inbound import handle_inbound, scoped_thread
from app.notify import send_to_channel
from app.tenancy import (
    DEMO_TENANT_ID,
    User,
    get_current_user,
    get_tenant,
    tenant_by_public_key,
    tenant_for_user,
    verify_token,
)
from app.widget_config import cache_get, cache_put, sanitize_widget_config

logger = logging.getLogger("replyo.api")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Open the checkpointer-backed graph for the app's lifetime.

    The pending_reviews table is provisioned out-of-band via Supabase migrations
    (`supabase db push`), so there's no schema work to do here.
    """
    async with AsyncExitStack() as stack:
        graph = await stack.enter_async_context(graph_with_checkpointer())
        app.state.graph = graph
        # Listen for events published by any process (this one included) so they can
        # be pushed down open widget sockets.
        await realtime.hub.start()
        try:
            yield
        finally:
            await realtime.hub.stop()


app = FastAPI(title="Replyo", version="0.1.0", lifespan=lifespan)

# The Next.js dashboard (localhost:3000) and any site embedding the chat widget are
# different origins. NOTE: "*" is fine for local dev, but /chat is an unauthenticated
# endpoint that costs OpenAI tokens — put an origin allowlist and rate limiting in
# front of it before exposing this publicly.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

class RevalidatingStaticFiles(StaticFiles):
    """Static files that must always be revalidated before use.

    The widget is embedded on sites we don't control. With no Cache-Control header a
    browser applies *heuristic* caching and can serve a stale widget for a long time —
    so a shipped fix silently never reaches those visitors (and makes local changes look
    like they "didn't apply"). `no-cache` means "you may store it, but revalidate every
    time"; paired with the ETag that's a cheap 304 when nothing changed.
    """

    def file_response(self, *args, **kwargs):
        resp = super().file_response(*args, **kwargs)
        resp.headers["Cache-Control"] = "no-cache"
        return resp


# Public appearance config for the embeddable widget. The tenant's Install-page
# customization (name + styling) is served by public key so a plain src+data-tenant
# tag follows the console; data-* attributes on the tag still win per field. MUST be
# registered BEFORE the /widget static mount below — Starlette matches routes in
# order, so the mount would otherwise swallow this path with a 404.
@app.get("/widget/config")
async def widget_config(response: Response, tenant_key: str | None = None) -> dict:
    # Per-tenant JSON must never be heuristically cached by a shared cache/CDN — the
    # same class of staleness RevalidatingStaticFiles below defends the script against.
    # (The in-process cache_get/cache_put layer is the cheap path instead.)
    response.headers["Cache-Control"] = "no-store"

    cache_key = tenant_key or ""
    hit, cached = cache_get(cache_key)
    if hit:
        if cached is None:
            raise HTTPException(status_code=404, detail="Unknown tenant key")
        return cached

    try:
        tenant = await _resolve_tenant_key(tenant_key)
    except HTTPException as e:
        if e.status_code == 404:
            cache_put(cache_key, None)  # unknown keys mustn't cost a DB trip per probe
        raise
    cfg = sanitize_widget_config(tenant.get("widget_config") or {})
    # Only whitelisted appearance keys leave the server; the header title falls back
    # to the persona's name so an uncustomized widget still greets correctly.
    payload = {"name": cfg.pop("name", None) or tenant["name"], **cfg}
    cache_put(cache_key, payload)
    return payload


# The embeddable chat widget. One drop-in script, served cross-origin to any site
# (the clinic site in clinic-site/ is just another consumer of it).
app.mount(
    "/widget",
    RevalidatingStaticFiles(directory=Path(__file__).parent / "static"),
    name="widget",
)

# WhatsApp webhook (GET verify + POST inbound). Mounted unconditionally: the routes
# are harmless when WhatsApp isn't configured, and Meta needs the verify endpoint
# reachable before you ever hold a valid token.
app.include_router(whatsapp_router)

# Tenant-management API for the dashboard (personas, knowledge, prompt generation).
# Every route requires a signed-in user; see app/admin_api.py.
app.include_router(admin_router)


# Bounds for image attachments on POST /chat. HTTP-only by design: a photo's data URL
# blows past the widget's ~1MB websocket frame budget, so the widget sends any turn
# that carries images through this endpoint even while its socket is open. The regex
# whitelists the media types the vision model accepts and rejects anything that isn't
# pure base64 — a data URL is otherwise an arbitrary-bytes smuggling vector.
MAX_IMAGES_PER_MESSAGE = 4
MAX_IMAGE_CHARS = 1_500_000  # per data-URL string
MAX_IMAGES_TOTAL_CHARS = 4_000_000  # all images in one message combined
IMAGE_DATA_URL = re.compile(r"^data:image/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$")

# File signatures per declared subtype. Shape alone isn't enough: a well-formed data
# URL wrapping 1.5MB of base64 garbage would sail through to the model provider, whose
# rejection is then OUR failure. The decoded bytes must open with the signature of the
# subtype the URL declares. webp is positional (RIFF container: "RIFF" at 0, "WEBP" at
# 8) and is handled separately in the validator.
IMAGE_MAGIC_BYTES = {
    "png": (b"\x89PNG\r\n\x1a\n",),
    "jpeg": (b"\xff\xd8\xff",),
    "gif": (b"GIF87a", b"GIF89a"),
}

# Pydantic's image caps only bite AFTER Starlette has buffered and JSON-parsed the
# whole body — a ~280MB POST is fully materialized in memory before the len>4 check
# can 422 it. The declared Content-Length is checked here, before a byte of body is
# read. The limit is the images budget (MAX_IMAGES_TOTAL_CHARS of base64) plus JSON
# framing/text overhead. Scoped to POST /chat only: it is the one unauthenticated
# endpoint that legitimately accepts multi-megabyte payloads, and other routes must
# not inherit a limit tuned to image attachments.
MAX_CHAT_BODY_BYTES = 6_500_000


@app.middleware("http")
async def limit_chat_body(request: Request, call_next):
    if request.method == "POST" and request.url.path == "/chat":
        # This middleware is registered after CORSMiddleware, which makes it the
        # OUTERMOST layer — short-circuit responses never pass back through CORS
        # processing, so they must carry the allow-origin header themselves or the
        # cross-origin widget sees an opaque network error instead of the detail.
        cors = {"Access-Control-Allow-Origin": "*"}
        declared = request.headers.get("content-length")
        if declared is None:
            # No declared length (e.g. chunked) means the size can't be bounded
            # without reading the body — exactly what this guard must never do.
            return JSONResponse(status_code=411, content={"detail": "Content-Length required"}, headers=cors)
        try:
            length = int(declared)
        except ValueError:
            length = MAX_CHAT_BODY_BYTES + 1  # unparseable declares nothing -> reject
        if length > MAX_CHAT_BODY_BYTES:
            return JSONResponse(status_code=413, content={"detail": "Request body too large"}, headers=cors)
    return await call_next(request)


class ChatRequest(BaseModel):
    thread_id: str = Field(..., description="Conversation id; reuse it to continue a chat.")
    message: str = Field(..., description="The user's inbound message.")
    tenant_key: str | None = Field(
        None, description="The persona's public key (from the widget's data-tenant). Omit to use the demo persona."
    )
    images: list[str] = Field(
        default_factory=list,
        description="Optional image attachments, each a data:image/...;base64 URL.",
    )

    @field_validator("images")
    @classmethod
    def _valid_images(cls, images: list[str]) -> list[str]:
        if len(images) > MAX_IMAGES_PER_MESSAGE:
            raise ValueError(f"At most {MAX_IMAGES_PER_MESSAGE} images per message")
        for img in images:
            # Length before regex: never run a pattern over an unbounded string.
            if len(img) > MAX_IMAGE_CHARS:
                raise ValueError("Image too large")
            m = IMAGE_DATA_URL.fullmatch(img)
            if not m:
                raise ValueError("Images must be data:image/(png|jpeg|webp|gif);base64 URLs")
            subtype, payload = m.group(1), m.group(2)
            # The payload must be real base64 AND real image bytes of the DECLARED
            # subtype — validation is the last stop before these bytes are uploaded
            # to the model provider, and a provider rejection surfaces as our error.
            try:
                raw = base64.b64decode(payload, validate=True)
            except binascii.Error:
                raise ValueError("Image payload is not valid base64") from None
            if subtype == "webp":
                ok = raw[:4] == b"RIFF" and raw[8:12] == b"WEBP"
            else:
                ok = raw.startswith(IMAGE_MAGIC_BYTES[subtype])
            if not ok:
                raise ValueError(f"Image bytes do not match the declared image/{subtype} type")
        if sum(len(img) for img in images) > MAX_IMAGES_TOTAL_CHARS:
            raise ValueError("Combined images too large")
        return images

    @model_validator(mode="after")
    def _text_or_images(self) -> ChatRequest:
        # An image can stand alone, but a turn must carry SOMETHING for the graph.
        if not self.message.strip() and not self.images:
            raise ValueError("message must not be empty unless images are attached")
        return self


class ChatResponse(BaseModel):
    intent: str | None
    reply: str
    held: bool = False
    review_id: str | None = None
    lead_info: dict | None = None
    booking_info: dict | None = None
    citations: list[str] = []
    needs_human: bool = False


class Decision(BaseModel):
    action: str = Field(..., description="approve | edit | reject")
    text: str | None = Field(None, description="Edited/replacement reply (for edit/reject).")


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


def _channel_for(thread_id: str) -> str:
    """The embeddable widget uses `web:…` thread ids; curl/test traffic is `api`.

    Keeping them distinct means traces and follow-up rows show where a conversation
    actually came from.
    """
    return "web" if thread_id.startswith("web:") else "api"


async def _resolve_tenant_key(tenant_key: str | None) -> dict:
    """Public-key -> tenant (the widget path). No key falls back to the demo persona so
    curl/tests keep working; an unknown key is a hard 404."""
    if not tenant_key:
        demo = await get_tenant(DEMO_TENANT_ID)
        if not demo:
            raise HTTPException(status_code=500, detail="Demo persona is missing")
        return demo
    tenant = await tenant_by_public_key(tenant_key)
    if not tenant:
        raise HTTPException(status_code=404, detail="Unknown tenant key")
    return tenant


# What a visitor sees when the owner paused the persona in the console. Delivered as a
# normal reply (not an HTTP error) so every client — widget HTTP fallback, websocket,
# curl — shows something human instead of a generic "couldn't reach us" note.
PAUSED_REPLY = "Thanks for reaching out! We're not taking new chat messages right now — please check back later."


def _is_paused(tenant: dict) -> bool:
    # .get(): rows read before the status migration ran carry no key -> active.
    return tenant.get("status") == "paused"


async def get_active_tenant(
    user: User = Depends(get_current_user), x_tenant_id: str = Header(..., alias="X-Tenant-Id")
) -> dict:
    """Dashboard dependency: the active persona, or 404 unless the user is a member."""
    return await tenant_for_user(user, x_tenant_id)


@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest) -> ChatResponse:
    # The thread is scoped to the RESOLVED tenant server-side, so a client can't name
    # another tenant's conversation. chat_id == thread: neither web nor api has a push
    # target, so held replies surface by polling /chat/{thread_id}/messages instead.
    tenant = await _resolve_tenant_key(req.tenant_key)
    # The widget hides its attach button when the tenant disabled attachments, but the
    # endpoint is public — a hand-crafted POST must not buy vision-model input the
    # owner turned off. Absent key = enabled (the contract default); only an explicit
    # False in the sanitized config blocks.
    if req.images and sanitize_widget_config(tenant.get("widget_config") or {}).get("attachments") is False:
        raise HTTPException(status_code=400, detail="Attachments are disabled for this assistant")
    if _is_paused(tenant):
        # Nothing is written (no graph turn, no follow-up) — the conversation simply
        # doesn't advance while the persona is paused.
        return ChatResponse(intent=None, reply=PAUSED_REPLY, held=False)
    thread = scoped_thread(str(tenant["id"]), req.thread_id)
    # Same failure contract as the websocket path: a graph/provider error must reach
    # the widget as a polite, retryable upstream failure, never a bare 500 traceback.
    try:
        result = await handle_inbound(
            app.state.graph,
            tenant=tenant,
            thread_id=thread,
            channel=_channel_for(req.thread_id),
            chat_id=thread,
            text=req.message,
            images=req.images or None,
        )
    except Exception:
        # The cause is already in the log line above; the 502 replaces it on purpose.
        logger.exception("Chat turn failed for %s", req.thread_id)
        raise HTTPException(status_code=502, detail="Sorry — something went wrong. Please try again.") from None
    return ChatResponse(
        intent=result["intent"],
        reply=result["reply"],
        held=result["held"],
        review_id=result.get("review_id"),
        lead_info=result.get("lead_info"),
        booking_info=result.get("booking_info"),
        citations=result.get("citations", []),
        needs_human=result.get("needs_human", False),
    )


async def _transcript(thread_id: str) -> list[dict]:
    """The thread's conversation, in the same {role, content} shape the dashboard uses.

    Image turns are stored as multimodal content blocks (see run_turn); the widget
    contract keeps "content" plain text ALWAYS, with the data URLs split out under
    "images". Text-only messages keep the exact historical shape — no "images" key —
    because the widget treats an absent key as "no attachments".
    """
    snapshot = await app.state.graph.aget_state({"configurable": {"thread_id": thread_id}})
    out: list[dict] = []
    for m in (snapshot.values or {}).get("messages", []):
        if getattr(m, "type", None) not in ("human", "ai"):
            continue
        if isinstance(m.content, list):
            out.append(
                {
                    "role": m.type,
                    "content": "\n".join(
                        b.get("text") or "" for b in m.content
                        if isinstance(b, dict) and b.get("type") == "text"
                    ).strip(),
                    "images": [
                        b["image_url"]["url"] for b in m.content
                        if isinstance(b, dict) and b.get("type") == "image_url"
                        and isinstance(b.get("image_url"), dict) and b["image_url"].get("url")
                    ],
                }
            )
        else:
            out.append({"role": m.type, "content": m.content})
    return out


@app.get("/chat/{thread_id}/messages")
async def chat_messages(thread_id: str, tenant_key: str | None = None, known: int | None = None) -> dict:
    """Return the conversation transcript for a WEB thread, scoped to its tenant.

    The websocket is the primary transport; this endpoint restores history on page load
    and is the fallback when a socket can't be opened. Two guards make it safe in a
    multi-tenant world (the checkpointer bypasses RLS, so the endpoint must scope itself):
      - `web:` only — Telegram/WhatsApp thread ids (`whatsapp:<phone>` etc.) are
        enumerable; the transcript API is a web-widget feature and never serves them.
      - the thread is scoped to the tenant resolved from `tenant_key`, so one persona's
        key can never read another persona's conversations. Within a persona, the random
        `web:<uuid>` is the visitor's own capability (like an unguessable link).
    Unknown threads return an empty list — a brand-new visitor simply has no history yet.
    """
    if not thread_id.startswith("web:"):
        raise HTTPException(status_code=404, detail="Not found")
    tenant = await _resolve_tenant_key(tenant_key)
    messages = await _transcript(scoped_thread(str(tenant["id"]), thread_id))
    # `known` = how many messages the caller already holds. The widget polls this
    # every 4s while its socket is down, and image turns ride inline as base64 — an
    # unchanged transcript must cost a count, not megabytes, per tick.
    if known == len(messages):
        return {"count": len(messages)}
    return {"messages": messages, "count": len(messages)}


@app.websocket("/ws/chat/{thread_id}")
async def ws_chat(ws: WebSocket, thread_id: str, tenant_key: str | None = None) -> None:
    """Live chat socket for the embeddable widget.

    Connect with the persona's public key as a query param:
        /ws/chat/<thread_id>?tenant_key=pk_...

    client -> server:  {"type": "user_message", "text": "..."}
    server -> client:  sync | typing | token | message | error

    Tokens stream as the reply is generated, then a trailing `message` event carries
    the authoritative text — the two can differ on purpose: an escalated turn replies
    with a holding message rather than the draft that's awaiting approval.

    Registering with the hub is what lets out-of-band messages (a human approval, a
    48h nudge from the worker process) arrive on this same socket.
    """
    await ws.accept()
    try:
        tenant = await _resolve_tenant_key(tenant_key)
    except HTTPException:
        await ws.send_json({"type": "error", "message": "Unknown tenant."})
        await ws.close()
        return

    # Scope the thread to the resolved tenant so the socket, the checkpointer, the review
    # queue and the realtime hub all key on the same tenant-bound id (finding: otherwise a
    # client could sync/resume another tenant's conversation).
    thread = scoped_thread(str(tenant["id"]), thread_id)
    realtime.hub.register(thread, ws)
    try:
        await ws.send_json({"type": "sync", "messages": await _transcript(thread)})

        while True:
            data = await ws.receive_json()
            if data.get("type") != "user_message":
                continue
            text = (data.get("text") or "").strip()
            if not text:
                continue

            # Re-check lifecycle every turn: the socket outlives console changes, so a
            # pause (or delete) must bite on the visitor's next message, not their next
            # page load. Refreshing `tenant` also picks up live prompt/name edits.
            current = await get_tenant(str(tenant["id"]))
            if current is None:
                await ws.send_json({"type": "error", "message": "This assistant is no longer available."})
                await ws.close()
                return  # finally still unregisters
            tenant = current
            if _is_paused(tenant):
                await ws.send_json(
                    {"type": "message", "role": "ai", "content": PAUSED_REPLY, "held": False, "intent": None}
                )
                continue

            await ws.send_json({"type": "typing"})

            async def on_token(chunk: str) -> None:
                await ws.send_json({"type": "token", "text": chunk})

            try:
                result = await handle_inbound(
                    app.state.graph,
                    tenant=tenant,
                    thread_id=thread,
                    channel="web",
                    chat_id=thread,
                    text=text,
                    on_token=on_token,
                )
            except Exception:
                logger.exception("Websocket turn failed for %s", thread_id)
                await ws.send_json(
                    {"type": "error", "message": "Sorry — something went wrong. Please try again."}
                )
                continue

            await ws.send_json(
                {
                    "type": "message",
                    "role": "ai",
                    "content": result["reply"],
                    "held": result.get("held", False),
                    "intent": result.get("intent"),
                }
            )
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("Websocket closed unexpectedly for %s", thread)
    finally:
        realtime.hub.unregister(thread, ws)


# How long a fresh admin socket gets to present its auth frame before we hang up.
ADMIN_WS_AUTH_TIMEOUT = 10
# Application-level heartbeat. Protocol pings don't reach browser JS, so the client
# can't tell a half-open TCP connection (laptop sleep, network switch) from a quiet
# one — it watches for these frames and abandons a socket that goes silent.
ADMIN_WS_PING_INTERVAL = 25


@app.websocket("/ws/admin")
async def ws_admin(ws: WebSocket) -> None:
    """Live change feed for the dashboard (review queue + knowledge ingestion).

    Browsers can't set an Authorization header on a WebSocket, so the FIRST frame
    authenticates — a message rather than a query param keeps the token out of URLs
    and access logs:

        client -> server:  {"type": "auth", "token": "<supabase jwt>", "tenant_id": "..."}
        server -> client:  {"type": "ready"}
        server -> client:  {"type": "change", "topic": "reviews" | "knowledge", ...}

    Events originate from Postgres triggers (see the admin_change_notify migration)
    and arrive via the same hub the chat sockets use. They are invalidation signals
    only — no row data crosses this socket. The client refetches over the
    authenticated HTTP API, so RLS still decides what it can actually see, and a
    socket that outlives a revoked membership can leak nothing but "something changed".

    Close codes: 4401 = bad/expired token (reconnect with a fresh one),
    4403 = not a member of that persona (reconnecting won't help).
    """
    await ws.accept()
    key: str | None = None
    try:
        try:
            async with asyncio.timeout(ADMIN_WS_AUTH_TIMEOUT):
                first = await ws.receive_json()
        # Silent client, a non-JSON frame, or a binary frame (receive_json reads the
        # "text" key, so a bytes frame surfaces as KeyError rather than ValueError).
        except (TimeoutError, ValueError, KeyError):
            await ws.close(code=4401)
            return
        if not isinstance(first, dict) or first.get("type") != "auth":
            await ws.close(code=4401)
            return

        try:
            claims = verify_token(str(first.get("token") or ""))
        except HTTPException:
            await ws.close(code=4401)
            return
        sub = claims.get("sub")
        if not sub:
            await ws.close(code=4401)
            return

        tenant_id = str(first.get("tenant_id") or "")
        try:
            uuid.UUID(tenant_id)  # malformed ids would surface as DB errors below
        except ValueError:
            await ws.close(code=4403)
            return
        try:
            # The same membership chokepoint every dashboard HTTP route goes through.
            tenant = await tenant_for_user(User(id=sub, email=claims.get("email")), tenant_id)
        except HTTPException:
            await ws.close(code=4403)
            return

        key = realtime.admin_key(str(tenant["id"]))
        realtime.hub.register(key, ws)
        await ws.send_json({"type": "ready"})

        # Hold the socket open until the token would expire, ignoring any client
        # chatter; the hub pushes events the whole time. A quiet stretch gets a
        # heartbeat frame instead — the client's staleness watchdog depends on them,
        # and the send doubles as our own probe of a dead TCP path. Closing at exp
        # forces a reconnect-with-fresh-token, so a signed-out browser's feed dies
        # with its session instead of living forever.
        deadline = float(claims.get("exp") or 0) or (time.time() + 3600)
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                break
            try:
                async with asyncio.timeout(min(remaining, ADMIN_WS_PING_INTERVAL)):
                    await ws.receive_text()
            except TimeoutError:
                await ws.send_json({"type": "ping"})
        await ws.close(code=4401)
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("Admin websocket closed unexpectedly")
    finally:
        if key is not None:
            realtime.hub.unregister(key, ws)


@app.get("/reviews")
async def list_reviews(tenant: dict = Depends(get_active_tenant)) -> list[dict]:
    return await reviews.list_pending(tenant_id=str(tenant["id"]))


@app.get("/reviews/{review_id}")
async def get_review(review_id: str, tenant: dict = Depends(get_active_tenant)) -> dict:
    row = await reviews.get_review(review_id, tenant_id=str(tenant["id"]))
    if not row:
        raise HTTPException(status_code=404, detail="Review not found")
    return row


@app.post("/reviews/{review_id}/decision")
async def decide(
    review_id: str, decision: Decision, tenant: dict = Depends(get_active_tenant)
) -> dict:
    tenant_id = str(tenant["id"])
    # get_review is tenant-scoped, so a review belonging to another persona is simply
    # not found — a member of tenant A can never act on tenant B's queue.
    row = await reviews.get_review(review_id, tenant_id=tenant_id)
    if not row:
        raise HTTPException(status_code=404, detail="Review not found")
    if decision.action not in ("approve", "edit", "reject"):
        raise HTTPException(status_code=400, detail="action must be approve|edit|reject")
    if row["status"] != "pending":
        raise HTTPException(status_code=409, detail="Review already resolved")

    # Claim the row BEFORE resuming the graph. The claim's own `status = 'pending'`
    # guard is the concurrency control: two staff deciding the same review at once
    # (likelier now that escalations push to every open dashboard) race the UPDATE,
    # exactly one wins, and the loser gets the same 409 as the check above.
    if not await reviews.claim_pending(review_id, tenant_id=tenant_id, decision=decision.action):
        raise HTTPException(status_code=409, detail="Review already resolved")

    try:
        # Resume the paused graph with the human's decision -> final reply.
        final = await resume_review(
            app.state.graph, row["thread_id"], {"action": decision.action, "text": decision.text}
        )
    except Exception:
        # Nothing reached the customer yet, so releasing the claim makes a retry safe.
        await reviews.release_claim(review_id, tenant_id=tenant_id)
        raise
    # Deliver to the customer on their original channel. Telegram/WhatsApp get a push;
    # the web widget has no push address, so the message is broadcast to any socket it
    # has open (and is in the transcript regardless, for whenever it reconnects).
    try:
        await send_to_channel(row["channel"], row.get("chat_id"), final)
    except Exception:
        # The graph is already resumed and the reply is in the transcript, so
        # un-resolving here would invite a double-resume — the very race the claim
        # exists to prevent. Keep the row resolved and surface the delivery failure.
        logger.exception("Delivery failed for review %s on %s", review_id, row["channel"])
    await realtime.publish_message(row["thread_id"], final, source="approval")
    await reviews.store_final(review_id, tenant_id=tenant_id, final_text=final)
    return {"status": "resolved", "final_reply": final}

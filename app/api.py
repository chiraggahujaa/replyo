"""FastAPI entry point.

Endpoints:
  GET  /health                    -> liveness check
  POST /chat                      -> run one graph turn for a given thread_id
  GET  /chat/{id}/messages        -> that thread's transcript (widget history +
                                     fallback when a websocket can't be opened)
  WS   /ws/chat/{id}              -> live chat: streams reply tokens, and pushes
                                     approved replies / follow-up nudges
  GET  /reviews                   -> list pending human-review items
  GET  /reviews/{id}              -> one review (with conversation + draft)
  POST /reviews/{id}/decision     -> approve/edit/reject; resumes the graph and
                                     delivers the final reply to the customer
  /widget/widget.js               -> the embeddable chat widget (drop-in script)

The compiled graph (and its Postgres pool) is created once at startup and reused.

Run:  uvicorn app.api:app --reload
"""

from __future__ import annotations

import logging
from contextlib import AsyncExitStack, asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app import realtime, reviews
from app.channels.whatsapp import router as whatsapp_router
from app.graph.build import graph_with_checkpointer, resume_review
from app.inbound import handle_inbound
from app.notify import send_to_channel

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

# The embeddable chat widget. One drop-in script, served cross-origin to any site
# (the clinic site in clinic-site/ is just another consumer of it).
app.mount(
    "/widget",
    StaticFiles(directory=Path(__file__).parent / "static"),
    name="widget",
)

# WhatsApp webhook (GET verify + POST inbound). Mounted unconditionally: the routes
# are harmless when WhatsApp isn't configured, and Meta needs the verify endpoint
# reachable before you ever hold a valid token.
app.include_router(whatsapp_router)


class ChatRequest(BaseModel):
    thread_id: str = Field(..., description="Conversation id; reuse it to continue a chat.")
    message: str = Field(..., description="The user's inbound message.")


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
    """The embeddable widget uses `web:<uuid>` thread ids; curl/test traffic is `api`.

    Keeping them distinct means traces and follow-up rows show where a conversation
    actually came from.
    """
    return "web" if thread_id.startswith("web:") else "api"


@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest) -> ChatResponse:
    # chat_id == thread_id: neither channel has an external push target, so replies
    # held for approval are surfaced by polling /chat/{thread_id}/messages instead.
    result = await handle_inbound(
        app.state.graph,
        thread_id=req.thread_id,
        channel=_channel_for(req.thread_id),
        chat_id=req.thread_id,
        text=req.message,
    )
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
    """The thread's conversation, in the same {role, content} shape the dashboard uses."""
    snapshot = await app.state.graph.aget_state({"configurable": {"thread_id": thread_id}})
    return [
        {"role": m.type, "content": m.content}
        for m in (snapshot.values or {}).get("messages", [])
        if getattr(m, "type", None) in ("human", "ai")
    ]


@app.get("/chat/{thread_id}/messages")
async def chat_messages(thread_id: str) -> dict:
    """Return the conversation transcript for a thread, straight from the checkpointer.

    The websocket is the primary transport, but this endpoint is what makes the widget
    resilient: it restores history on page load and acts as the fallback whenever a
    socket can't be established. Unknown threads return an empty list rather than 404 —
    a brand-new visitor simply has no history yet.
    """
    messages = await _transcript(thread_id)
    return {"messages": messages, "count": len(messages)}


@app.websocket("/ws/chat/{thread_id}")
async def ws_chat(ws: WebSocket, thread_id: str) -> None:
    """Live chat socket for the embeddable widget.

    client -> server:  {"type": "user_message", "text": "..."}
    server -> client:  sync | typing | token | message | error

    Tokens stream as the reply is generated, then a trailing `message` event carries
    the authoritative text — the two can differ on purpose: answer_from_docs appends a
    `Sources:` footer, and an escalated turn replies with a holding message rather than
    the draft that's awaiting approval.

    Registering with the hub is what lets out-of-band messages (a human approval, a
    48h nudge from the worker process) arrive on this same socket.
    """
    await ws.accept()
    realtime.hub.register(thread_id, ws)
    try:
        await ws.send_json({"type": "sync", "messages": await _transcript(thread_id)})

        while True:
            data = await ws.receive_json()
            if data.get("type") != "user_message":
                continue
            text = (data.get("text") or "").strip()
            if not text:
                continue

            await ws.send_json({"type": "typing"})

            async def on_token(chunk: str) -> None:
                await ws.send_json({"type": "token", "text": chunk})

            try:
                result = await handle_inbound(
                    app.state.graph,
                    thread_id=thread_id,
                    channel="web",
                    chat_id=thread_id,
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
        logger.exception("Websocket closed unexpectedly for %s", thread_id)
    finally:
        realtime.hub.unregister(thread_id, ws)


@app.get("/reviews")
async def list_reviews() -> list[dict]:
    return await reviews.list_pending()


@app.get("/reviews/{review_id}")
async def get_review(review_id: str) -> dict:
    row = await reviews.get_review(review_id)
    if not row:
        raise HTTPException(status_code=404, detail="Review not found")
    return row


@app.post("/reviews/{review_id}/decision")
async def decide(review_id: str, decision: Decision) -> dict:
    row = await reviews.get_review(review_id)
    if not row:
        raise HTTPException(status_code=404, detail="Review not found")
    if row["status"] != "pending":
        raise HTTPException(status_code=409, detail="Review already resolved")
    if decision.action not in ("approve", "edit", "reject"):
        raise HTTPException(status_code=400, detail="action must be approve|edit|reject")

    # Resume the paused graph with the human's decision -> final reply.
    final = await resume_review(
        app.state.graph, row["thread_id"], {"action": decision.action, "text": decision.text}
    )
    # Deliver to the customer on their original channel. Telegram/WhatsApp get a push;
    # the web widget has no push address, so the message is broadcast to any socket it
    # has open (and is in the transcript regardless, for whenever it reconnects).
    await send_to_channel(row["channel"], row.get("chat_id"), final)
    await realtime.publish_message(row["thread_id"], final, source="approval")
    await reviews.mark_resolved(review_id, decision=decision.action, final_text=final)
    return {"status": "resolved", "final_reply": final}

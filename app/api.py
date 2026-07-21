"""FastAPI entry point.

Endpoints:
  GET  /health                    -> liveness check
  POST /chat                      -> run one graph turn for a given thread_id
  GET  /reviews                   -> list pending human-review items
  GET  /reviews/{id}              -> one review (with conversation + draft)
  POST /reviews/{id}/decision     -> approve/edit/reject; resumes the graph and
                                     delivers the final reply to the customer

The compiled graph (and its Postgres pool) is created once at startup and reused.

Run:  uvicorn app.api:app --reload
"""

from __future__ import annotations

from contextlib import AsyncExitStack, asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from app import followups, reviews
from app.graph.build import graph_with_checkpointer, resume_review, run_turn
from app.notify import send_to_channel


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Open the checkpointer-backed graph for the app's lifetime.

    The pending_reviews table is provisioned out-of-band via Supabase migrations
    (`supabase db push`), so there's no schema work to do here.
    """
    async with AsyncExitStack() as stack:
        graph = await stack.enter_async_context(graph_with_checkpointer())
        app.state.graph = graph
        yield


app = FastAPI(title="Replyo", version="0.1.0", lifespan=lifespan)

# The Next.js dashboard runs on a different origin (localhost:3000) in dev.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten for production
    allow_methods=["*"],
    allow_headers=["*"],
)


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


@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest) -> ChatResponse:
    result = await run_turn(app.state.graph, req.thread_id, req.message)
    review_id = None
    if result.get("held"):
        # Web/api channel: chat_id == thread_id (no external push target).
        review_id = await reviews.create_review(
            thread_id=req.thread_id, channel="api", chat_id=req.thread_id, review=result["review"]
        )
    # Arm (or clear) the 48h re-engagement nudge for this conversation.
    await followups.record_turn(
        thread_id=req.thread_id, channel="api", chat_id=req.thread_id, result=result
    )
    return ChatResponse(
        intent=result["intent"],
        reply=result["reply"],
        held=result["held"],
        review_id=review_id,
        lead_info=result.get("lead_info"),
        booking_info=result.get("booking_info"),
        citations=result.get("citations", []),
        needs_human=result.get("needs_human", False),
    )


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
    # Deliver to the customer on their original channel.
    await send_to_channel(row["channel"], row.get("chat_id"), final)
    await reviews.mark_resolved(review_id, decision=decision.action, final_text=final)
    return {"status": "resolved", "final_reply": final}

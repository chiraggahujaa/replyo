"""FastAPI entry point.

Endpoints:
  GET  /health  -> liveness check
  POST /chat    -> run one graph turn for a given thread_id (curl-testable)

The compiled graph (and its Postgres connection pool) is created once at startup
via a lifespan handler and reused for every request, rather than reconnecting per
call.

Run:  uvicorn app.api:app --reload
"""

from __future__ import annotations

from contextlib import AsyncExitStack, asynccontextmanager

from fastapi import FastAPI
from pydantic import BaseModel, Field

from app.graph.build import graph_with_checkpointer, run_turn


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Open the checkpointer-backed graph for the app's lifetime."""
    async with AsyncExitStack() as stack:
        graph = await stack.enter_async_context(graph_with_checkpointer())
        app.state.graph = graph
        yield
    # AsyncExitStack closes the Postgres pool on shutdown.


app = FastAPI(title="Replyo", version="0.1.0", lifespan=lifespan)


class ChatRequest(BaseModel):
    thread_id: str = Field(..., description="Conversation id; reuse it to continue a chat.")
    message: str = Field(..., description="The user's inbound message.")


class ChatResponse(BaseModel):
    intent: str | None
    reply: str


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest) -> ChatResponse:
    result = await run_turn(app.state.graph, req.thread_id, req.message)
    return ChatResponse(**result)

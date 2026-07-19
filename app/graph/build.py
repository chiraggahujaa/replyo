"""Graph assembly.

`build_graph(checkpointer)` wires the nodes into a compiled graph:

    START -> triage -> respond -> END

The same compiled graph is shared by every entry point (FastAPI, Telegram). The
caller supplies a checkpointer so the graph persists state per thread_id.
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from langchain_core.messages import HumanMessage
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.graph import END, START, StateGraph

from app.config import settings
from app.graph.nodes import respond, triage
from app.graph.state import ConversationState


def build_graph(checkpointer):
    """Compile the conversation graph with the given checkpointer."""
    builder = StateGraph(ConversationState)
    builder.add_node("triage", triage)
    builder.add_node("respond", respond)

    builder.add_edge(START, "triage")
    builder.add_edge("triage", "respond")
    builder.add_edge("respond", END)

    return builder.compile(checkpointer=checkpointer)


@asynccontextmanager
async def graph_with_checkpointer():
    """Async context manager yielding a compiled graph backed by Supabase Postgres.

    Usage:
        async with graph_with_checkpointer() as graph:
            await graph.ainvoke(..., config=...)

    The AsyncPostgresSaver owns a connection pool, so it must be entered/exited as
    a context manager — that's why callers get the graph via this helper.
    """
    async with AsyncPostgresSaver.from_conn_string(settings.database_url) as checkpointer:
        yield build_graph(checkpointer)


async def run_turn(graph, thread_id: str, text: str) -> dict:
    """Run one conversation turn and return {"intent", "reply"}.

    Shared by every entry point (FastAPI, Telegram) so the ingest logic lives in
    exactly one place. `thread_id` selects which persisted conversation to resume.
    """
    config = {"configurable": {"thread_id": thread_id}}
    result = await graph.ainvoke(
        {"messages": [HumanMessage(content=text)]},
        config=config,
    )
    return {
        "intent": result.get("intent"),
        "reply": result["messages"][-1].content,
    }

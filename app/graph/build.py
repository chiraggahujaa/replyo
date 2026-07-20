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
from app.graph.nodes import (
    answer_from_docs,
    handle_booking,
    handle_complaint,
    handle_spam,
    qualify,
    respond,
    triage,
)
from app.graph.state import ConversationState

# Which handler each triage intent routes to.
INTENT_ROUTES = {
    "new_lead": "qualify",
    "question": "answer_from_docs",
    "existing_customer": "respond",
    "booking_request": "handle_booking",
    "complaint": "handle_complaint",
    "spam": "handle_spam",
}


def route_by_intent(state: ConversationState) -> str:
    """Conditional-edge function: return the triage intent (a key of INTENT_ROUTES).

    LangGraph maps this return value to a node via the INTENT_ROUTES path map
    passed to add_conditional_edges. Unknown/None falls back to a safe default.
    """
    intent = state.get("intent")
    return intent if intent in INTENT_ROUTES else "existing_customer"


def build_graph(checkpointer):
    """Compile the conversation graph with the given checkpointer.

        START -> triage -> (conditional) -> one handler -> END
    """
    builder = StateGraph(ConversationState)
    builder.add_node("triage", triage)
    builder.add_node("qualify", qualify)
    builder.add_node("answer_from_docs", answer_from_docs)
    builder.add_node("respond", respond)
    builder.add_node("handle_booking", handle_booking)
    builder.add_node("handle_complaint", handle_complaint)
    builder.add_node("handle_spam", handle_spam)

    builder.add_edge(START, "triage")
    # Fan out from triage to exactly one handler based on the classified intent.
    builder.add_conditional_edges("triage", route_by_intent, INTENT_ROUTES)
    # Every handler is terminal for this turn.
    for handler in set(INTENT_ROUTES.values()):
        builder.add_edge(handler, END)

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
        "lead_info": result.get("lead_info"),
        "booking_info": result.get("booking_info"),
        "citations": result.get("citations") or [],
        "needs_human": result.get("needs_human", False),
    }

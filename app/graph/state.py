"""Graph state.

The state is the single object that flows through every node. LangGraph merges
each node's returned dict into this state. The `messages` channel uses the
`add_messages` reducer so returning a new message *appends* rather than replaces
— that's what gives us a growing conversation transcript.

The Postgres checkpointer snapshots this whole object per `thread_id` after each
step, which is what lets a returning user continue where they left off.
"""

from __future__ import annotations

from typing import Annotated, Literal, TypedDict

from langgraph.graph.message import add_messages

# The five triage buckets. Kept as a Literal so it's self-documenting and easy to
# branch on in later steps.
Intent = Literal[
    "new_lead",
    "existing_customer",
    "booking_request",
    "complaint",
    "spam",
]


class ConversationState(TypedDict, total=False):
    # Full running transcript. `add_messages` appends + de-dupes by id.
    messages: Annotated[list, add_messages]

    # Latest triage classification, written by the triage node.
    intent: Intent | None

    # --- Reserved for later steps (kept here as a map of what's coming) ---
    # lead_info: dict          # budget / need / timeline captured during qualification
    # citations: list          # RAG source snippets backing an answer
    # needs_human: bool        # set when we escalate to the approval dashboard

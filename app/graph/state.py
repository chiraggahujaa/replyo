"""Graph state.

The state is the single object that flows through every node. LangGraph merges
each node's returned dict into this state. The `messages` channel uses the
`add_messages` reducer so returning a new message *appends* rather than replaces
— that's what gives us a growing conversation transcript.

The Postgres checkpointer snapshots this whole object per `thread_id` after each
step, which is what lets a returning user continue where they left off — and, in
Step 2, lets the `qualify` node accumulate lead details slot by slot across many
messages.
"""

from __future__ import annotations

from typing import Annotated, Literal, TypedDict

from langgraph.graph.message import add_messages

# The five triage buckets. Kept as a Literal so it's self-documenting and easy to
# branch on when routing.
Intent = Literal[
    "new_lead",
    "existing_customer",
    "booking_request",
    "complaint",
    "spam",
]


class LeadInfo(TypedDict, total=False):
    """Structured lead-qualification data, filled in progressively by `qualify`.

    Each turn, the qualify node extracts whatever the user has revealed and merges
    it here. `qualified` flips True once the required slots (need, timeline,
    contact) are all present.
    """

    name: str | None       # patient's name
    need: str | None        # dental concern / treatment they want
    timeline: str | None    # how soon they want care
    budget: str | None      # budget or insurance info (optional slot)
    contact: str | None     # phone or email for follow-up
    qualified: bool


class BookingInfo(TypedDict, total=False):
    """Appointment-request slots, filled progressively by `handle_booking`.

    `ready` flips True once name, preferred_time and contact are all present — the
    handler must not claim a booking is confirmed before then. Real calendar
    scheduling arrives in Step 4.
    """

    name: str | None
    preferred_time: str | None  # requested day/time, e.g. "Saturday 3pm"
    contact: str | None         # phone or email
    ready: bool


class ConversationState(TypedDict, total=False):
    # Full running transcript. `add_messages` appends + de-dupes by id.
    messages: Annotated[list, add_messages]

    # Latest triage classification, written by the triage node.
    intent: Intent | None

    # Lead-qualification slots, accumulated across turns by the qualify node.
    lead_info: LeadInfo

    # Appointment-request slots, accumulated across turns by handle_booking.
    booking_info: BookingInfo

    # Set True when a message should be handed to a human (e.g. a complaint).
    # The approval dashboard that consumes this arrives in Step 6.
    needs_human: bool

    # --- Reserved for later steps ---
    # citations: list          # RAG source snippets backing an answer (Step 3)

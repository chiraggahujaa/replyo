"""Graph nodes.

Step 2 splits the single responder into intent-specific handlers:

  triage            -> classify the latest inbound message into five buckets
  qualify           -> (new_lead) slot-fill need/timeline/contact across turns
  respond           -> (existing_customer) general answer
  handle_booking    -> (booking_request) acknowledge; real calendar comes in Step 4
  handle_complaint  -> (complaint) empathise + flag needs_human for a person
  handle_spam       -> (spam) polite, minimal deflection

Each node is a plain function `(state) -> partial_state`. LangGraph routes triage
to exactly one handler (see build.py) and merges what it returns into the state.
"""

from __future__ import annotations

from typing import Optional

from langchain_core.messages import AIMessage, SystemMessage
from pydantic import BaseModel, Field

from app.graph.state import BookingInfo, ConversationState, Intent, LeadInfo
from app.llm import get_chat_model

# --- Business persona (Step 1 stub; RAG over real docs comes in Step 3) ---
CLINIC_NAME = "BrightSmile Dental"

PERSONA = f"""You are the friendly front-desk assistant for {CLINIC_NAME}, a dental clinic.
You help patients and prospects over chat. Be warm, concise, and professional.
Do NOT invent specific prices, insurance coverage, or open appointment slots — this
build has no access to the clinic's documents or calendar yet. If asked for exact
figures or availability, say you'll confirm and offer to take their details.
Keep replies to a few sentences."""


def _reply(state: ConversationState, instructions: str, temperature: float = 0.4) -> AIMessage:
    """Shared helper: prepend a system prompt and ask the model for one reply."""
    model = get_chat_model(temperature=temperature)
    system = SystemMessage(content=f"{PERSONA}\n\n{instructions}")
    return model.invoke([system, *state["messages"]])  # type: ignore[return-value]


# ---- Triage ----

class TriageResult(BaseModel):
    """Structured output schema the model is forced to fill."""

    intent: Intent = Field(
        description=(
            "Classification of the latest user message. "
            "new_lead: a prospective patient asking about services/prices for the first time. "
            "existing_customer: a current patient with a question about their care/account. "
            "booking_request: wants to schedule, reschedule, or cancel an appointment. "
            "complaint: unhappy, frustrated, or reporting a problem. "
            "spam: irrelevant, promotional, or nonsensical."
        )
    )


def triage(state: ConversationState) -> dict:
    """Classify the most recent user message into an Intent."""
    model = get_chat_model(temperature=0.0).with_structured_output(TriageResult)
    system = SystemMessage(
        content=(
            "You are a triage classifier for a dental clinic's inbound messages. "
            "Read the conversation and classify the latest user message."
        )
    )
    result: TriageResult = model.invoke([system, *state["messages"]])  # type: ignore[assignment]
    return {"intent": result.intent}


# ---- Shared slot-filling engine (used by qualify AND handle_booking) ----
#
# Both lead qualification and appointment booking are the same shape: pull known
# details from the conversation, merge with what we already stored, then either ask
# for the next missing required slot or confirm once everything is present. We keep
# that logic in one place so neither node can "forget" to collect a required field.


def _extract_and_merge(
    state: ConversationState,
    *,
    schema: type[BaseModel],
    all_slots: tuple[str, ...],
    required: tuple[str, ...],
    prior: dict,
    complete_flag: str,
    extraction_hint: str,
) -> dict:
    """Extract slots from the conversation and merge into `prior` (non-destructive).

    Sets `merged[complete_flag] = True` only when every required slot is filled.
    """
    extractor = get_chat_model(temperature=0.0).with_structured_output(schema)
    system = SystemMessage(
        content=(
            f"{extraction_hint} "
            "Only fill a field if the user actually provided it; otherwise leave it null."
        )
    )
    extracted: BaseModel = extractor.invoke([system, *state["messages"]])  # type: ignore[assignment]

    merged = dict(prior)
    for slot in all_slots:
        new_val = getattr(extracted, slot)
        if new_val:  # only overwrite when the model actually found something
            merged[slot] = new_val
    merged[complete_flag] = all(merged.get(s) for s in required)
    return merged


def _slot_fill_reply(
    state: ConversationState,
    *,
    info: dict,
    all_slots: tuple[str, ...],
    required: tuple[str, ...],
    ask_intro: str,
    done_intro: str,
) -> AIMessage:
    """Ask for the next missing required slot, or confirm once all are present."""
    missing = [s for s in required if not info.get(s)]
    known = {k: v for k, v in info.items() if k in all_slots and v}

    if missing:
        instructions = (
            f"{ask_intro} Details captured so far: {known or 'none'}. Still needed: {missing}. "
            "Warmly ask for the SINGLE most important missing item (ask one thing at a time). "
            "Acknowledge anything they just shared. IMPORTANT: do NOT say the request is "
            "booked, confirmed, or being handled until EVERY required detail above is present."
        )
    else:
        instructions = f"{done_intro} Details on file: {known}."
    return _reply(state, instructions)


# ---- Lead qualification ----

REQUIRED_LEAD_SLOTS = ("need", "timeline", "contact")
ALL_LEAD_SLOTS = ("name", "need", "timeline", "budget", "contact")


class LeadExtraction(BaseModel):
    """What the model pulls from the conversation so far. None = not yet stated."""

    name: Optional[str] = Field(None, description="The prospect's name, if stated.")
    need: Optional[str] = Field(
        None, description="The dental concern or treatment they want (e.g. cleaning, implant, pain)."
    )
    timeline: Optional[str] = Field(
        None, description="How soon they want care (e.g. this week, next month, ASAP)."
    )
    budget: Optional[str] = Field(
        None, description="Any budget figure or dental insurance they mention."
    )
    contact: Optional[str] = Field(
        None, description="A phone number or email to follow up on."
    )


def qualify(state: ConversationState) -> dict:
    """Progressively qualify a lead: extract slots, then ask for the next gap.

    Stateful across turns via the checkpointer, so a lead who answers one question
    per message is fully captured without us re-asking what we already know.
    """
    lead: LeadInfo = _extract_and_merge(  # type: ignore[assignment]
        state,
        schema=LeadExtraction,
        all_slots=ALL_LEAD_SLOTS,
        required=REQUIRED_LEAD_SLOTS,
        prior=state.get("lead_info") or {},
        complete_flag="qualified",
        extraction_hint="Extract lead-qualification details from the conversation for a dental clinic.",
    )
    ai = _slot_fill_reply(
        state,
        info=lead,
        all_slots=ALL_LEAD_SLOTS,
        required=REQUIRED_LEAD_SLOTS,
        ask_intro="This is a prospective patient (a new lead).",
        done_intro=(
            "This lead is now fully qualified. Thank them, briefly recap what you noted, and "
            "let them know a team member will reach out to confirm next steps."
        ),
    )
    return {"lead_info": lead, "messages": [ai]}


# ---- Other intent handlers ----

def respond(state: ConversationState) -> dict:
    """Existing customer: general helpful answer (RAG grounding arrives in Step 3)."""
    ai = _reply(
        state,
        "This is an existing patient. Answer helpfully. If it needs their records or "
        "exact policy details you don't have, offer to have the team follow up.",
    )
    return {"messages": [ai]}


REQUIRED_BOOKING_SLOTS = ("name", "preferred_time", "contact")
ALL_BOOKING_SLOTS = ("name", "preferred_time", "contact")


class BookingExtraction(BaseModel):
    """Appointment-request details pulled from the conversation. None = not stated."""

    name: Optional[str] = Field(None, description="The patient's name for the appointment.")
    preferred_time: Optional[str] = Field(
        None, description="Requested day and/or time, e.g. 'Saturday 3pm', 'next Tuesday morning'."
    )
    contact: Optional[str] = Field(
        None, description="A phone number or email to confirm the appointment on."
    )


def handle_booking(state: ConversationState) -> dict:
    """Booking request: collect name + preferred time + contact before confirming.

    Same slot-filling engine as `qualify`, so it can't claim a slot is confirmed
    until every required detail (crucially, the name) has been gathered. Real
    calendar scheduling arrives in Step 4.
    """
    booking: BookingInfo = _extract_and_merge(  # type: ignore[assignment]
        state,
        schema=BookingExtraction,
        all_slots=ALL_BOOKING_SLOTS,
        required=REQUIRED_BOOKING_SLOTS,
        prior=state.get("booking_info") or {},
        complete_flag="ready",
        extraction_hint="Extract appointment-booking details from the conversation for a dental clinic.",
    )
    ai = _slot_fill_reply(
        state,
        info=booking,
        all_slots=ALL_BOOKING_SLOTS,
        required=REQUIRED_BOOKING_SLOTS,
        ask_intro=(
            "This is an appointment booking request. You cannot see the live calendar yet, so you "
            "are only gathering the request details (real scheduling comes later)."
        ),
        done_intro=(
            "You now have all booking details. Recap the name, requested day/time and contact, and "
            "say you'll confirm the exact slot shortly. Make clear it's a REQUESTED slot, not yet confirmed."
        ),
    )
    return {"booking_info": booking, "messages": [ai]}


def handle_complaint(state: ConversationState) -> dict:
    """Complaint: empathise, reassure — and flag for a human to pick up (Step 6 dashboard)."""
    ai = _reply(
        state,
        "This is a complaint. Be genuinely empathetic, apologise, and assure them a team "
        "member will personally follow up shortly. Do not make promises about compensation.",
    )
    return {"messages": [ai], "needs_human": True}


def handle_spam(state: ConversationState) -> dict:
    """Spam: keep it short and polite; don't engage the content."""
    ai = _reply(
        state,
        "This message looks like spam or is unrelated to the clinic. Reply with a brief, "
        "polite note that you can only help with dental enquiries.",
        temperature=0.2,
    )
    return {"messages": [ai]}

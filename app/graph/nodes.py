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

import logging
from datetime import datetime
from typing import Optional
from zoneinfo import ZoneInfo

from langchain_core.messages import AIMessage, SystemMessage
from langgraph.types import interrupt
from pydantic import BaseModel, Field

from app.booking import clinic_tz, format_slot, parse_requested_time, reserve_slot, try_book
from app.calendar import get_calendar
from app.graph.state import BookingInfo, ConversationState, Intent, LeadInfo
from app.llm import get_chat_model
from app.rag import retrieve

logger = logging.getLogger("replyo.nodes")

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
            "new_lead: a prospective patient expressing interest in becoming a patient or wanting treatment. "
            "question: a factual question about the clinic answerable from its documents "
            "(prices, services offered, insurance/policies, opening hours, location). "
            "existing_customer: a current patient asking about THEIR OWN records, appointment, or account. "
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


def _apply_confirmation(state: ConversationState, booking: dict, result: dict) -> AIMessage:
    """Record a confirmed slot on `booking` and craft the reply.

    If this is the tail of a reschedule (a `reschedule_from_event_id` marker is set),
    release the old event so the patient isn't left double-booked, and phrase the reply
    as a move rather than a fresh booking.
    """
    new_event = result["event_id"]
    old_event = booking.pop("reschedule_from_event_id", None)
    booking["status"] = "confirmed"
    booking["confirmed_time"] = format_slot(result["start"])
    booking["confirmed_iso"] = result["start"].isoformat()
    booking["event_id"] = new_event
    booking.pop("alternatives", None)
    booking.pop("alternatives_iso", None)

    moved = bool(old_event) and old_event != new_event
    if moved:
        try:
            get_calendar().cancel_event(old_event)
        except Exception:  # best-effort: a stale old event shouldn't fail the rebooking
            logger.exception("Failed to cancel old event %s during reschedule", old_event)

    name = booking.get("name")
    if moved:
        instructions = (
            f"Their appointment has been MOVED to {booking['confirmed_time']} under {name}; the "
            "previous time has been released. Confirm the change warmly and say they'll get a "
            "reminder. Do NOT ask for their name or contact — you already have them."
        )
    else:
        instructions = (
            f"Their appointment is CONFIRMED for {booking['confirmed_time']} under {name}. "
            "Confirm it warmly and say they'll get a reminder."
        )
    return _reply(state, instructions)


def _offer_alternatives(state: ConversationState, booking: dict, result: dict) -> AIMessage:
    """Record the offered alternatives on a conflict and ask the patient to pick one."""
    alts = [format_slot(s) for s in result["alternatives"]]
    booking["status"] = "conflict"
    booking["alternatives"] = alts
    booking["alternatives_iso"] = [s.isoformat() for s in result["alternatives"]]
    offered = "; ".join(alts) if alts else "no nearby slots"
    return _reply(
        state,
        f"The requested time ({format_slot(result['requested'])}) is already taken. Apologise "
        f"briefly and offer these available slots: {offered}. Ask them to pick one. Do NOT ask "
        "for their name or contact — you already have them.",
    )


def _confirmed_ack_reply(state: ConversationState, booking: dict) -> AIMessage:
    """Reply when a patient with a confirmed booking writes but proposes no new time."""
    return _reply(
        state,
        f"They already have a CONFIRMED appointment for {booking.get('confirmed_time')} under "
        f"{booking.get('name')} (contact on file: {booking.get('contact')}). Acknowledge warmly. "
        "If they want to change it, ask for the specific new day and time they'd like; if they want "
        "to cancel, tell them our team will take care of it. Do NOT ask for their name or contact "
        "again, and NEVER claim you can't see previous messages or that you'll 'check and get back'.",
    )


def _reschedule_target(
    state: ConversationState, booking: dict, *, now: datetime, tz: ZoneInfo
) -> Optional[datetime]:
    """If the latest message asks to move the booking to a concrete new time, return it.

    Returns None when the message proposes no specific new time (or restates the current
    one) — the caller then just acknowledges instead of rebooking. The current
    appointment's day anchors a time-only request like "change it to 4pm" (the parser
    needs a day, which the message alone doesn't carry).
    """
    current = booking.get("confirmed_time") or "their current appointment"
    latest = _latest_user_text(state)
    context = (
        f"The patient already has a CONFIRMED dental appointment on {current}. They just sent "
        f"this message: {latest!r}. If they are asking to move/reschedule to a specific new time, "
        "extract that NEW day and time; if they give a new time but not a new day, use the SAME "
        "DAY as the current appointment. If they are NOT proposing a specific new time (just "
        "acknowledging, thanking, or asking something else), set understood=false."
    )
    parsed = parse_requested_time(context, now=now, tz=tz)
    if not parsed.understood or not parsed.start_iso:
        return None
    target = datetime.fromisoformat(parsed.start_iso)
    if target.tzinfo is None:
        target = target.replace(tzinfo=tz)
    # Restating the same slot isn't a change.
    if booking.get("confirmed_iso") and datetime.fromisoformat(booking["confirmed_iso"]) == target:
        return None
    return target


def handle_booking(state: ConversationState) -> dict:
    """Book, reschedule, or keep collecting details for an appointment.

    - collecting: slot-fill name + preferred_time + contact (can't book until all present).
    - ready: parse the time, check the calendar, then confirm or offer alternatives on a conflict.
    - already confirmed: treat a concrete new time as a RESCHEDULE (rebook + release the old
      slot); otherwise just acknowledge — reusing the name/contact already on file so we never
      re-ask or pretend we can't see the history.

    On a conflict the patient's next message (their pick) re-enters here and re-books; if a
    reschedule hit a conflict, the pending old-event marker rides along so the pick still
    releases the original slot.
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

    tz = clinic_tz()
    now = datetime.now(tz)

    # Already booked -> reschedule (a concrete new time) or simply acknowledge.
    if booking.get("status") == "confirmed":
        target = _reschedule_target(state, booking, now=now, tz=tz)
        if target is None:
            return {"booking_info": booking, "messages": [_confirmed_ack_reply(state, booking)]}
        booking["reschedule_from_event_id"] = booking.get("event_id")
        result = reserve_slot(booking, get_calendar(), target, now=now, tz=tz)
        if result["status"] == "confirmed":
            ai = _apply_confirmation(state, booking, result)
        elif result["status"] == "conflict":
            ai = _offer_alternatives(state, booking, result)
        else:  # couldn't place the new time -> keep the existing booking, just acknowledge
            booking.pop("reschedule_from_event_id", None)
            ai = _confirmed_ack_reply(state, booking)
        return {"booking_info": booking, "messages": [ai]}

    # Phase 1: still missing a required slot -> keep collecting.
    if not booking.get("ready"):
        booking["status"] = "collecting"
        ai = _slot_fill_reply(
            state,
            info=booking,
            all_slots=ALL_BOOKING_SLOTS,
            required=REQUIRED_BOOKING_SLOTS,
            ask_intro="This is an appointment booking request; gather the details needed to book.",
            done_intro="You now have all booking details.",  # unused: ready path handled below
        )
        return {"booking_info": booking, "messages": [ai]}

    # Phase 2: ready -> attempt to reserve. Feed the parser the accumulated requested
    # time plus the latest message so it can also resolve a conflict-pick like "the
    # first option". try_book resolves the parser from app.booking at call time (test hook).
    time_text = (
        f"Requested time: {booking.get('preferred_time') or 'unspecified'}. "
        f"Latest message: {_latest_user_text(state)}"
    )
    result = try_book(booking, get_calendar(), time_text)

    if result["status"] == "confirmed":
        ai = _apply_confirmation(state, booking, result)
    elif result["status"] == "conflict":
        ai = _offer_alternatives(state, booking, result)
    else:  # need_time
        booking["status"] = "collecting"
        ai = _reply(
            state,
            "You couldn't work out a concrete appointment time from their message. Politely ask "
            "them to give a specific day and time within opening hours (Mon–Sat 9:30am–8pm, Sun 10am–2pm).",
        )

    return {"booking_info": booking, "messages": [ai]}


class ComplaintReplies(BaseModel):
    """Two replies for a complaint, produced in one pass."""

    acknowledgement: str = Field(
        description=(
            "The message sent to the customer IMMEDIATELY (1–2 sentences). FIRST sincerely "
            "apologise for their specific concern, THEN let them know you're looping in a team "
            "member who will personally follow up shortly. Warm and human. Do NOT promise any "
            "refund, compensation, or specific remedy."
        )
    )
    suggested_reply: str = Field(
        description=(
            "A fuller, ready-to-send draft that a human teammate will review before it goes out. "
            "Empathetic and professional; directly address their specific concern and propose a "
            "concrete, reasonable next step (e.g. look into what happened, arrange a callback, "
            "invite them back). Do NOT promise compensation or admit legal fault."
        )
    )


def handle_complaint(state: ConversationState) -> dict:
    """Complaint: apologise now, and draft a suggested reply for a human to approve.

    Produces two things in one LLM call:
      - `holding_message`: an apologetic acknowledgement sent to the customer immediately
        (surfaced by run_turn) — NOT a resolution, just "we hear you, someone's on it".
      - `review_draft`: a substantive suggested reply that the human_review node holds for
        approval. We do NOT append it to `messages` — it must not reach the customer until a
        human approves it.
    """
    model = get_chat_model(temperature=0.4).with_structured_output(ComplaintReplies)
    system = SystemMessage(
        content=(
            f"{PERSONA}\n\nThe latest message is a complaint from a patient. Draft the two "
            "replies described by the schema. Be genuinely empathetic; never blame the patient."
        )
    )
    replies: ComplaintReplies = model.invoke([system, *state["messages"]])  # type: ignore[assignment]
    return {
        "holding_message": replies.acknowledgement,
        "review_draft": replies.suggested_reply,
        "review_reason": "Upset customer (complaint)",
        "needs_human": True,
    }


def human_review(state: ConversationState) -> dict:
    """Pause for human approval, then finalise the reply based on their decision.

    `interrupt()` suspends the graph here; the whole state is checkpointed to
    Postgres. The dashboard resumes it with Command(resume={"action", "text"}):
      approve -> send the AI draft as-is
      edit    -> send the human's edited text
      reject  -> send a safe fallback (or the human's replacement text)
    Only after resume do we append the final message to `messages`.
    """
    conversation = [
        {"role": m.type, "content": m.content}
        for m in state["messages"]
        if getattr(m, "type", None) in ("human", "ai")
    ]
    # Show the reviewer the apologetic acknowledgement the customer already received,
    # so the suggested-reply box is clearly the NEXT message to send, not a repeat.
    holding = state.get("holding_message")
    if holding:
        conversation.append({"role": "ai", "content": holding})
    decision = interrupt(
        {
            "reason": state.get("review_reason", "Needs human review"),
            "draft": state.get("review_draft", ""),
            "conversation": conversation,
        }
    )

    draft = state.get("review_draft", "")
    action = (decision or {}).get("action", "approve")
    if action == "edit":
        final = (decision or {}).get("text") or draft
    elif action == "reject":
        final = (decision or {}).get("text") or (
            "Thank you for your patience — one of our team members will personally reach out to you shortly."
        )
    else:  # approve
        final = draft

    return {"messages": [AIMessage(content=final)], "needs_human": True}


def handle_spam(state: ConversationState) -> dict:
    """Spam: keep it short and polite; don't engage the content."""
    ai = _reply(
        state,
        "This message looks like spam or is unrelated to the clinic. Reply with a brief, "
        "polite note that you can only help with dental enquiries.",
        temperature=0.2,
    )
    return {"messages": [ai]}


# ---- RAG: answer factual questions from the clinic's documents (Step 3) ----

RETRIEVAL_K = 4
# Cosine distance cut-off (lower = more similar). This is a coarse PRE-FILTER, not
# the main safety net: it only drops clearly-unrelated queries (car engine ~0.80,
# weather ~0.85) so we don't waste an LLM call on them. The real anti-hallucination
# guard is the grounding prompt below, which declines when the specific answer
# isn't in the retrieved text.
# Tuned against the actual data (scripts/smoke_chat.py + the distance probe): real
# in-domain questions land ~0.43–0.73 (e.g. "where are you located?" ≈ 0.73), so
# anything below ~0.5 caused false refusals. 0.76 clears every legit question while
# still filtering the 0.80+ off-topic ones.
MAX_DISTANCE = 0.76

REFUSAL = (
    "I'm not certain about that from the information I have on hand, and I don't want to "
    "give you anything inaccurate. Let me have a team member confirm and get back to you — "
    "what's the best number or email to reach you on?"
)


def _latest_user_text(state: ConversationState) -> str:
    for msg in reversed(state["messages"]):
        if getattr(msg, "type", None) == "human":
            return msg.content
    return ""


def answer_from_docs(state: ConversationState) -> dict:
    """Retrieve relevant chunks and answer ONLY from them, with citations.

    Two guardrails against hallucination:
      1. Relevance gate — if nothing retrieved is within MAX_DISTANCE, we refuse
         outright and never even ask the model to answer.
      2. Grounding prompt — the model is told to answer strictly from the supplied
         context and to say it doesn't know rather than invent prices/policies.
    """
    query = _latest_user_text(state)
    hits = retrieve(query, k=RETRIEVAL_K)
    relevant = [(doc, dist) for doc, dist in hits if dist <= MAX_DISTANCE]

    # Guard 1: nothing relevant -> refuse, don't hallucinate.
    if not relevant:
        return {"messages": [AIMessage(content=REFUSAL)], "citations": []}

    # Build a numbered context block and the ordered, de-duped source list.
    sources: list[str] = []
    context_parts = []
    for i, (doc, _dist) in enumerate(relevant, start=1):
        src = doc.metadata.get("source", "unknown")
        if src not in sources:
            sources.append(src)
        context_parts.append(f"[{i}] (source: {src})\n{doc.page_content}")
    context = "\n\n".join(context_parts)

    # Guard 2: grounding instructions.
    instructions = (
        "Answer the patient's question USING ONLY the context below. If the answer is not "
        "clearly in the context, say you don't have that information on hand and offer to "
        "have the team follow up — do NOT guess or invent prices, policies, or availability. "
        "Cite the sources you used inline like [1], [2]. Keep it concise.\n\n"
        f"Context:\n{context}"
    )
    ai = _reply(state, instructions, temperature=0.1)

    # Append a human-friendly Sources footer so it shows in any channel.
    reply = f"{ai.content}\n\nSources: {', '.join(sources)}"
    return {"messages": [AIMessage(content=reply)], "citations": sources}

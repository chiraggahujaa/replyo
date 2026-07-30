"""Graph nodes.

Intent-specific handlers, one per triage bucket:

  triage            -> classify the latest inbound message
  qualify           -> (new_lead) slot-fill need/timeline/contact across turns
  respond           -> (existing_customer) general answer
  handle_booking    -> (booking_request) book / reschedule on the calendar
  answer_from_docs  -> (question) RAG over THIS persona's documents, with citations
  handle_complaint  -> (complaint) apologise now + draft a reply for human approval
  handle_spam       -> (spam) polite, minimal deflection

Multi-tenant note: a node that talks to the customer or retrieves knowledge reads the
active persona from `config["configurable"]["tenant"]` — the persona's system prompt and
its pgvector collection. It comes via `config`, NOT graph state, on purpose: state is
checkpointed per thread, so a persona stored there would freeze at whatever it was on the
first message; config is rebuilt every turn (see app/graph/build.py). Nodes that need it
take `(state, config)`; the rest stay `(state)`.
"""

from __future__ import annotations

import logging
from datetime import datetime
from zoneinfo import ZoneInfo

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_core.runnables import RunnableConfig
from langgraph.types import interrupt
from pydantic import BaseModel, Field

from app import catalog
from app.booking import format_slot, parse_requested_time, reserve_slot, tenant_tz, try_book
from app.calendar import get_calendar
from app.graph.state import BookingInfo, ConversationState, Intent, LeadInfo
from app.llm import get_chat_model
from app.rag import retrieve
from app.tenancy import DEMO_TENANT_ID

logger = logging.getLogger("replyo.nodes")

# Fallback persona when a turn runs without a configured tenant (offline tests, and a
# belt-and-braces default). Real traffic always carries the tenant's own system prompt.
PERSONA = (
    "You are a warm, concise, professional front-desk assistant for a business. "
    "Answer only from the information you are given; do not invent specifics. If you are "
    "unsure, say you'll confirm and offer to take the person's details. Keep replies short."
)


# Marks the ONE kind of LLM call whose tokens may be streamed to a customer.
#
# This matters more than it looks. Every node also makes structured-output calls
# (triage, slot extraction, and the complaint handler), and those stream their raw
# JSON as content. Streaming indiscriminately would send a customer `{"intent":...}`
# — and, far worse, the complaint handler's JSON contains `suggested_reply`, the
# draft that is supposed to be withheld pending human approval. Tagging the single
# customer-facing helper means the websocket can allow-list by tag and structured
# output can never leak. See `REPLY_TAG` use in app/graph/build.py.
REPLY_TAG = "customer_reply"


# ---- Active persona, read from the invocation config ----

def _tenant(config: RunnableConfig | None) -> dict:
    return ((config or {}).get("configurable") or {}).get("tenant") or {}


def _system_prompt(config: RunnableConfig | None) -> str:
    """This persona's generated instruction (or the generic fallback), plus the curated
    business guidelines when the catalog pipeline has produced any — the
    `guidelines_block` is attached to the tenant dict per turn by app/inbound.py."""
    tenant = _tenant(config)
    prompt = tenant.get("system_prompt") or PERSONA
    guidelines = tenant.get("guidelines_block")
    return f"{prompt}\n\n{guidelines}" if guidelines else prompt


def _tenant_id(config: RunnableConfig | None) -> str:
    """Whose knowledge collection to retrieve from."""
    return _tenant(config).get("id") or DEMO_TENANT_ID


def _reply(
    state: ConversationState, instructions: str, *, config: RunnableConfig | None,
    temperature: float = 0.4,
) -> AIMessage:
    """Shared helper: prepend the persona's system prompt and ask for one reply.

    Every customer-facing sentence goes through here — that's what makes REPLY_TAG a
    reliable streaming allow-list, and what makes the persona swap a one-line change.
    """
    model = get_chat_model(temperature=temperature).with_config(tags=[REPLY_TAG])
    system = SystemMessage(content=f"{_system_prompt(config)}\n\n{instructions}")
    return model.invoke([system, *_history_for_model(state["messages"])])  # type: ignore[return-value]


def _text_of(content) -> str:
    """A message's content as plain text, whether it's a string or content blocks.

    Image turns arrive as [{"type": "text", ...}, {"type": "image_url", ...}] (see
    run_turn). Anywhere a node embeds content in a PROMPT STRING or a plain-text
    transcript, an image block must collapse to a short marker — never a megabyte
    of base64. Message objects handed whole to the model are NOT flattened; the
    model reads the blocks natively.
    """
    if isinstance(content, str):
        return content
    parts = []
    for block in content:
        if isinstance(block, str):
            parts.append(block)
        elif isinstance(block, dict) and block.get("type") == "text":
            parts.append(block.get("text") or "")
        elif isinstance(block, dict) and block.get("type") == "image_url":
            parts.append("[image attached]")
    return "\n".join(p for p in parts if p)


def _history_for_model(messages: list) -> list:
    """The history a model call may ship to the provider: images ride the LATEST turn only.

    The checkpointer keeps every multimodal turn verbatim, and every node call sends
    the whole history — so unflattened, each past image is RE-uploaded on every later
    turn, and a thread's vision cost grows O(N^2) (an unauthenticated caller can run
    that bill up deliberately). Earlier block-list messages therefore collapse to
    their _text_of() text; the model already read those pixels on the turn they
    arrived. The latest message keeps its content untouched so the current turn's
    images reach the model. Cost then grows with images-per-turn, not thread length.
    State's message objects are never mutated: flattened turns are fresh same-role
    copies, everything else passes through by reference — what the checkpointer
    stores is unchanged, only what leaves for the provider.
    """
    if not messages:
        return []
    out: list = []
    for m in messages[:-1]:
        if isinstance(getattr(m, "content", None), list) and m.type in ("human", "ai"):
            cls = HumanMessage if m.type == "human" else AIMessage
            out.append(cls(content=_text_of(m.content)))
        else:
            out.append(m)
    out.append(messages[-1])
    return out


# ---- Triage ----

class TriageResult(BaseModel):
    """Structured output schema the model is forced to fill."""

    intent: Intent = Field(
        description=(
            "Classification of the latest user message. "
            "new_lead: a prospective customer expressing interest or wanting a service. "
            "question: a factual question answerable from the business's documents "
            "(prices, services, policies, hours, location). "
            "existing_customer: a current customer asking about THEIR OWN records, appointment, or account. "
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
            "You are a triage classifier for a business's inbound messages. "
            "Read the conversation and classify the latest user message."
        )
    )
    result: TriageResult = model.invoke([system, *_history_for_model(state["messages"])])  # type: ignore[assignment]
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
    extracted: BaseModel = extractor.invoke([system, *_history_for_model(state["messages"])])  # type: ignore[assignment]

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
    config: RunnableConfig | None,
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
    return _reply(state, instructions, config=config)


# ---- Lead qualification ----

REQUIRED_LEAD_SLOTS = ("need", "timeline", "contact")
ALL_LEAD_SLOTS = ("name", "need", "timeline", "budget", "contact")


class LeadExtraction(BaseModel):
    """What the model pulls from the conversation so far. None = not yet stated."""

    name: str | None = Field(None, description="The prospect's name, if stated.")
    need: str | None = Field(
        None, description="The concern or service they want (e.g. cleaning, a quote, support)."
    )
    timeline: str | None = Field(
        None, description="How soon they want it (e.g. this week, next month, ASAP)."
    )
    budget: str | None = Field(
        None, description="Any budget figure or insurance/plan they mention."
    )
    contact: str | None = Field(
        None, description="A phone number or email to follow up on."
    )


def qualify(state: ConversationState, config: RunnableConfig) -> dict:
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
        extraction_hint="Extract lead-qualification details from the conversation for a business.",
    )
    ai = _slot_fill_reply(
        state,
        config=config,
        info=lead,
        all_slots=ALL_LEAD_SLOTS,
        required=REQUIRED_LEAD_SLOTS,
        ask_intro="This is a prospective customer (a new lead).",
        done_intro=(
            "This lead is now fully qualified. Thank them, briefly recap what you noted, and "
            "let them know a team member will reach out to confirm next steps."
        ),
    )
    return {"lead_info": lead, "messages": [ai]}


# ---- Other intent handlers ----

def respond(state: ConversationState, config: RunnableConfig) -> dict:
    """Existing customer: general helpful answer."""
    ai = _reply(
        state,
        "This is an existing customer. Answer helpfully. If it needs their records or "
        "exact details you don't have, offer to have the team follow up.",
        config=config,
    )
    return {"messages": [ai]}


REQUIRED_BOOKING_SLOTS = ("name", "preferred_time", "contact")
ALL_BOOKING_SLOTS = ("name", "preferred_time", "contact")


class BookingExtraction(BaseModel):
    """Appointment-request details pulled from the conversation. None = not stated."""

    name: str | None = Field(None, description="The customer's name for the appointment.")
    preferred_time: str | None = Field(
        None, description="Requested day and/or time, e.g. 'Saturday 3pm', 'next Tuesday morning'."
    )
    contact: str | None = Field(
        None, description="A phone number or email to confirm the appointment on."
    )


def _apply_confirmation(
    state: ConversationState, booking: dict, result: dict, config: RunnableConfig | None
) -> AIMessage:
    """Record a confirmed slot on `booking` and craft the reply.

    If this is the tail of a reschedule (a `reschedule_from_event_id` marker is set),
    release the old event so the customer isn't left double-booked, and phrase the reply
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
    return _reply(state, instructions, config=config)


def _offer_alternatives(
    state: ConversationState, booking: dict, result: dict, config: RunnableConfig | None
) -> AIMessage:
    """Record the offered alternatives on a conflict and ask the customer to pick one."""
    alts = [format_slot(s) for s in result["alternatives"]]
    booking["status"] = "conflict"
    booking["alternatives"] = alts
    booking["alternatives_iso"] = [s.isoformat() for s in result["alternatives"]]
    offered = "; ".join(alts) if alts else "no nearby slots"
    return _reply(
        state,
        f"Their preferred time isn't available. Apologise briefly that you couldn't get them in then "
        f"and offer these available times: {offered}. Ask them to pick one. IMPORTANT: do NOT state "
        "or invent a specific clock time as 'taken' unless the customer explicitly named that exact "
        "time — when they only gave a vague window (e.g. 'morning'), just present the options. Do NOT "
        "ask for their name or contact — you already have them.",
        config=config,
    )


def _confirmed_ack_reply(
    state: ConversationState, booking: dict, config: RunnableConfig | None
) -> AIMessage:
    """Reply when a customer with a confirmed booking writes but proposes no new time."""
    return _reply(
        state,
        f"They already have a CONFIRMED appointment for {booking.get('confirmed_time')} under "
        f"{booking.get('name')} (contact on file: {booking.get('contact')}). Acknowledge warmly. "
        "If they want to change it, ask for the specific new day and time they'd like; if they want "
        "to cancel, tell them our team will take care of it. Do NOT ask for their name or contact "
        "again, and NEVER claim you can't see previous messages or that you'll 'check and get back'.",
        config=config,
    )


def _reschedule_target(
    state: ConversationState, booking: dict, *, now: datetime, tz: ZoneInfo
) -> datetime | None:
    """If the latest message asks to move the booking to a concrete new time, return it.

    Returns None when the message proposes no specific new time (or restates the current
    one) — the caller then just acknowledges instead of rebooking. The current
    appointment's day anchors a time-only request like "change it to 4pm" (the parser
    needs a day, which the message alone doesn't carry).
    """
    current = booking.get("confirmed_time") or "their current appointment"
    latest = _latest_user_text(state)
    context = (
        f"The customer already has a CONFIRMED appointment on {current}. They just sent "
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


def handle_booking(state: ConversationState, config: RunnableConfig) -> dict:
    """Book, reschedule, or keep collecting details for an appointment.

    - collecting: slot-fill name + preferred_time + contact (can't book until all present).
    - ready: parse the time, check the calendar, then confirm or offer alternatives on a conflict.
    - already confirmed: treat a concrete new time as a RESCHEDULE (rebook + release the old
      slot); otherwise just acknowledge — reusing the name/contact already on file so we never
      re-ask or pretend we can't see the history.

    On a conflict the customer's next message (their pick) re-enters here and re-books; if a
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
        extraction_hint="Extract appointment-booking details from the conversation for a business.",
    )

    # Book on THIS persona's calendar shape, not the deployment default: its timezone
    # (tenants.timezone) and its curated hours/slot settings (business_profiles, loaded
    # onto the tenant dict per turn by app/inbound.py). All three fall back to the
    # app/booking.py constants when the persona has nothing curated yet.
    tenant = _tenant(config)
    profile = tenant.get("profile")
    tz = tenant_tz(tenant)
    now = datetime.now(tz)
    hours = catalog.hours_from_profile(profile)
    slot, buffer = catalog.booking_settings(profile)

    # Already booked -> reschedule (a concrete new time) or simply acknowledge.
    if booking.get("status") == "confirmed":
        target = _reschedule_target(state, booking, now=now, tz=tz)
        if target is None:
            return {"booking_info": booking, "messages": [_confirmed_ack_reply(state, booking, config)]}
        booking["reschedule_from_event_id"] = booking.get("event_id")
        result = reserve_slot(
            booking, get_calendar(), target, now=now, tz=tz,
            hours=hours, slot=slot, buffer=buffer,
        )
        if result["status"] == "confirmed":
            ai = _apply_confirmation(state, booking, result, config)
        elif result["status"] == "conflict":
            ai = _offer_alternatives(state, booking, result, config)
        else:  # couldn't place the new time -> keep the existing booking, just acknowledge
            booking.pop("reschedule_from_event_id", None)
            ai = _confirmed_ack_reply(state, booking, config)
        return {"booking_info": booking, "messages": [ai]}

    # Phase 1: still missing a required slot -> keep collecting.
    if not booking.get("ready"):
        booking["status"] = "collecting"
        ai = _slot_fill_reply(
            state,
            config=config,
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
    result = try_book(
        booking, get_calendar(), time_text, tz=tz, hours=hours, slot=slot, buffer=buffer
    )

    if result["status"] == "confirmed":
        ai = _apply_confirmation(state, booking, result, config)
    elif result["status"] == "conflict":
        ai = _offer_alternatives(state, booking, result, config)
    else:  # need_time
        booking["status"] = "collecting"
        # Quote the persona's OWN hours when it has curated any — telling a spa's
        # customer the dental default would be worse than saying nothing.
        hours_text = catalog.format_hours_text(hours) or "Mon–Sat 9:30am–8pm, Sun 10am–2pm"
        ai = _reply(
            state,
            "You couldn't work out a concrete appointment time from their message. Politely ask "
            f"them to give a specific day and time within opening hours ({hours_text}).",
            config=config,
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


def handle_complaint(state: ConversationState, config: RunnableConfig) -> dict:
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
            f"{_system_prompt(config)}\n\nThe latest message is a complaint from a customer. Draft "
            "the two replies described by the schema. Be genuinely empathetic; never blame the customer."
        )
    )
    replies: ComplaintReplies = model.invoke([system, *_history_for_model(state["messages"])])  # type: ignore[assignment]
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
    # _text_of: the review queue stores and renders plain-text transcripts, so a
    # multimodal turn shows its text plus an "[image attached]" marker.
    conversation = [
        {"role": m.type, "content": _text_of(m.content)}
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


def handle_spam(state: ConversationState, config: RunnableConfig) -> dict:
    """Spam: keep it short and polite; don't engage the content."""
    ai = _reply(
        state,
        "This message looks like spam or is unrelated to the business. Reply with a brief, "
        "polite note that you can only help with enquiries about the business.",
        config=config,
        temperature=0.2,
    )
    return {"messages": [ai]}


# ---- RAG: answer factual questions from THIS persona's documents ----

RETRIEVAL_K = 4
# Cosine distance cut-off (lower = more similar). This is a coarse PRE-FILTER, not
# the main safety net: it only drops clearly-unrelated queries so we don't waste an
# LLM call on them. The real anti-hallucination guard is the grounding prompt below,
# which declines when the specific answer isn't in the retrieved text.
MAX_DISTANCE = 0.76

REFUSAL = (
    "I'm not certain about that from the information I have on hand, and I don't want to "
    "give you anything inaccurate. Let me have a team member confirm and get back to you — "
    "what's the best number or email to reach you on?"
)


def _latest_user_text(state: ConversationState) -> str:
    for msg in reversed(state["messages"]):
        if getattr(msg, "type", None) == "human":
            return _text_of(msg.content)
    return ""


def _latest_turn_has_images(state: ConversationState) -> bool:
    """Whether the current turn carries image blocks (see run_turn's content shape)."""
    for msg in reversed(state["messages"]):
        if getattr(msg, "type", None) == "human":
            c = msg.content
            return isinstance(c, list) and any(
                isinstance(b, dict) and b.get("type") == "image_url" for b in c
            )
    return False


def answer_from_docs(state: ConversationState, config: RunnableConfig) -> dict:
    """Retrieve relevant chunks from this persona's collection and answer ONLY from them.

    Two guardrails against hallucination:
      1. Relevance gate — if nothing retrieved is within MAX_DISTANCE, we refuse
         outright and never even ask the model to answer.
      2. Grounding prompt — the model is told to answer strictly from the supplied
         context and to say it doesn't know rather than invent prices/policies.
    """
    query = _latest_user_text(state)
    # An image turn must reach the model even when retrieval comes back empty: the
    # answer may be IN the picture (a photo, a document, a product), which the
    # embedding of its "[image attached]" text marker can never match. The hard
    # refusal below therefore gates text-only turns exclusively.
    with_images = _latest_turn_has_images(state)
    # The owner-reviewed catalog (built by app/catalog.py, attached per turn by
    # app/inbound.py) is valid grounding on its own: when present it rides ahead of
    # the retrieved chunks AND bypasses the empty-retrieval refusal below.
    catalog_block = _tenant(config).get("catalog_block")
    hits = retrieve(query, tenant_id=_tenant_id(config), k=RETRIEVAL_K)
    relevant = [(doc, dist) for doc, dist in hits if dist <= MAX_DISTANCE]

    # Guard 1: nothing relevant (and no catalog to answer from) -> refuse, don't hallucinate.
    if not relevant and not with_images and not catalog_block:
        return {"messages": [AIMessage(content=REFUSAL)], "citations": []}

    # Build a numbered context block and the ordered, de-duped source list.
    sources: list[str] = []
    context_parts = []
    if catalog_block:
        sources.append("Business catalog")
        context_parts.append(catalog_block)
    for i, (doc, _dist) in enumerate(relevant, start=1):
        src = doc.metadata.get("source", "unknown")
        if src not in sources:
            sources.append(src)
        context_parts.append(f"[{i}] (source: {src})\n{doc.page_content}")
    context = "\n\n".join(context_parts)

    # Guard 2: grounding instructions. An image turn loosens the context-only rule
    # for what the picture shows (the model must actually look at it) but keeps it
    # for business facts — prices/policies still can't be invented off a photo.
    if with_images:
        instructions = (
            "The customer attached image(s) to this message — look at them and address "
            "what they show directly. For business facts (prices, services, policies, "
            "availability) use ONLY the context below; if the context doesn't cover what "
            "they need, say so and offer to have the team follow up — do NOT invent "
            "specifics. If asked to identify or make judgements about a person in a "
            "photo, explain you can't do that and help with what you can. "
            "Do not mention the context, sources, or citation numbers in your reply. "
            "Keep it concise."
            + (f"\n\nContext:\n{context}" if context else "")
        )
    else:
        instructions = (
            "Answer the customer's question USING ONLY the context below. If the answer is not "
            "clearly in the context, say you don't have that information on hand and offer to "
            "have the team follow up — do NOT guess or invent prices, policies, or availability. "
            "Do not mention the context, sources, or citation numbers in your reply. "
            "Keep it concise.\n\n"
            f"Context:\n{context}"
        )
    ai = _reply(state, instructions, config=config, temperature=0.1)

    # Sources are tracked as citations metadata but no longer shown in the reply text.
    return {"messages": [AIMessage(content=ai.content)], "citations": sources}

"""Graph nodes.

Step 1 has two nodes:

  triage   -> classify the latest inbound message into one of five buckets
  respond  -> generate an intent-aware, dental-clinic reply

Each node is a plain function `(state) -> partial_state`. LangGraph calls them in
order and merges what they return back into ConversationState.
"""

from __future__ import annotations

from langchain_core.messages import AIMessage, SystemMessage
from pydantic import BaseModel, Field

from app.graph.state import ConversationState, Intent
from app.llm import get_chat_model

# --- Business persona (Step 1 stub; RAG over real docs comes in Step 3) ---
CLINIC_NAME = "BrightSmile Dental"

RESPOND_SYSTEM_PROMPT = f"""You are the friendly front-desk assistant for {CLINIC_NAME}, a dental clinic.
You help patients and prospects over chat. Be warm, concise, and professional.

Guidelines:
- Do NOT invent specific prices, insurance coverage, or availability — this Step 1
  build has no access to the clinic's documents or calendar yet. If asked for
  exact figures or open slots, say you'll confirm and offer to take their details.
- For a new prospect, gently gather what they need (their concern, rough timeline).
- For a booking request, acknowledge and say a team member / the booking flow will
  confirm a slot.
- For a complaint, be empathetic and reassure them a human will follow up.
- Keep replies to a few sentences.
"""


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
    # Deterministic classification -> temperature 0.
    model = get_chat_model(temperature=0.0).with_structured_output(TriageResult)

    system = SystemMessage(
        content=(
            "You are a triage classifier for a dental clinic's inbound messages. "
            "Read the conversation and classify the latest user message."
        )
    )
    result: TriageResult = model.invoke([system, *state["messages"]])  # type: ignore[assignment]
    return {"intent": result.intent}


# ---- Respond ----

def respond(state: ConversationState) -> dict:
    """Generate a reply, aware of the triage intent."""
    model = get_chat_model(temperature=0.4)

    intent = state.get("intent")
    system = SystemMessage(
        content=f"{RESPOND_SYSTEM_PROMPT}\n\nTriage classified this message as: {intent}."
    )
    ai: AIMessage = model.invoke([system, *state["messages"]])  # type: ignore[assignment]
    return {"messages": [ai]}

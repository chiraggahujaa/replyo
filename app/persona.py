"""Generate a persona's system prompt from what the business told us.

The wizard collects a name, freeform notes, and knowledge (uploads + a crawled site).
This turns those into ONE comprehensive system prompt — the standing instruction the
assistant runs under. It is a *container*, not the facts: strict guardrails (answer only
from provided knowledge, never invent prices/policies, escalate complaints, stay in
character) plus this business's specifics. At runtime the prompt is combined with the
pgvector chunks retrieved per question — the prompt instructs, RAG supplies the facts.

One pass with the same model the assistant uses; the user reviews and edits the result,
so a perfect first draft isn't the bar.
"""

from __future__ import annotations

import logging
from typing import cast

from langchain_core.messages import HumanMessage, SystemMessage

from app.llm import get_chat_model
from app.rag import retrieve

logger = logging.getLogger("replyo.persona")

# Non-negotiable rules baked into every generated prompt, regardless of business.
GUARDRAILS = """Core rules (always apply):
- Answer ONLY from the business's provided knowledge. If something isn't in it, say you
  don't have that information and offer to have a team member follow up. NEVER invent
  prices, policies, availability, or facts.
- Be warm, concise and professional, and stay in character as this business's assistant.
- If someone is upset or complaining, be empathetic and let them know a team member will
  personally follow up — do not promise refunds or compensation.
- Keep replies short unless more detail is genuinely needed."""

_META_PROMPT = """You write system prompts for AI customer-service assistants.

Given a business's name, freeform notes, and a sample of its knowledge base, write a
single comprehensive system prompt that another AI will run under as that business's
front-desk assistant.

Requirements for the prompt you write:
- Open by stating who the assistant is (the business's assistant) and its purpose.
- Capture the business's specifics, tone, and any important details from the notes/sample.
- Incorporate the core rules provided verbatim in spirit (answer only from knowledge, no
  inventing facts, empathetic escalation, concise, in-character).
- Be self-contained and directly usable as a system prompt. Do NOT include commentary,
  markdown headers, or anything but the prompt text itself.
- Keep it focused — a few tight paragraphs, not a wall of text."""


async def _knowledge_sample(tenant_id: str, queries: list[str], per_query: int = 3) -> str:
    """Pull a few representative chunks so the prompt reflects real content, not guesses."""
    seen: set[str] = set()
    out: list[str] = []
    for q in queries:
        try:
            for doc, _dist in retrieve(q, tenant_id=tenant_id, k=per_query):
                snippet = doc.page_content.strip()
                key = snippet[:80]
                if key not in seen:
                    seen.add(key)
                    out.append(snippet)
        except Exception:
            # Collection may not exist yet if nothing has been ingested — that's fine.
            logger.debug("knowledge sample query failed for %s", tenant_id, exc_info=True)
    return "\n\n".join(out[:12])


async def generate_system_prompt(*, tenant_id: str, name: str, notes: str) -> str:
    """Synthesise the system prompt from the business name, notes, and ingested knowledge."""
    sample = await _knowledge_sample(
        tenant_id,
        ["prices and services", "hours and location", "policies and contact", "about the business"],
    )

    user = (
        f"Business name: {name}\n\n"
        f"Notes from the owner:\n{notes.strip() or '(none provided)'}\n\n"
        f"Sample of the knowledge base:\n{sample or '(nothing ingested yet)'}\n\n"
        f"Core rules to embed:\n{GUARDRAILS}\n\n"
        "Write the system prompt now."
    )
    model = get_chat_model(temperature=0.4)
    reply = model.invoke([SystemMessage(content=_META_PROMPT), HumanMessage(content=user)])
    # Text-only chat: content is always a str here (the list form is multimodal-only).
    return cast(str, reply.content).strip()

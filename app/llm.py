"""LLM factory.

One place to construct the chat model so we can swap providers/models later
without touching the graph nodes.
"""

from __future__ import annotations

from langchain_openai import ChatOpenAI

from app.config import settings


def get_chat_model(temperature: float = 0.3) -> ChatOpenAI:
    """Return a configured ChatOpenAI instance.

    temperature: 0.0 for deterministic classification (triage), a bit higher for
    natural-sounding replies.
    """
    return ChatOpenAI(
        model=settings.openai_model,
        api_key=settings.openai_api_key,
        temperature=temperature,
    )

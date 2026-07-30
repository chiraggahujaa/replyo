"""Business catalog — the read side: curated rows in, prompt blocks out.

app/extraction.py writes the structured catalog (services, products, guidelines,
facts); this module turns it back into text the agent can be grounded on. Two blocks,
built per turn by app/inbound.py and attached to the tenant dict:

  * catalog_block    — the authoritative price/service/fact sheet. answer_from_docs
                       prepends it to the retrieved context, and its presence bypasses
                       the empty-retrieval refusal: an owner-reviewed catalog is valid
                       grounding even when vector search finds nothing.
  * guidelines_block — customer-handling rules, appended to the persona's system
                       prompt so they apply to EVERY reply, not just RAG answers.

Why prompt text and not tool calls: the catalog is small (hard caps below), always
relevant to a front-desk conversation, and the whole point is that the model prefers
it over fuzzier retrieved chunks — inlining it ahead of the RAG context is the
simplest mechanism that achieves that priority. The builders are pure functions over
plain dicts so the formatting/truncation rules are offline-testable; only
load_business_context touches the database (one scoped connection per turn).

Caps are deliberate and silent: each description/body is clipped to 300 chars and the
blocks to 4000/2000 chars, overflow simply dropped. A catalog big enough to overflow
is better served by RAG anyway — the block is the headline sheet, not the archive.
"""

from __future__ import annotations

import logging
from typing import Any

from app.tenancy import scoped_connection

logger = logging.getLogger("replyo.catalog")

CATALOG_HEADER = (
    "OFFICIAL BUSINESS CATALOG (authoritative — prefer these prices and details over "
    "anything else):"
)
GUIDELINES_HEADER = "BUSINESS GUIDELINES (follow these when relevant):"

MAX_FIELD_CHARS = 300      # per description/body
MAX_CATALOG_CHARS = 4000   # whole catalog block
MAX_GUIDELINES_CHARS = 2000


def _clip(text: str) -> str:
    """A description/body capped at MAX_FIELD_CHARS (ellipsis marks the cut)."""
    text = text.strip()
    if len(text) <= MAX_FIELD_CHARS:
        return text
    return text[: MAX_FIELD_CHARS - 1].rstrip() + "…"


def _cap_lines(lines: list[str], limit: int) -> str:
    """Join lines with newlines, dropping whole lines once the cap would be crossed."""
    kept: list[str] = []
    total = 0
    for line in lines:
        cost = len(line) + (1 if kept else 0)  # +1 for the joining newline
        if total + cost > limit:
            break
        kept.append(line)
        total += cost
    return "\n".join(kept)


def _item_line(item: dict[str, Any]) -> str:
    """One bullet: '- Teeth Cleaning — AED 300, 30 min. Scale and polish.'"""
    bits: list[str] = []
    price = item.get("price_text")
    if not price and item.get("price_amount") is not None:
        # No verbatim quote — fall back to the parsed amount (+ currency when known).
        amount = f"{float(item['price_amount']):g}"
        currency = item.get("currency")
        price = f"{currency} {amount}" if currency else amount
    if price:
        bits.append(str(price))
    if item.get("duration_min"):
        bits.append(f"{item['duration_min']} min")

    line = f"- {item['name']}"
    if bits:
        line += " — " + ", ".join(bits)
    line += "."
    description = (item.get("description") or "").strip()
    if description:
        line += " " + _clip(description)
    return line


def build_catalog_block(
    items: list[dict[str, Any]], content_snippets: list[dict[str, Any]]
) -> str | None:
    """The authoritative catalog block, or None when there's nothing to show.

    Sections appear only when populated: Services, Products, then Key facts from the
    'content' snippets. Callers pass items in display order (kind, category, name) —
    this function only formats.
    """
    services = [i for i in items if i.get("kind") == "service"]
    products = [i for i in items if i.get("kind") == "product"]

    lines: list[str] = [CATALOG_HEADER]
    if services:
        lines.append("Services:")
        lines.extend(_item_line(i) for i in services)
    if products:
        lines.append("Products:")
        lines.extend(_item_line(i) for i in products)
    if content_snippets:
        lines.append("Key facts:")
        lines.extend(f"- {s['title']}: {_clip(s['body'])}" for s in content_snippets)

    if len(lines) == 1:  # header only — nothing to show
        return None
    return _cap_lines(lines, MAX_CATALOG_CHARS)


def build_guidelines_block(guideline_snippets: list[dict[str, Any]]) -> str | None:
    """The customer-handling rules block, or None when there are none."""
    if not guideline_snippets:
        return None
    lines = [GUIDELINES_HEADER]
    lines.extend(f"- {s['title']}: {_clip(s['body'])}" for s in guideline_snippets)
    return _cap_lines(lines, MAX_GUIDELINES_CHARS)


async def load_business_context(tenant_id: str) -> dict[str, str | None]:
    """Read this tenant's catalog + snippets and return the two prompt blocks.

    One scoped connection per turn; rows come back in the same display order the
    console uses, so what the model sees matches what the owner sees.
    """
    async with await scoped_connection(tenant_id=tenant_id) as conn:
        items = await (await conn.execute(
            "select * from catalog_items where tenant_id = %s "
            "order by kind, category nulls last, lower(name)",
            (tenant_id,),
        )).fetchall()
        snippets = await (await conn.execute(
            "select * from business_snippets where tenant_id = %s "
            "order by kind, sort, lower(title)",
            (tenant_id,),
        )).fetchall()
    content = [s for s in snippets if s["kind"] == "content"]
    guidelines = [s for s in snippets if s["kind"] == "guideline"]
    return {
        "catalog_block": build_catalog_block(items, content),
        "guidelines_block": build_guidelines_block(guidelines),
    }

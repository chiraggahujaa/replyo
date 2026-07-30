"""Business catalog — the read side: curated rows in, prompt blocks out.

app/extraction.py writes the structured catalog (services, products, guidelines,
facts, hours, contact details); this module turns it back into text the agent can be
grounded on. Two blocks,
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
import re
from typing import Any

from app.currency import format_amount
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

# Opening-hours / appointment settings (business_profiles). The defaults match the
# column defaults in 20260730100000_business_hours.sql — a persona with no profile row
# yet behaves exactly like one with a freshly-inserted default row.
DEFAULT_SLOT_MINUTES = 30
DEFAULT_BUFFER_MINUTES = 0

WEEKDAY_LABELS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
# The canonical opening-hours time shape: "HH:MM", 24-hour, strict. Shared by everything
# that writes or reads the jsonb (app/extraction.py drops non-matching LLM output,
# app/admin_api.py 422s a bad owner edit, hours_from_profile skips a malformed day) —
# one pattern, so a value that passed validation can never fail parsing later.
HHMM = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")

# Contact details (business_profiles.contact). This tuple is the field set AND the display
# order, everywhere: the stored jsonb, the prompt block, and the console's card. Anything
# not listed here is not a contact field — the extractor can't invent one and an owner
# edit naming one is a 422.
CONTACT_FIELDS = ("phone", "whatsapp", "email", "address", "website", "maps_url")
CONTACT_LABELS = {
    "phone": "Phone",
    "whatsapp": "WhatsApp",
    "email": "Email",
    "address": "Address",
    "website": "Website",
    "maps_url": "Directions",
}
MAX_CONTACT_VALUE_CHARS = 200
# A phone number the assistant could actually dial. The bar is deliberately low (any
# separators, extensions and second numbers are fine as written) but not zero: "call the
# front desk" is not a phone number, and an extractor that hands one over must be dropped
# rather than read out to a customer.
MIN_PHONE_DIGITS = 6
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]{2,}$")
# Deliberately scheme-optional: businesses write their site as "brightsmile.in" at least
# as often as with an https:// on the front, and both are perfectly quotable in a reply.
URLISH = re.compile(r"^(?:https?://)?[\w-]+(?:\.[\w-]+)+(?:[/?#]\S*)?$", re.IGNORECASE)


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
    """One bullet: '- Teeth Cleaning — ₹1,500, 30 min. Scale and polish.'"""
    bits: list[str] = []
    price = item.get("price_text")
    if not price and item.get("price_amount") is not None:
        # No verbatim quote — render the parsed amount the way a customer expects to see
        # it ("₹1,500", not "INR 1500"); app/currency.py owns the symbol and grouping.
        price = format_amount(item["price_amount"], item.get("currency"))
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


# ---------------------------------------------------------------------------
# Opening hours + appointment settings — pure converters over the profile row.
#
# business_profiles stores hours as jsonb keyed by weekday-as-string; app/booking.py
# speaks int-keyed ((h, m), (h, m)) tuples. These three functions are the whole bridge,
# and they're pure so the parsing/formatting rules are offline-testable and a malformed
# value can only ever mean "fall back", never "raise mid-booking".
# ---------------------------------------------------------------------------

def _clock(hour: int, minute: int) -> str:
    """'9:30am', '8pm', '12pm' — a human clock time, ':00' dropped."""
    suffix = "am" if hour < 12 else "pm"
    hour12 = hour % 12 or 12
    return f"{hour12}:{minute:02d}{suffix}" if minute else f"{hour12}{suffix}"


def _hhmm(value: object) -> tuple[int, int] | None:
    if not isinstance(value, str):
        return None
    match = HHMM.match(value.strip())
    if not match:
        return None
    return int(match.group(1)), int(match.group(2))


def hours_from_profile(
    profile: dict[str, Any] | None,
) -> dict[int, tuple[tuple[int, int], tuple[int, int]]] | None:
    """The profile's `hours` jsonb as app/booking.py's CLINIC_HOURS shape, or None.

    None means "this persona has no usable hours" — the caller then falls back to the
    module defaults rather than booking against an empty week (which would silently
    offer no slots at all, i.e. break booking outright). Closed days (null value) and
    malformed entries are skipped, so a half-extracted week still yields the days it
    got right.
    """
    raw = (profile or {}).get("hours") if isinstance(profile, dict) else None
    if not isinstance(raw, dict):
        return None
    week: dict[int, tuple[tuple[int, int], tuple[int, int]]] = {}
    for key, value in raw.items():
        try:
            weekday = int(key)
        except (TypeError, ValueError):
            continue
        if not 0 <= weekday <= 6 or not isinstance(value, dict):
            continue  # absent/null/garbage == closed that day
        opens, closes = _hhmm(value.get("open")), _hhmm(value.get("close"))
        if opens is None or closes is None or opens >= closes:
            continue
        week[weekday] = (opens, closes)
    return week or None


def format_hours_text(
    hours: dict[int, tuple[tuple[int, int], tuple[int, int]]] | None,
) -> str:
    """'Mon–Sat 9:30am–8pm, Sun 10am–2pm' — consecutive same-hours days collapsed.

    Closed days are simply absent from the input, which is also what breaks a run: a
    clinic shut on Wednesday renders 'Mon–Tue …, Thu–Sat …'. Returns "" for no hours so
    callers can treat it as falsy and fall back to their own wording.
    """
    if not hours:
        return ""
    groups: list[tuple[int, int, tuple[tuple[int, int], tuple[int, int]]]] = []
    for weekday in sorted(d for d in hours if isinstance(d, int) and 0 <= d <= 6):
        window = hours[weekday]
        if not window:
            continue
        if groups and groups[-1][1] == weekday - 1 and groups[-1][2] == window:
            groups[-1] = (groups[-1][0], weekday, window)  # extend the current run
        else:
            groups.append((weekday, weekday, window))

    parts: list[str] = []
    for first, last, ((oh, om), (ch, cm)) in groups:
        days = WEEKDAY_LABELS[first] if first == last else f"{WEEKDAY_LABELS[first]}–{WEEKDAY_LABELS[last]}"
        parts.append(f"{days} {_clock(oh, om)}–{_clock(ch, cm)}")
    return ", ".join(parts)


def booking_settings(profile: dict[str, Any] | None) -> tuple[int, int]:
    """(slot_minutes, buffer_minutes) for this persona, defaulted and sanity-checked."""
    row = profile if isinstance(profile, dict) else {}
    slot = row.get("slot_minutes")
    buffer = row.get("buffer_minutes")
    return (
        int(slot) if isinstance(slot, int) and slot > 0 else DEFAULT_SLOT_MINUTES,
        int(buffer) if isinstance(buffer, int) and buffer > 0 else DEFAULT_BUFFER_MINUTES,
    )


# ---------------------------------------------------------------------------
# Contact details — pure validators/converters over the profile's `contact` jsonb.
#
# One set of rules, three callers: app/extraction.py drops whatever an LLM claimed that
# doesn't pass, app/admin_api.py turns a failure into a readable 422 on the owner's edit,
# and contact_from_profile re-checks on the way out. That last one is not paranoia — a row
# can predate a rule change, and a bad value must degrade to "not stated" rather than reach
# a customer as a phone number that isn't one.
# ---------------------------------------------------------------------------

def clean_contact_value(field: str, value: object) -> str | None:
    """One contact field, normalized to a single line — or None when it's unusable.

    Whitespace is collapsed because these values are rendered as one bullet each: a
    three-line address from a crawled page must not break the block into lines the caps
    and the parsers can't account for. Everything is otherwise kept verbatim (the owner's
    own formatting of their number is the formatting customers recognize).
    """
    if field not in CONTACT_LABELS or not isinstance(value, str):
        return None
    text = " ".join(value.split())[:MAX_CONTACT_VALUE_CHARS].strip()
    if not text:
        return None
    if field in ("phone", "whatsapp"):
        return text if sum(c.isdigit() for c in text) >= MIN_PHONE_DIGITS else None
    if field == "email":
        return text if EMAIL.match(text) else None
    if field in ("website", "maps_url"):
        return text if URLISH.match(text) else None
    return text  # address — free prose, so non-blank is the whole rule


def clean_contact(raw: object) -> dict[str, str]:
    """A contact object reduced to its known, usable fields, in CONTACT_FIELDS order.

    The ordering is for whoever iterates the dict (a log line, a test); nothing depends on
    it, because Postgres normalizes jsonb key order on write and everything that RENDERS a
    card walks CONTACT_FIELDS itself.

    Empty dict means "no contact details", which is a legitimate state (nothing extracted
    yet, or an owner who cleared the card) and never an error.
    """
    if not isinstance(raw, dict):
        return {}
    cleaned = {}
    for field in CONTACT_FIELDS:
        value = clean_contact_value(field, raw.get(field))
        if value:
            cleaned[field] = value
    return cleaned


def contact_from_profile(profile: dict[str, Any] | None) -> dict[str, str]:
    """This persona's contact details, validated. `{}` when it has none."""
    raw = profile.get("contact") if isinstance(profile, dict) else None
    return clean_contact(raw)


def contact_lines(contact: dict[str, str] | None) -> list[str]:
    """The catalog block's contact section as lines, or [] when there's nothing to show."""
    if not contact:
        return []
    return ["Contact details:"] + [
        f"- {CONTACT_LABELS[f]}: {contact[f]}" for f in CONTACT_FIELDS if contact.get(f)
    ]


def build_catalog_block(
    items: list[dict[str, Any]],
    content_snippets: list[dict[str, Any]],
    *,
    hours_text: str | None = None,
    contact: dict[str, str] | None = None,
) -> str | None:
    """The authoritative catalog block, or None when there's nothing to show.

    Sections appear only when populated: Services, Products, Opening hours, Contact
    details, then Key facts from the 'content' snippets. Callers pass items in display
    order (kind, category, name) — this function only formats. `hours_text` comes from
    format_hours_text and `contact` from contact_from_profile, so "when are you open?" and
    "what's your number?" are answered from curated data instead of whichever crawled page
    happened to mention a time or a phone number.
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
    if hours_text:
        lines.append(f"Opening hours: {hours_text}")
    lines.extend(contact_lines(contact))
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


async def load_business_context(tenant_id: str) -> dict[str, Any]:
    """Read this tenant's catalog, snippets and profile; return what a turn needs.

    One scoped connection per turn; rows come back in the same display order the
    console uses, so what the model sees matches what the owner sees. `profile` is
    handed back raw (or None when the persona has never extracted) because the booking
    node needs its hours/slot settings, not a prompt string — app/inbound.py merges the
    whole dict onto the tenant, so nodes read `tenant["profile"]`.
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
        profile = await (await conn.execute(
            "select * from business_profiles where tenant_id = %s", (tenant_id,)
        )).fetchone()
    content = [s for s in snippets if s["kind"] == "content"]
    guidelines = [s for s in snippets if s["kind"] == "guideline"]
    return {
        "catalog_block": build_catalog_block(
            items,
            content,
            hours_text=format_hours_text(hours_from_profile(profile)),
            contact=contact_from_profile(profile),
        ),
        "guidelines_block": build_guidelines_block(guidelines),
        "profile": dict(profile) if profile else None,
    }

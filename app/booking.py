"""Booking service — turn collected slots into a real calendar appointment.

Responsibilities (all backend-agnostic; depends only on CalendarBackend):
  - parse a natural-language time ("Saturday around 3pm", "next Tue morning",
    "the second option") into a concrete slot, via the LLM,
  - snap it into the business's opening hours and appointment grid,
  - check availability, and on a conflict propose the next free alternatives,
  - create the event when the slot is free.

`try_book()` is pure orchestration with injectable `now` and `parse` so the whole
conflict flow is unit-testable without OpenAI or Google.

Per-persona hours/slot length arrive as KEYWORD-ONLY arguments whose defaults are the
old hardcoded constants (CLINIC_HOURS, DURATION, no buffer). That shape is deliberate:
every existing caller and test keeps working untouched, and a persona that has curated
hours (business_profiles.hours, converted by app/catalog.py hours_from_profile) simply
passes them in. This module stays free of database and tenant concepts.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from pydantic import BaseModel, Field

from app.calendar.base import CalendarBackend
from app.config import settings
from app.llm import get_chat_model

logger = logging.getLogger("replyo.booking")

DURATION = timedelta(minutes=30)

# weekday() -> ((open_h, open_m), (close_h, close_m)); Mon=0 .. Sun=6.
# The FALLBACK hours, used when a persona has no curated hours of its own. Matches
# data/sample-personas/brightsmile-dental/hours-location.md: Mon–Sat 09:30–20:00, Sun 10:00–14:00.
CLINIC_HOURS: dict[int, tuple[tuple[int, int], tuple[int, int]]] = {
    0: ((9, 30), (20, 0)),
    1: ((9, 30), (20, 0)),
    2: ((9, 30), (20, 0)),
    3: ((9, 30), (20, 0)),
    4: ((9, 30), (20, 0)),
    5: ((9, 30), (20, 0)),
    6: ((10, 0), (14, 0)),
}

# The hours shape both CLINIC_HOURS and hours_from_profile speak.
Hours = dict[int, tuple[tuple[int, int], tuple[int, int]]]


def clinic_tz() -> ZoneInfo:
    """The deployment-wide default timezone (CLINIC_TIMEZONE)."""
    return ZoneInfo(settings.clinic_timezone)


def tenant_tz(tenant: dict | None) -> ZoneInfo:
    """This persona's timezone, falling back to CLINIC_TIMEZONE.

    `tenants.timezone` is owner-supplied text, so an invalid or typo'd IANA name must
    never raise into a booking turn — a customer would get an error instead of a slot.
    We log and fall back, which is wrong by a few hours at worst and self-evident in the
    logs, rather than fatal.
    """
    name = (tenant or {}).get("timezone")
    if isinstance(name, str) and name.strip():
        try:
            return ZoneInfo(name.strip())
        except Exception:
            logger.warning(
                "Persona timezone %r is not a valid IANA name — falling back to %s",
                name, settings.clinic_timezone,
            )
    return clinic_tz()


def format_slot(dt: datetime) -> str:
    """Human-friendly slot label, e.g. 'Sat 25 Jul, 3:30 PM'."""
    hour12 = dt.hour % 12 or 12
    ampm = "AM" if dt.hour < 12 else "PM"
    return f"{dt:%a %d %b}, {hour12}:{dt.minute:02d} {ampm}"


def _grid(slot: int | None, buffer: int | None) -> tuple[timedelta, timedelta]:
    """(appointment length, grid step) from slot/buffer minutes.

    The appointment is `slot` long; the next one starts `slot + buffer` later, so the
    buffer is turnaround time the customer never sees. Non-positive/None values fall
    back to the defaults — a zero step would make iter_slots loop forever.
    """
    length = timedelta(minutes=slot) if slot and slot > 0 else DURATION
    pad = timedelta(minutes=buffer) if buffer and buffer > 0 else timedelta()
    return length, length + pad


def iter_slots(
    after: datetime, tz: ZoneInfo, days: int = 14, *,
    hours: Hours | None = None, slot: int | None = None, buffer: int | None = None,
):
    """Yield (start, end) appointment slots within opening hours, on/after `after`.

    Defaults reproduce the original behaviour exactly: CLINIC_HOURS, 30-minute
    appointments, no buffer.
    """
    week = CLINIC_HOURS if hours is None else hours
    length, step = _grid(slot, buffer)
    for d in range(days + 1):
        day = (after + timedelta(days=d)).date()
        window = week.get(day.weekday())
        if not window:  # closed that day
            continue
        (oh, om), (ch, cm) = window
        start = datetime(day.year, day.month, day.day, oh, om, tzinfo=tz)
        close = datetime(day.year, day.month, day.day, ch, cm, tzinfo=tz)
        while start + length <= close:
            if start >= after:
                yield start, start + length
            start += step


def snap_to_clinic(
    target: datetime, now: datetime, tz: ZoneInfo, *,
    hours: Hours | None = None, slot: int | None = None, buffer: int | None = None,
):
    """First open slot at/after max(target, now). None if none within horizon."""
    after = max(target, now)
    for start, end in iter_slots(after, tz, hours=hours, slot=slot, buffer=buffer):
        return start, end
    return None


def find_available(after: datetime, tz: ZoneInfo, calendar: CalendarBackend,
                   count: int = 3, exclude: set[datetime] | None = None, *,
                   hours: Hours | None = None, slot: int | None = None,
                   buffer: int | None = None):
    """Return up to `count` free (start, end) slots on/after `after`."""
    exclude = exclude or set()
    out = []
    for start, end in iter_slots(after, tz, hours=hours, slot=slot, buffer=buffer):
        if start in exclude:
            continue
        if calendar.is_free(start, end):
            out.append((start, end))
            if len(out) >= count:
                break
    return out


# ---- Natural-language time parsing ----
#
# The LLM does NLU only (weekday name + hour, or "pick option N"); Python does the
# date arithmetic. This split matters: gpt-4o-mini reliably extracts "Saturday 3pm"
# -> (saturday, 15:00) but is unreliable at computing which calendar date that is.

WEEKDAYS = {
    "monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3,
    "friday": 4, "saturday": 5, "sunday": 6,
}


class ParsedTime(BaseModel):
    understood: bool = Field(description="True if a concrete date+time could be determined.")
    start_iso: str | None = Field(
        None, description="The chosen appointment start as ISO 8601 with timezone offset."
    )


class _TimeIntent(BaseModel):
    """What the LLM extracts — no date math, no ISO formatting."""

    understood: bool = Field(description="True if a day and time can be determined.")
    option_index: int | None = Field(
        None, description="1-based index if the patient picked a previously offered option."
    )
    day: str | None = Field(
        None, description="One of: monday..sunday, or 'today', or 'tomorrow'. For 'this weekend' use 'saturday'."
    )
    hour: int | None = Field(None, description="Hour in 24h (0-23). morning=10, afternoon=15, evening=18.")
    minute: int | None = Field(0, description="Minute 0-59.")


def _compute_date(day: str, hour: int, minute: int, now: datetime, tz: ZoneInfo) -> datetime | None:
    today = now.date()
    day = day.lower().strip()
    if day == "today":
        d = today
    elif day == "tomorrow":
        d = today + timedelta(days=1)
    elif day in WEEKDAYS:
        delta = (WEEKDAYS[day] - today.weekday()) % 7
        if delta == 0:  # same weekday: if the time already passed today, use next week
            cand = datetime(today.year, today.month, today.day, hour, minute, tzinfo=tz)
            if cand <= now:
                delta = 7
        d = today + timedelta(days=delta)
    else:
        return None
    return datetime(d.year, d.month, d.day, hour, minute, tzinfo=tz)


def parse_requested_time(
    user_text: str, *, now: datetime, tz: ZoneInfo, options: list[str] | None = None
) -> ParsedTime:
    """Turn the user's message into one concrete start datetime (Python does the math)."""
    model = get_chat_model(temperature=0.0).with_structured_output(_TimeIntent)
    opts = (
        f"\nThe patient was previously offered these options (1-based); if they picked one, "
        f"set option_index: {options}" if options else ""
    )
    prompt = (
        f"Today is {now:%A}, {now.date().isoformat()} ({tz}).\n"
        f"Extract the intended appointment day and time from the patient's message. "
        f"Treat 'this weekend'/'the weekend' as day='saturday'; 'morning'=10:00, "
        f"'afternoon'=15:00, 'evening'=18:00 when no exact time is given.{opts}\n\n"
        f"Patient's message: {user_text!r}"
    )
    intent: _TimeIntent = model.invoke(prompt)  # type: ignore[assignment]

    # Picked a previously offered slot.
    if options and intent.option_index and 1 <= intent.option_index <= len(options):
        return ParsedTime(understood=True, start_iso=options[intent.option_index - 1])

    if not intent.understood or not intent.day or intent.hour is None:
        return ParsedTime(understood=False, start_iso=None)

    start = _compute_date(intent.day, intent.hour, intent.minute or 0, now, tz)
    if start is None:
        return ParsedTime(understood=False, start_iso=None)
    return ParsedTime(understood=True, start_iso=start.isoformat())


# ---- Orchestration ----

ParseFn = Callable[..., ParsedTime]


def reserve_slot(
    booking: dict,
    calendar: CalendarBackend,
    target: datetime,
    *,
    now: datetime,
    tz: ZoneInfo,
    hours: Hours | None = None,
    slot: int | None = None,
    buffer: int | None = None,
) -> dict:
    """Reserve a concrete `target` time: snap to the appointment grid, check the calendar,
    then create the event or return a conflict with alternatives.

    Split out from try_book so callers that already resolved a time (e.g. a reschedule,
    where the day is anchored to the existing appointment) can reuse the
    availability/creation logic without parsing text again. Returns the same result
    shapes as try_book.
    """
    snapped = snap_to_clinic(target, now, tz, hours=hours, slot=slot, buffer=buffer)
    if snapped is None:
        return {"status": "need_time"}
    start, end = snapped

    if calendar.is_free(start, end):
        name = booking.get("name", "patient")
        contact = booking.get("contact", "")
        event_id = calendar.create_event(
            start, end,
            summary=f"Dental appointment — {name}",
            description=f"Booked via Replyo. Patient: {name}. Contact: {contact}.",
        )
        return {"status": "confirmed", "start": start, "event_id": event_id}

    alternatives = find_available(
        start, tz, calendar, count=3, exclude={start}, hours=hours, slot=slot, buffer=buffer
    )
    return {"status": "conflict", "requested": start, "alternatives": [s for s, _ in alternatives]}


def try_book(
    booking: dict,
    calendar: CalendarBackend,
    user_text: str,
    *,
    now: datetime | None = None,
    parse: ParseFn | None = None,
    tz: ZoneInfo | None = None,
    hours: Hours | None = None,
    slot: int | None = None,
    buffer: int | None = None,
) -> dict:
    """Attempt to book from a ready booking_info by parsing a time out of `user_text`.

      {"status": "need_time"}                              -> couldn't determine a time
      {"status": "confirmed", "start", "event_id"}         -> event created
      {"status": "conflict", "requested", "alternatives"}  -> slot busy; alternatives offered
    """
    tz = tz or clinic_tz()
    now = now or datetime.now(tz)
    parse = parse or parse_requested_time  # resolved here so tests can monkeypatch
    options = booking.get("alternatives_iso")

    parsed = parse(user_text, now=now, tz=tz, options=options)
    if not parsed.understood or not parsed.start_iso:
        return {"status": "need_time"}

    target = datetime.fromisoformat(parsed.start_iso)
    if target.tzinfo is None:
        target = target.replace(tzinfo=tz)

    return reserve_slot(
        booking, calendar, target, now=now, tz=tz, hours=hours, slot=slot, buffer=buffer
    )

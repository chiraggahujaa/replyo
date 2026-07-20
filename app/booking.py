"""Booking service — turn collected slots into a real calendar appointment.

Responsibilities (all backend-agnostic; depends only on CalendarBackend):
  - parse a natural-language time ("Saturday around 3pm", "next Tue morning",
    "the second option") into a concrete slot, via the LLM,
  - snap it into the clinic's opening hours and 30-minute grid,
  - check availability, and on a conflict propose the next free alternatives,
  - create the event when the slot is free.

`try_book()` is pure orchestration with injectable `now` and `parse` so the whole
conflict flow is unit-testable without OpenAI or Google.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Callable, Optional
from zoneinfo import ZoneInfo

from pydantic import BaseModel, Field

from app.calendar.base import CalendarBackend
from app.config import settings
from app.llm import get_chat_model

DURATION = timedelta(minutes=30)

# weekday() -> ((open_h, open_m), (close_h, close_m)); Mon=0 .. Sun=6.
# Matches data/hours-location.md: Mon–Sat 09:30–20:00, Sun 10:00–14:00.
CLINIC_HOURS: dict[int, tuple[tuple[int, int], tuple[int, int]]] = {
    0: ((9, 30), (20, 0)),
    1: ((9, 30), (20, 0)),
    2: ((9, 30), (20, 0)),
    3: ((9, 30), (20, 0)),
    4: ((9, 30), (20, 0)),
    5: ((9, 30), (20, 0)),
    6: ((10, 0), (14, 0)),
}


def clinic_tz() -> ZoneInfo:
    return ZoneInfo(settings.clinic_timezone)


def format_slot(dt: datetime) -> str:
    """Human-friendly slot label, e.g. 'Sat 25 Jul, 3:30 PM'."""
    hour12 = dt.hour % 12 or 12
    ampm = "AM" if dt.hour < 12 else "PM"
    return f"{dt:%a %d %b}, {hour12}:{dt.minute:02d} {ampm}"


def iter_slots(after: datetime, tz: ZoneInfo, days: int = 14):
    """Yield (start, end) 30-min slots within clinic hours, on/after `after`."""
    for d in range(days + 1):
        day = (after + timedelta(days=d)).date()
        hours = CLINIC_HOURS.get(day.weekday())
        if not hours:
            continue
        (oh, om), (ch, cm) = hours
        start = datetime(day.year, day.month, day.day, oh, om, tzinfo=tz)
        close = datetime(day.year, day.month, day.day, ch, cm, tzinfo=tz)
        while start + DURATION <= close:
            if start >= after:
                yield start, start + DURATION
            start += DURATION


def snap_to_clinic(target: datetime, now: datetime, tz: ZoneInfo):
    """First clinic slot at/after max(target, now). None if none within horizon."""
    after = max(target, now)
    for start, end in iter_slots(after, tz):
        return start, end
    return None


def find_available(after: datetime, tz: ZoneInfo, calendar: CalendarBackend,
                   count: int = 3, exclude: Optional[set[datetime]] = None):
    """Return up to `count` free (start, end) slots on/after `after`."""
    exclude = exclude or set()
    out = []
    for start, end in iter_slots(after, tz):
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
    start_iso: Optional[str] = Field(
        None, description="The chosen appointment start as ISO 8601 with timezone offset."
    )


class _TimeIntent(BaseModel):
    """What the LLM extracts — no date math, no ISO formatting."""

    understood: bool = Field(description="True if a day and time can be determined.")
    option_index: Optional[int] = Field(
        None, description="1-based index if the patient picked a previously offered option."
    )
    day: Optional[str] = Field(
        None, description="One of: monday..sunday, or 'today', or 'tomorrow'. For 'this weekend' use 'saturday'."
    )
    hour: Optional[int] = Field(None, description="Hour in 24h (0-23). morning=10, afternoon=15, evening=18.")
    minute: Optional[int] = Field(0, description="Minute 0-59.")


def _compute_date(day: str, hour: int, minute: int, now: datetime, tz: ZoneInfo) -> Optional[datetime]:
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
    user_text: str, *, now: datetime, tz: ZoneInfo, options: Optional[list[str]] = None
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


def try_book(
    booking: dict,
    calendar: CalendarBackend,
    user_text: str,
    *,
    now: Optional[datetime] = None,
    parse: Optional[ParseFn] = None,
) -> dict:
    """Attempt to book from a ready booking_info. Returns a result dict:

      {"status": "need_time"}                              -> couldn't determine a time
      {"status": "confirmed", "start", "event_id"}         -> event created
      {"status": "conflict", "requested", "alternatives"}  -> slot busy; alternatives offered
    """
    tz = clinic_tz()
    now = now or datetime.now(tz)
    parse = parse or parse_requested_time  # resolved here so tests can monkeypatch
    options = booking.get("alternatives_iso")

    parsed = parse(user_text, now=now, tz=tz, options=options)
    if not parsed.understood or not parsed.start_iso:
        return {"status": "need_time"}

    target = datetime.fromisoformat(parsed.start_iso)
    if target.tzinfo is None:
        target = target.replace(tzinfo=tz)

    snapped = snap_to_clinic(target, now, tz)
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

    alternatives = find_available(start, tz, calendar, count=3, exclude={start})
    return {"status": "conflict", "requested": start, "alternatives": [s for s, _ in alternatives]}

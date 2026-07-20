"""Comprehensive booking tests against the REAL Google Calendar.

Drives the full graph (real OpenAI + Supabase + Google) through many booking cases
and verifies each created event actually exists on the calendar. EVERY event this
script creates is deleted in a finally block, so your calendar is left as it was.

Requires the Google backend (GOOGLE_SERVICE_ACCOUNT_FILE + GOOGLE_CALENDAR_ID).

Run:  uv run python scripts/test_google_calendar.py
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta

from app.booking import CLINIC_HOURS, DURATION, clinic_tz, format_slot
from app.booking import _compute_date  # noqa: internal helper reused for expected values
from app.calendar import get_calendar
from app.graph.build import graph_with_checkpointer, run_turn

TZ = clinic_tz()
CAL = get_calendar()
CREATED: set[str] = set()   # every event id we make (bot or manual) -> deleted at end
FAILURES: list[str] = []


def check(name, ok, detail=""):
    print(("   PASS " if ok else "   FAIL ") + name + (f"  ({detail})" if detail and not ok else ""))
    if not ok:
        FAILURES.append(name)


# ---- Google helpers ----

def ev_get(eid):
    try:
        return CAL._service.events().get(calendarId=CAL._calendar_id, eventId=eid).execute()
    except Exception:
        return None


def ev_start(eid):
    ev = ev_get(eid)
    return datetime.fromisoformat(ev["start"]["dateTime"]) if ev else None


def occupy(start: datetime) -> str:
    """Create a blocking event directly on the calendar (for conflict tests)."""
    eid = CAL.create_event(start, start + DURATION, "REPLYO TEST — occupied", "will be deleted")
    CREATED.add(eid)
    return eid


def within_hours(dt: datetime) -> bool:
    hrs = CLINIC_HOURS.get(dt.weekday())
    if not hrs:
        return False
    (oh, om), (ch, cm) = hrs
    t = dt.hour * 60 + dt.minute
    return oh * 60 + om <= t and t + 30 <= ch * 60 + cm


async def say(graph, thread, msg, *, reset=True):
    if reset:
        await graph.checkpointer.adelete_thread(thread)
    r = await run_turn(graph, thread, msg)
    bi = r.get("booking_info") or {}
    if bi.get("event_id"):
        CREATED.add(bi["event_id"])
    print(f"   · {msg[:50]:52} -> status={bi.get('status')} {bi.get('confirmed_time') or ''}")
    return bi


# ---- scenarios ----

async def scenario_explicit(graph):
    print("\n\033[1m1) Explicit day/time booking -> real Google event\033[0m")
    bi = await say(graph, "gc-explicit", "Book me next Tuesday at 2pm, I'm Asha, 98450 00001")
    check("confirmed", bi.get("status") == "confirmed", str(bi))
    eid = bi.get("event_id")
    check("event exists on Google", bool(eid) and ev_get(eid) is not None)
    if eid and ev_get(eid):
        start = ev_start(eid)
        exp = _compute_date("tuesday", 14, 0, datetime.now(TZ), TZ)
        check("event at Tuesday 2pm", start == exp, f"{start} != {exp}")
    return "gc-explicit", bi  # reused by duplicate-prevention test


async def scenario_nl_variety(graph):
    print("\n\033[1m2) Natural-language time variety (day correctness)\033[0m")
    cases = [
        ("Friday 5:30pm", "friday", 17, 30),
        ("tomorrow at 11am", "tomorrow", 11, 0),
    ]
    for i, (phrase, day, h, m) in enumerate(cases):
        bi = await say(graph, f"gc-nl-{i}", f"I'd like {phrase} please. I'm Ben, number 98450 0100{i}")
        check(f"'{phrase}' confirmed", bi.get("status") == "confirmed", str(bi))
        eid = bi.get("event_id")
        if eid and ev_get(eid):
            start, exp = ev_start(eid), _compute_date(day, h, m, datetime.now(TZ), TZ)
            check(f"'{phrase}' -> {exp:%a %d %b %H:%M}", start == exp, f"{start} != {exp}")


async def scenario_out_of_hours(graph):
    print("\n\033[1m3) Out-of-hours request snaps into clinic hours\033[0m")
    bi = await say(graph, "gc-ooh", "Can I come Sunday at 6pm? I'm Cara, 98450 01010")
    check("confirmed (snapped)", bi.get("status") == "confirmed", str(bi))
    eid = bi.get("event_id")
    if eid and ev_get(eid):
        start = ev_start(eid)
        check("within clinic hours", within_hours(start), f"{start} ({start:%A %H:%M})")
        check("not Sunday 18:00", not (start.weekday() == 6 and start.hour == 18), str(start))


async def scenario_missing_name(graph):
    print("\n\033[1m4) Multi-turn: no name -> not booked until provided\033[0m")
    b1 = await say(graph, "gc-name", "Book Wednesday 4pm, contact 98450 01111")  # no name
    check("not confirmed without name", b1.get("status") != "confirmed", str(b1))
    check("no event yet", not b1.get("event_id"))
    b2 = await say(graph, "gc-name", "it's under Ravi", reset=False)
    check("confirmed after name", b2.get("status") == "confirmed", str(b2))
    eid = b2.get("event_id")
    if eid and ev_get(eid):
        exp = _compute_date("wednesday", 16, 0, datetime.now(TZ), TZ)
        check("event at Wednesday 4pm", ev_start(eid) == exp, f"{ev_start(eid)} != {exp}")


async def scenario_conflict(graph):
    print("\n\033[1m5) Conflict -> alternatives -> pick one\033[0m")
    taken = _compute_date("thursday", 15, 0, datetime.now(TZ), TZ)
    occupy(taken)  # block Thursday 3pm on the real calendar
    print(f"   (occupied {format_slot(taken)} directly)")
    b1 = await say(graph, "gc-conflict", "I want Thursday 3pm, I'm Sara, 98450 01212")
    check("hits conflict", b1.get("status") == "conflict", str(b1))
    check("alternatives offered", len(b1.get("alternatives", [])) > 0, str(b1.get("alternatives")))
    check("no event booked on conflict", not b1.get("event_id"))
    b2 = await say(graph, "gc-conflict", "the first option works", reset=False)
    check("confirmed after picking", b2.get("status") == "confirmed", str(b2))
    eid = b2.get("event_id")
    if eid and ev_get(eid):
        start = ev_start(eid)
        check("booked at an alternative, not the taken slot", start != taken, str(start))
        check("chosen event exists on Google", ev_get(eid) is not None)


async def scenario_vague(graph):
    print("\n\033[1m6) Vague time -> asks to specify, does not misbook\033[0m")
    b1 = await say(graph, "gc-vague", "I'd like to book an appointment, I'm Alex, 98450 01313")
    b2 = await say(graph, "gc-vague", "whenever suits you, you decide", reset=False)
    check("did not confirm a vague time", b2.get("status") != "confirmed", str(b2))
    check("no event created for vague time", not b2.get("event_id"))


async def scenario_no_duplicate(graph, thread, prior):
    print("\n\033[1m7) Already-confirmed -> no duplicate booking\033[0m")
    before = prior.get("event_id")
    b = await say(graph, thread, "actually, can you also book me another slot?", reset=False)
    check("still confirmed", b.get("status") == "confirmed")
    check("no NEW event (same event_id)", b.get("event_id") == before, f"{b.get('event_id')} vs {before}")


async def main():
    print("backend:", type(CAL).__name__)
    if type(CAL).__name__ != "GoogleCalendar":
        raise SystemExit("Not using Google Calendar — set GOOGLE_SERVICE_ACCOUNT_FILE + GOOGLE_CALENDAR_ID in .env")

    try:
        async with graph_with_checkpointer() as graph:
            thread, prior = await scenario_explicit(graph)
            await scenario_nl_variety(graph)
            await scenario_out_of_hours(graph)
            await scenario_missing_name(graph)
            await scenario_conflict(graph)
            await scenario_vague(graph)
            await scenario_no_duplicate(graph, thread, prior)
    finally:
        print(f"\n\033[1mCleanup:\033[0m deleting {len(CREATED)} test event(s) from Google Calendar...")
        removed = 0
        for eid in CREATED:
            try:
                CAL._service.events().delete(calendarId=CAL._calendar_id, eventId=eid).execute()
                removed += 1
            except Exception:
                pass
        print(f"   removed {removed}/{len(CREATED)} events")

    print("\n" + "=" * 56)
    if FAILURES:
        print(f"  {len(FAILURES)} FAILURES: {FAILURES}")
        raise SystemExit(1)
    print("  ALL GOOGLE CALENDAR BOOKING TESTS PASSED")
    print("=" * 56)


if __name__ == "__main__":
    asyncio.run(main())

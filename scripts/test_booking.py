"""Deterministic tests for the Step 4 booking + conflict logic.

Uses the in-memory calendar and an injected time-parser, so it runs offline with no
OpenAI or Google calls. Covers try_book() directly and the full handle_booking
conflict -> pick -> confirm flow through the graph.

Run:  uv run python scripts/test_booking.py
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta

from langchain_core.messages import AIMessage

import app.booking as booking_mod
import app.graph.nodes as nodes
from app.booking import ParsedTime, clinic_tz, format_slot, iter_slots, try_book
from app.calendar.memory import InMemoryCalendar

TZ = clinic_tz()
FAILURES = []


def check(name, ok, detail=""):
    print(("   PASS " if ok else "   FAIL ") + name + (f"  ({detail})" if detail and not ok else ""))
    if not ok:
        FAILURES.append(name)


def first_slot_after(dt):
    for s, _ in iter_slots(dt, TZ):
        return s
    raise RuntimeError("no slot")


def fixed_parse(start: datetime):
    """A parser that always proposes `start` — unless prior options exist, then
    it 'picks' the first offered alternative (models the user choosing one)."""
    def _p(user_text, *, now, tz, options=None):
        if options:
            return ParsedTime(understood=True, start_iso=options[0])
        return ParsedTime(understood=True, start_iso=start.isoformat())
    return _p


# ---------------- try_book() unit tests ----------------

def test_try_book_unit():
    print("\n\033[1m1) try_book() — success / conflict / need_time\033[0m")
    now = datetime.now(TZ)
    target = first_slot_after(now + timedelta(days=1))  # a clean future clinic slot

    # success on empty calendar
    cal = InMemoryCalendar()
    r = try_book({"name": "Asha", "contact": "x"}, cal, "book it", now=now, parse=fixed_parse(target))
    check("empty calendar -> confirmed", r["status"] == "confirmed", str(r))
    check("event id returned", bool(r.get("event_id")))
    check("confirmed at requested slot", r.get("start") == target, str(r.get("start")))

    # conflict when that slot is taken
    cal2 = InMemoryCalendar()
    cal2.create_event(target, target + timedelta(minutes=30), "busy", "")
    r2 = try_book({"name": "Ben", "contact": "x"}, cal2, "book it", now=now, parse=fixed_parse(target))
    check("taken slot -> conflict", r2["status"] == "conflict", str(r2))
    check("alternatives offered", len(r2.get("alternatives", [])) > 0)
    check("requested slot excluded from alternatives", target not in r2.get("alternatives", []))
    check("alternatives are all free", all(cal2.is_free(s, s + timedelta(minutes=30)) for s in r2["alternatives"]))

    # need_time when parser can't understand
    def blind(user_text, *, now, tz, options=None):
        return ParsedTime(understood=False, start_iso=None)
    r3 = try_book({"name": "Cy", "contact": "x"}, InMemoryCalendar(), "uhh", now=now, parse=blind)
    check("unparseable -> need_time", r3["status"] == "need_time", str(r3))


def test_clinic_hours():
    print("\n\033[1m2) Clinic-hours slot generation\033[0m")
    now = datetime.now(TZ)
    slots = [s for s, _ in zip((s for s, _ in iter_slots(now, TZ)), range(300), strict=False)]
    # No slot before 09:30 on Mon–Sat, none in Sunday afternoon (Sun closes 14:00).
    bad_early = [s for s in slots if s.weekday() <= 5 and (s.hour, s.minute) < (9, 30)]
    bad_sunday = [s for s in slots if s.weekday() == 6 and s.hour >= 14]
    check("no Mon–Sat slot before 09:30", not bad_early, str(bad_early[:2]))
    check("no Sunday slot at/after 14:00", not bad_sunday, str(bad_sunday[:2]))


# ---------------- full node flow: conflict -> pick -> confirm ----------------

def _stub_llm():
    """Stub triage->booking_request and extraction returning full slots; replies echo."""
    from app.graph.nodes import BookingExtraction, TriageResult

    class FS:
        def __init__(s, o): s.o = o
        def invoke(s, m): return s.o

    class FM:
        def with_structured_output(s, schema):
            if schema is TriageResult:
                return FS(TriageResult(intent="booking_request"))
            return FS(BookingExtraction(name="Asha", preferred_time="Saturday 3pm", contact="98450 00000"))
        # _reply() tags the model so the websocket can allow-list streamable tokens;
        # the stub mirrors that part of the Runnable interface.
        def with_config(s, **kwargs): return s
        def invoke(s, m): return AIMessage(content="ok")

    nodes.get_chat_model = lambda temperature=0.0: FM()


async def run_node_flow():
    print("\n\033[1m3) handle_booking flow — book, conflict, pick alternative\033[0m")
    from langgraph.checkpoint.memory import MemorySaver

    from app.graph.build import build_graph, run_turn

    now = datetime.now(TZ)
    target = first_slot_after(now + timedelta(days=1))

    # Shared in-memory calendar across all turns; injected parser via monkeypatch.
    cal = InMemoryCalendar()
    nodes.get_calendar = lambda: cal
    booking_mod.parse_requested_time = fixed_parse(target)  # try_book resolves this at call time
    _stub_llm()

    graph = build_graph(MemorySaver())

    # User A books the target slot.
    a = await run_turn(graph, "bkA", "Book me in, I'm Asha, Saturday 3pm, 98450 00000")
    check("A confirmed", (a["booking_info"] or {}).get("status") == "confirmed", str(a["booking_info"]))
    check("A has event_id", bool((a["booking_info"] or {}).get("event_id")))

    # User B requests the same (now taken) slot -> conflict + alternatives.
    b = await run_turn(graph, "bkB", "Hi I'm Ben, Saturday 3pm please, 98450 11111")
    bi = b["booking_info"] or {}
    check("B hits conflict", bi.get("status") == "conflict", str(bi))
    check("B offered alternatives", len(bi.get("alternatives", [])) > 0)

    # User B picks the first alternative -> confirmed at that slot.
    b2 = await run_turn(graph, "bkB", "the first option works great")
    bi2 = b2["booking_info"] or {}
    check("B confirmed after picking", bi2.get("status") == "confirmed", str(bi2))
    expected = format_slot(datetime.fromisoformat(bi["alternatives_iso"][0]))
    check("B confirmed at chosen alternative", bi2.get("confirmed_time") == expected,
          f"{bi2.get('confirmed_time')} != {expected}")


async def run_reschedule_flow():
    print("\n\033[1m4) handle_booking flow — reschedule + confirmed acknowledgement\033[0m")
    from langgraph.checkpoint.memory import MemorySaver

    from app.graph.build import build_graph, run_turn

    now = datetime.now(TZ)
    s1 = first_slot_after(now + timedelta(days=1))
    s2 = first_slot_after(s1 + timedelta(hours=2))  # a different, free slot

    cal = InMemoryCalendar()
    nodes.get_calendar = lambda: cal
    booking_mod.parse_requested_time = fixed_parse(s1)  # initial booking resolves to s1
    _stub_llm()

    graph = build_graph(MemorySaver())

    # Book s1.
    r1 = await run_turn(graph, "rs", "Book me in, I'm Zoe, 98450 22222, tomorrow please")
    bi1 = r1["booking_info"] or {}
    check("initial booking confirmed", bi1.get("status") == "confirmed", str(bi1))
    old_event = bi1.get("event_id")
    check("s1 is now busy", not cal.is_free(s1, s1 + timedelta(minutes=30)))

    # Reschedule to s2 — the confirmed branch parses via nodes.parse_requested_time.
    nodes.parse_requested_time = lambda text, *, now, tz: ParsedTime(
        understood=True, start_iso=s2.isoformat()
    )
    r2 = await run_turn(graph, "rs", "actually can you move it a bit later")
    bi2 = r2["booking_info"] or {}
    check("reschedule confirmed", bi2.get("status") == "confirmed", str(bi2))
    check("moved to the new slot", bi2.get("confirmed_time") == format_slot(s2),
          f"{bi2.get('confirmed_time')} != {format_slot(s2)}")
    check("event id changed on move", bool(bi2.get("event_id")) and bi2.get("event_id") != old_event)
    check("old slot released", cal.is_free(s1, s1 + timedelta(minutes=30)))
    check("new slot now busy", not cal.is_free(s2, s2 + timedelta(minutes=30)))

    # A confirmed booking + a message with NO new time -> acknowledge, don't rebook.
    nodes.parse_requested_time = lambda text, *, now, tz: ParsedTime(understood=False, start_iso=None)
    kept_event = bi2.get("event_id")
    r3 = await run_turn(graph, "rs", "great, thank you so much!")
    bi3 = r3["booking_info"] or {}
    check("still confirmed after ack", bi3.get("status") == "confirmed", str(bi3))
    check("no rebooking on ack (event unchanged)", bi3.get("event_id") == kept_event,
          f"{bi3.get('event_id')} != {kept_event}")
    check("no duplicate event created", not cal.is_free(s2, s2 + timedelta(minutes=30)))


def main():
    test_try_book_unit()
    test_clinic_hours()
    asyncio.run(run_node_flow())
    asyncio.run(run_reschedule_flow())
    print("\n" + "=" * 56)
    if FAILURES:
        print(f"  {len(FAILURES)} FAILURES: {FAILURES}")
        raise SystemExit(1)
    print("  ALL BOOKING TESTS PASSED")
    print("=" * 56)


if __name__ == "__main__":
    main()

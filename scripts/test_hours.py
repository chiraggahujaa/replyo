"""Deterministic tests for opening hours and the per-persona appointment grid.

Covers the whole chain from what the extractor claims to what the booker offers, all of
it pure — no network, no database, no LLM:

  app/extraction.py  _merge_hours     — collapsing per-batch hour claims into one week
  app/catalog.py     hours_from_profile / format_hours_text / booking_settings
  app/booking.py     iter_slots (custom hours/slot/buffer) and tenant_tz

Run:  uv run python scripts/test_hours.py
"""

from __future__ import annotations

from datetime import datetime, timedelta

from app.booking import CLINIC_HOURS, clinic_tz, iter_slots, tenant_tz
from app.catalog import booking_settings, format_hours_text, hours_from_profile
from app.config import settings
from app.extraction import ExtractedHours, ExtractionBatch, _merge_hours

TZ = clinic_tz()
# A known Monday, so a weekday-keyed hours dict lines up with real dates. Asserted below
# rather than trusted — a wrong anchor would silently pass the wrong tests.
MONDAY = datetime(2026, 8, 3, 0, 0, tzinfo=TZ)

FAILURES = []


def check(name, ok, detail=""):
    print(("   PASS " if ok else "   FAIL ") + name + (f"  ({detail})" if detail and not ok else ""))
    if not ok:
        FAILURES.append(name)


def _batch(hours=(), slot=None):
    return ExtractionBatch(hours=[ExtractedHours(**h) for h in hours], slot_minutes=slot)


def _merged(*batches):
    """_merge_hours over (batch, source) pairs, in the order given."""
    return _merge_hours([(b, None) for b in batches])


# ---------------- 1) extraction: _merge_hours ----------------

def test_merge_hours():
    print("\n\033[1m1) _merge_hours — first batch wins per weekday\033[0m")

    hours, slot = _merged(
        _batch([{"day": "monday", "open": "09:30", "close": "20:00"}]),
        _batch([{"day": "monday", "open": "11:00", "close": "12:00"},
                {"day": "tuesday", "open": "10:00", "close": "18:00"}]),
    )
    check("first batch owns the weekday it claimed",
          hours == {"0": {"open": "09:30", "close": "20:00"},
                    "1": {"open": "10:00", "close": "18:00"}}, str(hours))
    check("slot stays None when no batch states one", slot is None, str(slot))

    hours, _ = _merged(_batch([{"day": "sunday", "closed": True}]))
    check("closed=true is recorded as closed (null)", hours == {"6": None}, str(hours))

    # A closure still CLAIMS the day: a later page saying "Sunday 10-14" must not reopen it.
    hours, _ = _merged(
        _batch([{"day": "sunday", "closed": True}]),
        _batch([{"day": "sunday", "open": "10:00", "close": "14:00"}]),
    )
    check("a claimed closure is not reopened by a later batch", hours == {"6": None}, str(hours))

    # Neither closed nor a complete window -> ignored, and does NOT claim the day, so a
    # good entry later still fills it.
    hours, _ = _merged(
        _batch([{"day": "wednesday", "open": "09:00"}, {"day": "thursday"}]),
        _batch([{"day": "wednesday", "open": "09:00", "close": "17:00"}]),
    )
    check("half-stated entry is dropped and leaves the day unclaimed",
          hours == {"2": {"open": "09:00", "close": "17:00"}}, str(hours))

    hours, _ = _merged(_batch([
        {"day": "monday", "open": "25:00", "close": "26:00"},    # not a real clock time
        {"day": "tuesday", "open": "9:5", "close": "17:00"},     # not zero-padded "HH:MM"
        {"day": "wednesday", "open": "abc", "close": "17:00"},   # not a time at all
        {"day": "thursday", "open": "17:00", "close": "09:00"},  # closes before it opens
    ]))
    check("every invalid time is dropped -> nothing stated", hours is None, str(hours))

    # The day is a NAME, so an unknown/garbage day can't reach the merge at all — pydantic
    # rejects it. This is the guard against the Sunday=0 confusion that once filed Sunday's
    # 10-6 window under Monday (see ExtractedHours' docstring).
    for bad in ("0", "Mon", "sun", "funday", ""):
        try:
            ExtractedHours(day=bad, open="09:00", close="17:00")  # type: ignore[arg-type]
            ok = False
        except Exception:
            ok = True
        check(f"day={bad!r} is rejected by the schema", ok)

    # Every real name maps to the Python weekday index business_profiles.hours is keyed by
    # (Monday=0 ... Sunday=6) — the mapping the model no longer has to get right.
    hours, _ = _merged(_batch([
        {"day": "monday", "open": "09:00", "close": "20:00"},
        {"day": "sunday", "open": "10:00", "close": "18:00"},
    ]))
    check("names map to Mon=0 / Sun=6, not the Sunday=0 convention",
          hours == {"0": {"open": "09:00", "close": "20:00"},
                    "6": {"open": "10:00", "close": "18:00"}}, str(hours))

    _, slot = _merged(_batch(slot=45), _batch(slot=60))
    check("slot_minutes: first stated value wins", slot == 45, str(slot))
    _, slot = _merged(_batch(slot=1))
    check("slot_minutes clamped up to 5", slot == 5, str(slot))
    _, slot = _merged(_batch(slot=9999))
    check("slot_minutes clamped down to 240", slot == 240, str(slot))
    _, slot = _merged(_batch(slot=45))
    check("in-range slot_minutes kept as-is", slot == 45, str(slot))

    check("no batches at all -> (None, None)", _merge_hours([]) == (None, None))


# ---------------- 2) catalog: hours_from_profile ----------------

def test_hours_from_profile():
    print("\n\033[1m2) hours_from_profile — jsonb -> booking hours\033[0m")

    week = hours_from_profile({"hours": {
        "0": {"open": "09:30", "close": "20:00"},
        "6": {"open": "10:00", "close": "14:00"},
    }})
    check("a valid week round-trips to int-keyed tuples",
          week == {0: ((9, 30), (20, 0)), 6: ((10, 0), (14, 0))}, str(week))

    check("None profile -> None", hours_from_profile(None) is None)
    check("profile with no hours -> None", hours_from_profile({"slot_minutes": 30}) is None)
    check("hours = null -> None", hours_from_profile({"hours": None}) is None)
    check("hours of the wrong type -> None", hours_from_profile({"hours": ["09:00"]}) is None)

    week = hours_from_profile({"hours": {
        "0": {"open": "09:00", "close": "17:00"},
        "1": None,                                  # closed
        "2": {"open": "9:5", "close": "17:00"},     # malformed
        "3": {"open": "17:00", "close": "09:00"},   # inverted
        "4": "09:00-17:00",                         # wrong shape
        "sat": {"open": "09:00", "close": "13:00"},  # non-numeric key
        "9": {"open": "09:00", "close": "13:00"},   # out of range
    }})
    check("closed and malformed days are skipped, good ones survive",
          week == {0: ((9, 0), (17, 0))}, str(week))

    check("a week where nothing is usable -> None (caller falls back)",
          hours_from_profile({"hours": {"0": None, "1": {"open": "bad", "close": "x"}}}) is None)


# ---------------- 3) catalog: format_hours_text ----------------

def test_format_hours_text():
    print("\n\033[1m3) format_hours_text — collapsed, human hours\033[0m")

    text = format_hours_text(CLINIC_HOURS)
    check("consecutive same-hours days collapse into one run",
          text == "Mon–Sat 9:30am–8pm, Sun 10am–2pm", text)

    check("a single open day renders alone",
          format_hours_text({2: ((9, 0), (17, 0))}) == "Wed 9am–5pm",
          format_hours_text({2: ((9, 0), (17, 0))}))

    closed_wednesday = {d: ((9, 0), (17, 0)) for d in (0, 1, 3, 4, 5)}
    check("a closed day splits the week into two groups",
          format_hours_text(closed_wednesday) == "Mon–Tue 9am–5pm, Thu–Sat 9am–5pm",
          format_hours_text(closed_wednesday))

    differing = {0: ((9, 0), (17, 0)), 1: ((10, 0), (17, 0)), 2: ((9, 0), (17, 0))}
    check("adjacent days with different hours are not collapsed",
          format_hours_text(differing) == "Mon 9am–5pm, Tue 10am–5pm, Wed 9am–5pm",
          format_hours_text(differing))

    check("empty hours -> ''", format_hours_text({}) == "")
    check("None hours -> ''", format_hours_text(None) == "")


# ---------------- 4) catalog: booking_settings ----------------

def test_booking_settings():
    print("\n\033[1m4) booking_settings — slot/buffer with defaults\033[0m")

    check("None profile -> (30, 0)", booking_settings(None) == (30, 0), str(booking_settings(None)))
    check("empty profile -> (30, 0)", booking_settings({}) == (30, 0), str(booking_settings({})))
    check("nulls -> (30, 0)",
          booking_settings({"slot_minutes": None, "buffer_minutes": None}) == (30, 0))
    check("real values are read",
          booking_settings({"slot_minutes": 45, "buffer_minutes": 15}) == (45, 15),
          str(booking_settings({"slot_minutes": 45, "buffer_minutes": 15})))
    check("a zero/negative slot falls back to the default",
          booking_settings({"slot_minutes": 0, "buffer_minutes": -5}) == (30, 0),
          str(booking_settings({"slot_minutes": 0, "buffer_minutes": -5})))


# ---------------- 5) booking: iter_slots with per-persona settings ----------------

def test_iter_slots_custom():
    print("\n\033[1m5) iter_slots — custom hours, slot length and buffer\033[0m")

    check("test anchor really is a Monday", MONDAY.weekday() == 0, str(MONDAY))

    hours = {0: ((9, 0), (12, 0))}  # Monday only, 09:00-12:00
    slots = list(iter_slots(MONDAY, TZ, days=0, hours=hours, slot=45, buffer=15))
    check("45-min slot + 15-min buffer -> 60-min grid",
          [s.strftime("%H:%M") for s in (s for s, _ in slots)] == ["09:00", "10:00", "11:00"],
          str([s.strftime("%H:%M") for s, _ in slots]))
    check("each slot ENDS at start + 45 (the buffer is not billable time)",
          all(end - start == timedelta(minutes=45) for start, end in slots),
          str([str(e - s) for s, e in slots]))
    check("no slot runs past closing", all(end <= MONDAY.replace(hour=12) for _, end in slots))

    tuesday = MONDAY + timedelta(days=1)
    check("a closed weekday yields no slots",
          list(iter_slots(tuesday, TZ, days=0, hours=hours, slot=45, buffer=15)) == [])
    check("a week with no open day at all yields no slots",
          list(iter_slots(MONDAY, TZ, days=6, hours={}, slot=45)) == [])

    # Defaults must reproduce the pre-per-persona behaviour exactly: CLINIC_HOURS,
    # 30-minute appointments, no buffer.
    default = list(iter_slots(MONDAY, TZ, days=0))
    check("default args -> 30-min grid on CLINIC_HOURS",
          [s.strftime("%H:%M") for s, _ in default[:3]] == ["09:30", "10:00", "10:30"],
          str([s.strftime("%H:%M") for s, _ in default[:3]]))
    check("default args -> 30-min appointments",
          all(end - start == timedelta(minutes=30) for start, end in default))
    check("Monday 09:30-20:00 on a 30-min grid is 21 slots", len(default) == 21, str(len(default)))

    # Curated hours override the module fallback rather than merging with it.
    late = list(iter_slots(MONDAY, TZ, days=0, hours={0: ((18, 0), (19, 0))}, slot=30))
    check("curated hours replace CLINIC_HOURS entirely",
          [s.strftime("%H:%M") for s, _ in late] == ["18:00", "18:30"],
          str([s.strftime("%H:%M") for s, _ in late]))


# ---------------- 6) booking: tenant_tz ----------------

def test_tenant_tz():
    print("\n\033[1m6) tenant_tz — owner-supplied timezone, never fatal\033[0m")

    fallback = settings.clinic_timezone
    check("a valid IANA name is honoured",
          tenant_tz({"timezone": "Asia/Kolkata"}).key == "Asia/Kolkata",
          tenant_tz({"timezone": "Asia/Kolkata"}).key)
    check("surrounding whitespace is tolerated",
          tenant_tz({"timezone": "  Europe/London  "}).key == "Europe/London")
    check("an invalid name falls back instead of raising",
          tenant_tz({"timezone": "Mars/Olympus_Mons"}).key == fallback,
          tenant_tz({"timezone": "Mars/Olympus_Mons"}).key)
    check("a blank timezone falls back", tenant_tz({"timezone": "   "}).key == fallback)
    check("a null timezone falls back", tenant_tz({"timezone": None}).key == fallback)
    check("a non-string timezone falls back", tenant_tz({"timezone": 5}).key == fallback)
    check("a tenant without the key falls back", tenant_tz({}).key == fallback)
    check("no tenant at all falls back", tenant_tz(None).key == fallback)


def main():
    test_merge_hours()
    test_hours_from_profile()
    test_format_hours_text()
    test_booking_settings()
    test_iter_slots_custom()
    test_tenant_tz()
    print("\n" + "=" * 56)
    if FAILURES:
        print(f"  {len(FAILURES)} FAILURES: {FAILURES}")
        raise SystemExit(1)
    print("  ALL HOURS TESTS PASSED")
    print("=" * 56)


if __name__ == "__main__":
    main()

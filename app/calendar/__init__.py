"""Calendar backend factory.

`get_calendar()` returns the Google backend when it's configured, otherwise an
in-memory fallback so the app still runs (and tests work) without Google creds.
The in-memory instance is a process-wide singleton so bookings made in one turn
are visible as conflicts in the next.
"""

from __future__ import annotations

import logging
from functools import lru_cache

from app.calendar.base import CalendarBackend
from app.calendar.memory import InMemoryCalendar
from app.config import settings

logger = logging.getLogger("replyo.calendar")


@lru_cache
def get_calendar() -> CalendarBackend:
    if settings.google_service_account_file and settings.google_calendar_id:
        from app.calendar.google import GoogleCalendar  # imported lazily

        logger.info("Using Google Calendar (%s)", settings.google_calendar_id)
        return GoogleCalendar(
            settings.google_service_account_file, settings.google_calendar_id
        )

    logger.warning(
        "Google Calendar not configured — using in-memory calendar (bookings are not "
        "persisted). Set GOOGLE_SERVICE_ACCOUNT_FILE and GOOGLE_CALENDAR_ID to use real Google."
    )
    return InMemoryCalendar()


__all__ = ["CalendarBackend", "get_calendar"]

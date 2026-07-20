"""Calendar backend interface.

The booking logic depends only on this small protocol, never on Google directly.
That keeps the business rules (clinic hours, conflict handling) testable with an
in-memory fake and lets us swap Google for Cal.com/etc. later without touching the
graph.
"""

from __future__ import annotations

from datetime import datetime
from typing import Protocol, runtime_checkable


@runtime_checkable
class CalendarBackend(Protocol):
    def is_free(self, start: datetime, end: datetime) -> bool:
        """Return True if no existing event overlaps [start, end)."""
        ...

    def create_event(self, start: datetime, end: datetime, summary: str, description: str) -> str:
        """Create an event and return a provider event id."""
        ...

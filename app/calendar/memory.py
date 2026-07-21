"""In-memory calendar backend.

Used when Google isn't configured, and by tests. Stores busy intervals in a plain
list so conflict detection is real (overlaps are genuinely rejected) — it just
isn't persistent across process restarts.
"""

from __future__ import annotations

import uuid
from datetime import datetime


class InMemoryCalendar:
    def __init__(self) -> None:
        # list of (start, end, event_id)
        self._events: list[tuple[datetime, datetime, str]] = []

    def is_free(self, start: datetime, end: datetime) -> bool:
        # Two intervals overlap iff start < other_end and other_start < end.
        return not any(start < e_end and e_start < end for e_start, e_end, _ in self._events)

    def create_event(self, start: datetime, end: datetime, summary: str, description: str) -> str:
        event_id = f"mem-{uuid.uuid4().hex[:12]}"
        self._events.append((start, end, event_id))
        return event_id

    def cancel_event(self, event_id: str) -> None:
        # Drop the matching interval; silently ignore an unknown id (idempotent).
        self._events = [ev for ev in self._events if ev[2] != event_id]

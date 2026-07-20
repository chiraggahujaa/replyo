"""Google Calendar backend (service-account auth).

Reads availability via the freebusy API and creates events via events.insert on a
single shared calendar. No OAuth consent flow: the service account authenticates
headlessly, and the clinic calendar is shared with its client_email.
"""

from __future__ import annotations

from datetime import datetime

from google.oauth2 import service_account
from googleapiclient.discovery import build

# Read + write events.
SCOPES = ["https://www.googleapis.com/auth/calendar"]


class GoogleCalendar:
    def __init__(self, service_account_file: str, calendar_id: str) -> None:
        creds = service_account.Credentials.from_service_account_file(
            service_account_file, scopes=SCOPES
        )
        # cache_discovery=False avoids a noisy warning and a filesystem cache.
        self._service = build("calendar", "v3", credentials=creds, cache_discovery=False)
        self._calendar_id = calendar_id

    def is_free(self, start: datetime, end: datetime) -> bool:
        body = {
            "timeMin": start.isoformat(),
            "timeMax": end.isoformat(),
            "items": [{"id": self._calendar_id}],
        }
        resp = self._service.freebusy().query(body=body).execute()
        busy = resp["calendars"][self._calendar_id].get("busy", [])
        return len(busy) == 0

    def create_event(self, start: datetime, end: datetime, summary: str, description: str) -> str:
        event = {
            "summary": summary,
            "description": description,
            "start": {"dateTime": start.isoformat()},
            "end": {"dateTime": end.isoformat()},
        }
        created = self._service.events().insert(calendarId=self._calendar_id, body=event).execute()
        return created["id"]

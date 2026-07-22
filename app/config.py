"""Central configuration.

We use pydantic-settings so every environment variable is validated once, in one
place, and imported everywhere else as `settings`. Reading `.env` happens
automatically.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # --- OpenAI ---
    openai_api_key: str
    openai_model: str = "gpt-4o-mini"

    # --- Postgres (Supabase) — used by the LangGraph checkpointer ---
    database_url: str

    # --- Telegram ---
    telegram_bot_token: str = ""

    # --- Google Calendar (Step 4 booking) ---
    # Path to the service-account JSON key. Leave blank to use the in-memory
    # calendar fallback (no external setup; good for local dev/tests).
    google_service_account_file: str = ""
    # The calendar to book on — usually the Google account email you shared with
    # the service account, or a specific calendar id.
    google_calendar_id: str = ""
    # IANA timezone for appointment times.
    clinic_timezone: str = "Asia/Kolkata"

    # --- WhatsApp (Meta Cloud API) ---
    # Leave blank to disable the channel entirely — the API and Telegram bot still
    # run fine (same pattern as the Google Calendar fallback).
    # `verify_token` is a string you invent; you type the same one into the Meta app
    # when registering the webhook, and Meta echoes it back on the verification GET.
    whatsapp_verify_token: str = ""
    whatsapp_access_token: str = ""
    whatsapp_phone_number_id: str = ""
    # Graph API version used for the send endpoint.
    whatsapp_api_version: str = "v21.0"

    @property
    def whatsapp_enabled(self) -> bool:
        return bool(self.whatsapp_access_token and self.whatsapp_phone_number_id)

    # --- Step 7: scheduled re-engagement follow-ups ---
    # How long after a patient's LAST message we nudge them if they never converted.
    # A float so it can be set to e.g. 0.001 to test the worker without waiting 2 days.
    followup_delay_hours: float = 48.0
    # Cap on nudges per conversation, so a cold lead is never nagged.
    followup_max_sends: int = 1

    # --- Optional LangSmith tracing ---
    langsmith_tracing: bool = True
    langsmith_api_key: str = ""
    langsmith_project: str = "replyo"
    # Workspace (tenant) the traces belong to. An org-scoped key authenticates fine
    # but is REFUSED (403) on workspace-scoped resources — projects and run ingestion
    # — unless the workspace is named. Symptom without it: the app looks correctly
    # configured, `tracing_is_enabled()` is True, and the logs quietly repeat
    # "Failed to multipart ingest runs ... 403 Forbidden" while LangSmith stays empty.
    # Find it in LangSmith -> Settings -> Workspaces, or via GET /workspaces.
    langsmith_workspace_id: str = ""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    def apply_langsmith_env(self) -> None:
        """Export LangSmith vars so LangChain/LangGraph auto-trace if enabled.

        LangChain reads these from the process environment, so we mirror our
        validated settings back into os.environ when tracing is turned on.
        """
        import os

        if self.langsmith_tracing and self.langsmith_api_key:
            os.environ["LANGSMITH_TRACING"] = "true"
            os.environ["LANGSMITH_API_KEY"] = self.langsmith_api_key
            os.environ["LANGSMITH_PROJECT"] = self.langsmith_project
            if self.langsmith_workspace_id:
                # The SDK turns this into the X-Tenant-Id header; without it,
                # run ingestion is rejected with 403 Forbidden.
                os.environ["LANGSMITH_WORKSPACE_ID"] = self.langsmith_workspace_id


@lru_cache
def get_settings() -> Settings:
    """Return a cached Settings instance (validated on first access)."""
    settings = Settings()  # type: ignore[call-arg]  # values come from env/.env
    settings.apply_langsmith_env()
    return settings


# Convenient module-level handle for imports that just want `settings`.
settings = get_settings()

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

    # --- Optional LangSmith tracing ---
    langsmith_tracing: bool = False
    langsmith_api_key: str = ""
    langsmith_project: str = "replyo"

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


@lru_cache
def get_settings() -> Settings:
    """Return a cached Settings instance (validated on first access)."""
    settings = Settings()  # type: ignore[call-arg]  # values come from env/.env
    settings.apply_langsmith_env()
    return settings


# Convenient module-level handle for imports that just want `settings`.
settings = get_settings()

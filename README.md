# Replyo

An AI-automation assistant for a small business (persona: **dental clinic**). It
triages inbound messages, and — across the roadmap — qualifies leads, answers from
the clinic's own documents (RAG), books appointments, syncs to a CRM, escalates to
humans, and follows up automatically.

Built step by step with **Python + LangGraph + FastAPI + Postgres (Supabase)**.

## What's built (Steps 1–4)

A working end-to-end slice with intent routing, lead/booking slot-filling,
document-grounded answers, and real appointment booking:

```
inbound message ──▶ FastAPI /chat  or  Telegram bot
                        │
                        ▼
      LangGraph:  START ─▶ triage ─┬─ new_lead ─────────▶ qualify ─────────▶ END
                                    ├─ question ─────────▶ answer_from_docs ▶ END   (RAG + citations)
                                    ├─ existing_customer ▶ respond ──────────▶ END
                                    ├─ booking_request ──▶ handle_booking ───▶ END   (Google Calendar)
                                    ├─ complaint ────────▶ handle_complaint ─▶ END
                                    └─ spam ─────────────▶ handle_spam ──────▶ END
                        │
                        ▼
        Postgres checkpointer (Supabase) + pgvector (docs) + Google Calendar (bookings)
```

- **triage** classifies each message into six intents and a conditional edge routes to one handler.
- **qualify** / **handle_booking** progressively collect slots (need/timeline/contact; name/time/contact)
  one question at a time via a shared slot-fill engine — neither can confirm until every required slot is filled.
- **answer_from_docs** (RAG) retrieves the most relevant chunks of the clinic's documents from pgvector
  and answers **only** from them, appending `Sources:`. Two anti-hallucination guards: a relevance-distance
  gate (refuse if nothing is close enough) and a strict grounding prompt (never invent prices/policies).
- **handle_booking** collects name/time/contact, then the booking service parses the requested time
  (LLM does NLU → Python does the date math), checks the calendar, and **books a real Google Calendar
  event** — or, on a conflict, offers the next free slots and books the one the patient picks. Falls back
  to an in-memory calendar when Google isn't configured, so it runs with zero setup.
- **handle_complaint** sets `needs_human = true` (the approval dashboard consuming it lands in Step 6).
- Every turn is persisted per `thread_id`, so a returning user is picked up where they left off.

`/chat` returns `intent`, `reply`, `lead_info`, `booking_info`, `citations`, and `needs_human`.

## Setup

1. **Install [uv](https://docs.astral.sh/uv/)** (fast Python package manager):
   ```bash
   pip3 install uv
   ```

2. **Create the env + install deps:**
   ```bash
   uv sync
   ```
   (Fallback without uv: `python3 -m venv .venv && source .venv/bin/activate && pip install -e .`)

3. **Configure secrets:** copy `.env.example` to `.env` and fill in:
   - `OPENAI_API_KEY`
   - `DATABASE_URL` — Supabase **Session pooler** string (port `5432`, `?sslmode=require`)
   - `TELEGRAM_BOT_TOKEN` — from [@BotFather](https://t.me/BotFather)

4. **Create the checkpointer tables (one time):**
   ```bash
   uv run python scripts/setup_checkpointer.py
   ```

5. **Ingest the clinic documents into pgvector (one time, re-run after editing `data/`):**
   ```bash
   uv run python scripts/ingest_docs.py
   ```
   This embeds every `data/*.md` file so the `question` intent can answer from them.

6. **(Optional) Google Calendar for real bookings.** Skip this and booking uses an
   in-memory calendar (works, but not persisted). For real events:
   1. [Google Cloud Console](https://console.cloud.google.com/) → new project → **enable the Google Calendar API**.
   2. **Create a Service Account** → **Keys** → **Add key → JSON** → download it into the repo
      (e.g. `./service-account.json`; it's git-ignored).
   3. Open the JSON, copy the `client_email`. In **Google Calendar → your calendar → Settings →
      Share with specific people**, add that email with **"Make changes to events"**.
   4. In `.env` set `GOOGLE_SERVICE_ACCOUNT_FILE=./service-account.json`,
      `GOOGLE_CALENDAR_ID=<your calendar id>` (often your Google email), and `CLINIC_TIMEZONE`.

## Run

**API (curl-testable):**
```bash
uv run uvicorn app.api:app --reload
```
```bash
curl -s localhost:8000/chat -H 'content-type: application/json' \
  -d '{"thread_id":"test1","message":"Hi, how much is a teeth cleaning?"}' | jq
# follow-up on the SAME thread_id — context is remembered:
curl -s localhost:8000/chat -H 'content-type: application/json' \
  -d '{"thread_id":"test1","message":"and do you take insurance?"}' | jq
```

**Telegram bot (long-polling, no public URL needed):**
```bash
uv run python -m app.channels.telegram_bot
```
Then message your bot on Telegram.

## Layout

```
app/
  config.py            # env / settings (pydantic-settings)
  llm.py               # ChatOpenAI factory
  graph/
    state.py           # ConversationState + LeadInfo + BookingInfo
    nodes.py           # triage, qualify, answer_from_docs (RAG), respond, handle_*
    build.py           # graph assembly, conditional routing + run_turn helper
  rag.py               # embeddings + pgvector store + retrieve() helper
  booking.py           # clinic hours, slot logic, NL time parse, try_book (conflict handling)
  calendar/            # calendar backends: base (interface), memory, google + get_calendar()
  api.py               # FastAPI: /health, /chat
  channels/
    telegram_bot.py    # Telegram long-polling worker (+ /start, /reset)
data/                  # clinic documents (pricing, services, policies, hours)
scripts/
  setup_checkpointer.py
  ingest_docs.py       # chunk + embed data/*.md into pgvector
  smoke_chat.py        # comprehensive live test harness (real OpenAI + Supabase)
  test_booking.py      # deterministic booking + conflict tests (offline)
```

## Roadmap

- ~~**Step 1** — foundation + working vertical slice (triage → respond, Postgres memory)~~ ✅
- ~~**Step 2** — per-intent routing + lead qualification (need/timeline/contact)~~ ✅
- ~~**Step 3** — RAG over clinic docs (pgvector) with citations + no-hallucination guard~~ ✅
- ~~**Step 4** — appointment booking (Google Calendar) with conflict handling~~ ✅
- **Step 5** — CRM sync (Airtable / HubSpot free tier)
- **Step 6** — human-in-the-loop escalation + Next.js approval dashboard
- **Step 7** — scheduled 48h re-engagement follow-ups
- **Cross-cutting** — web chat widget, WhatsApp channel, LangSmith tracing

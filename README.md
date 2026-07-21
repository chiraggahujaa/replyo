# Replyo

An AI-automation assistant for a small business (persona: **dental clinic**). It
triages inbound messages, and — across the roadmap — qualifies leads, answers from
the clinic's own documents (RAG), books appointments, syncs to a CRM, escalates to
humans, and follows up automatically.

Built step by step with **Python + LangGraph + FastAPI + Postgres (Supabase)**.

## What's built (Steps 1–4 + 6)

A working end-to-end slice with intent routing, lead/booking slot-filling,
document-grounded answers, real appointment booking, and human-in-the-loop
approval for sensitive replies:

```
inbound message ──▶ FastAPI /chat  or  Telegram bot
                        │
                        ▼
      LangGraph:  START ─▶ triage ─┬─ new_lead ─────────▶ qualify ─────────▶ END
                                    ├─ question ─────────▶ answer_from_docs ▶ END   (RAG + citations)
                                    ├─ existing_customer ▶ respond ──────────▶ END
                                    ├─ booking_request ──▶ handle_booking ───▶ END   (Google Calendar)
                                    ├─ complaint ────────▶ handle_complaint ─▶ human_review ⏸─▶ END   (draft → human approval)
                                    └─ spam ─────────────▶ handle_spam ──────▶ END
                        │
                        ▼
   Postgres checkpointer + pending_reviews queue (Supabase) + pgvector (docs) + Google Calendar (bookings)
                        │
                        ▼
        Next.js approval dashboard ─▶ approve / edit / reject ─▶ resume graph ─▶ reply sent
```

- **triage** classifies each message into six intents and a conditional edge routes to one handler.
- **qualify** / **handle_booking** progressively collect slots (need/timeline/contact; name/time/contact)
  one question at a time via a shared slot-fill engine — neither can confirm until every required slot is filled.
- **answer_from_docs** (RAG) retrieves the most relevant chunks of the clinic's documents from pgvector
  and answers **only** from them, appending `Sources:`. Two anti-hallucination guards: a relevance-distance
  gate (refuse if nothing is close enough) and a strict grounding prompt (never invent prices/policies).
- **handle_booking** collects name/time/contact, then the booking service parses the requested time
  (LLM does NLU → Python does the date math), checks the calendar, and **books a real Google Calendar
  event** — or, on a conflict, offers the next free slots and books the one the patient picks. A patient
  who's already booked can **reschedule** just by naming a new time: it rebooks and releases the old slot,
  reusing the name/contact on file (it never re-asks). Falls back to an in-memory calendar when Google
  isn't configured, so it runs with zero setup.
- **handle_complaint** does *not* reply to the customer directly — it **drafts** an empathetic reply and
  escalates. The next node, **human_review**, calls LangGraph's `interrupt()` to **pause the graph** (the full
  conversation is checkpointed to Postgres) and the caller queues the draft into a `pending_reviews` table.
  The customer gets a short holding message. A reviewer then acts on it from the **Next.js dashboard**:
  **approve** sends the draft as-is, **edit** sends their revised text, **reject** sends a safe handoff. The
  decision resumes the paused graph (`Command(resume=…)`), which finalises the reply and delivers it back on
  the customer's original channel (Telegram push, or stored on the review row for the web/API caller).
- Every turn is persisted per `thread_id`, so a returning user is picked up where they left off.

`/chat` returns `intent`, `reply`, `held`, `review_id`, `lead_info`, `booking_info`, `citations`, and
`needs_human`. When a message is escalated, `held` is `true`, `reply` is the holding message, and `review_id`
points at the queued item; the real reply goes out only once a human approves it.

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

4. **Provision the database tables (one time):**
   ```bash
   uv run python scripts/setup_checkpointer.py   # LangGraph checkpointer tables (library-owned)
   uv run python scripts/migrate.py              # app tables from supabase/migrations/ (pending_reviews)
   ```
   `scripts/migrate.py` reads `DATABASE_URL` from `.env` and runs `supabase db push --db-url …` — no
   `supabase link` needed, so the project's database can live under a different Supabase account than
   your CLI login. Pass `--dry-run` to preview first. The DDL is idempotent, so it's safe against a
   database that already has the table. The pgvector store's own table is created automatically on
   first ingest (next step).

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

**Approval dashboard (Next.js):**
```bash
cd dashboard
npm install          # first time only
npm run dev          # http://localhost:3000
```
The dashboard polls the API's `/reviews` endpoints (point it elsewhere via `NEXT_PUBLIC_API_URL` in
`dashboard/.env.local` if the API isn't on `localhost:8000`). Send the bot a complaint, watch it land in the
queue, then **approve / edit / reject** — the final reply is delivered back to that Telegram chat. The
`pending_reviews` table comes from the migration you applied in setup (`supabase db push`).

## Layout

```
app/
  config.py            # env / settings (pydantic-settings)
  llm.py               # ChatOpenAI factory
  graph/
    state.py           # ConversationState + LeadInfo + BookingInfo + review fields
    nodes.py           # triage, qualify, answer_from_docs (RAG), respond, handle_*, human_review
    build.py           # graph assembly, routing, run_turn + resume_review (interrupt/resume)
  rag.py               # embeddings + pgvector store + retrieve() helper
  booking.py           # clinic hours, slot logic, NL time parse, try_book (conflict handling)
  calendar/            # calendar backends: base (interface), memory, google + get_calendar()
  reviews.py           # pending_reviews queue (Postgres): create / list / get / resolve
  notify.py            # deliver an approved reply back to the customer's channel
  api.py               # FastAPI: /health, /chat, /reviews, /reviews/{id}, /reviews/{id}/decision
  channels/
    telegram_bot.py    # Telegram long-polling worker (+ /start, /reset; queues escalations)
data/                  # clinic documents (pricing, services, policies, hours)
dashboard/             # Next.js approval dashboard (review-queue UI, polls the API)
supabase/
  migrations/          # SQL migrations for app-owned tables (pending_reviews, …)
scripts/
  setup_checkpointer.py
  migrate.py           # apply supabase/migrations via `supabase db push` (reads DATABASE_URL from .env)
  ingest_docs.py       # chunk + embed data/*.md into pgvector
  smoke_chat.py        # comprehensive live test harness (real OpenAI + Supabase)
  test_booking.py      # deterministic booking + conflict tests (offline)
```

## Roadmap

- ~~**Step 1** — foundation + working vertical slice (triage → respond, Postgres memory)~~ ✅
- ~~**Step 2** — per-intent routing + lead qualification (need/timeline/contact)~~ ✅
- ~~**Step 3** — RAG over clinic docs (pgvector) with citations + no-hallucination guard~~ ✅
- ~~**Step 4** — appointment booking (Google Calendar) with conflict handling~~ ✅
- **Step 5** — CRM sync (Airtable / HubSpot free tier)  *(deferred)*
- ~~**Step 6** — human-in-the-loop escalation + Next.js approval dashboard~~ ✅
- **Step 7** — scheduled 48h re-engagement follow-ups
- **Cross-cutting** — web chat widget, WhatsApp channel, LangSmith tracing

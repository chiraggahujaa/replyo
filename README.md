# Replyo

An AI-automation assistant for a small business (persona: **dental clinic**). It
triages inbound messages, and — across the roadmap — qualifies leads, answers from
the clinic's own documents (RAG), books appointments, syncs to a CRM, escalates to
humans, and follows up automatically.

Built step by step with **Python + LangGraph + FastAPI + Postgres (Supabase)**.

## What's built (Steps 1–2)

A working end-to-end slice with intent-based routing and lead qualification:

```
inbound message ──▶ FastAPI /chat  or  Telegram bot
                        │
                        ▼
      LangGraph:  START ─▶ triage ─┬─ new_lead ─────────▶ qualify ─────────▶ END
                                    ├─ existing_customer ▶ respond ──────────▶ END
                                    ├─ booking_request ──▶ handle_booking ───▶ END
                                    ├─ complaint ────────▶ handle_complaint ─▶ END
                                    └─ spam ─────────────▶ handle_spam ──────▶ END
                        │
                        ▼
        Postgres checkpointer (Supabase)  ← per-conversation memory
```

- **triage** classifies each message: `new_lead · existing_customer · booking_request · complaint · spam`
  and a conditional edge routes to exactly one handler.
- **qualify** progressively collects lead slots — **need · timeline · contact** (+ name, budget) —
  one question at a time, accumulating them across turns via the checkpointer. Flips
  `lead_info.qualified = true` once the required slots are filled.
- **handle_complaint** sets `needs_human = true` (the approval dashboard consuming it lands in Step 6).
- Every turn is persisted per `thread_id`, so a returning user is picked up where
  they left off — for free, via the checkpointer.

`/chat` returns `intent`, `reply`, and (for leads) the running `lead_info` + `needs_human` so you
can watch qualification fill up turn by turn.

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
    state.py           # ConversationState + LeadInfo
    nodes.py           # triage, qualify, respond, handle_booking/complaint/spam
    build.py           # graph assembly, conditional routing + run_turn helper
  api.py               # FastAPI: /health, /chat
  channels/
    telegram_bot.py    # Telegram long-polling worker
scripts/
  setup_checkpointer.py
```

## Roadmap

- ~~**Step 1** — foundation + working vertical slice (triage → respond, Postgres memory)~~ ✅
- ~~**Step 2** — per-intent routing + lead qualification (need/timeline/contact)~~ ✅
- **Step 3** — RAG over clinic docs (pgvector) with citations + no-hallucination guard
- **Step 4** — appointment booking (Cal.com / Google Calendar) with conflict handling
- **Step 5** — CRM sync (Airtable / HubSpot free tier)
- **Step 6** — human-in-the-loop escalation + Next.js approval dashboard
- **Step 7** — scheduled 48h re-engagement follow-ups
- **Cross-cutting** — web chat widget, WhatsApp channel, LangSmith tracing

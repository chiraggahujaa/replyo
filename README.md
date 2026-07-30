# Replyo

An AI-automation platform. Any business signs up, uploads its documents and points at
its website, and gets an embeddable assistant that triages inbound messages, qualifies
leads, answers from that business's own knowledge (RAG), books appointments, escalates
sensitive replies to a human, and follows up automatically — across a web widget,
Telegram and WhatsApp. It began as a single dental-clinic assistant (the demo persona,
still built in) and became **multi-tenant** in Step 9.

Built step by step with **Python + LangGraph + FastAPI + Postgres (Supabase, RLS) +
Next.js**.

## Multi-tenant console (Step 9)

One login owns many **personas** (businesses), each fully isolated:

- **Isolation is enforced in Postgres.** Every persona's conversations, review queue and
  knowledge live under **Row-Level Security**. The app connects as `postgres` (which
  bypasses RLS) but runs tenant data through `SET ROLE authenticated` + a per-connection
  `app.tenant_id` GUC, so a forgotten filter can't leak another tenant — an unset tenant
  sees zero rows, not everything. See `app/tenancy.py` and `supabase/migrations/*multitenancy*`.
- **Per-persona knowledge.** Each persona has its own pgvector collection; you upload
  documents and add website URLs (deep-crawled, ~50 pages/site) via the dashboard.
- **Generated prompt.** A wizard turns the business name + notes + ingested knowledge into
  a system prompt you can edit; at answer time it's combined with the persona's retrieved
  chunks.
- **One embed key per persona.** `<script data-tenant="pk_…">` — the widget resolves the
  key to a tenant; conversation threads are bound to that tenant server-side, so no one can
  read or resume another persona's chats.

**Setup (one time):** in Supabase → **Authentication → Providers**, enable **Google** and
**Email**. Set `SUPABASE_URL` in `.env` (the API verifies login JWTs via its JWKS) and
`NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in `dashboard/.env.local`.
Apply the migrations with `uv run python scripts/migrate.py`.

**Run the console:**
```bash
cd dashboard && npm install && npm run dev   # http://localhost:3000
```
Sign in → create a persona → feed it knowledge → review/edit its prompt → copy the embed
snippet (and test the assistant live, right on the Install page). The review queue,
knowledge base and install snippet are all scoped to the active persona.

---

The single-business framing below describes the built-in **demo persona** (BrightSmile
Dental); it's now one tenant among many.

## What's built (Steps 1–4, 6–8)

A working end-to-end slice with intent routing, lead/booking slot-filling,
document-grounded answers, real appointment booking, human-in-the-loop approval
for sensitive replies, automatic re-engagement of cold leads, and three inbound
channels (web widget, Telegram, WhatsApp):

```
inbound message ──▶ web widget  or  Telegram bot  or  WhatsApp  ──▶ FastAPI
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
   Postgres checkpointer + pending_reviews + follow_ups (Supabase) + pgvector (docs) + Google Calendar
                        │
                        ├──▶ Next.js approval dashboard ─▶ approve / edit / reject ─▶ resume graph ─▶ reply sent
                        │
                        └──▶ follow-up worker (cron) ─▶ 48h after a cold thread ─▶ re-engagement nudge sent

  Both outbound paths reach the patient on whatever channel they used: pushed via the
  Telegram / WhatsApp APIs, or over the widget's websocket. The follow-up worker is a
  separate process, so it publishes through Postgres LISTEN/NOTIFY and the API relays
  it to whichever sockets it holds.
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
- **Follow-ups (Step 7)** — after every turn we decide whether the conversation deserves a nudge later
  and upsert one `follow_ups` row per thread, so each new message pushes `due_at` out again: the 48h clock
  runs from the patient's *last* message and only genuinely cold threads are chased. It's deliberately
  conservative — a **confirmed booking**, an **escalated complaint**, or **spam** cancels the nudge, while a
  half-finished booking or an enquiry that never booked schedules one. The worker
  (`scripts/run_followups.py`, cron-friendly) writes a short personalised message from the thread's own
  history, delivers it on the patient's channel, and appends it to the transcript — so if they reply, the
  graph picks the conversation up in context. Capped at one nudge per conversation, so nobody gets nagged.
- **Channels (Step 8)** — one graph, three ways in. Every channel is a thin adapter over
  `app/inbound.py`, which runs the turn and applies the shared side effects (queue an escalated
  reply, arm the follow-up nudge), so nothing can drift between them. Thread ids are namespaced
  (`web:` / `telegram:` / `whatsapp:`) and never collide.
  - **Web widget** — one `<script>` tag, embeddable on any site, isolated in a Shadow DOM, talking
    over a **websocket**: replies stream token by token, and messages that answer nothing the
    visitor just typed (a reply staff approved, a 48h nudge) are pushed to the open socket. It
    degrades to `POST /chat` + polling if a socket can't be opened, and restores history from the
    server on reload. Only tokens tagged as customer-facing are ever streamed — every node also
    makes structured-output calls, and the complaint handler's JSON contains the draft that must
    stay hidden until a human approves it.
  - **WhatsApp** — Meta Cloud API webhook (verification handshake + inbound). WhatsApp pushes to
    us, so unlike Telegram's long-polling it needs a public HTTPS URL. Duplicate deliveries are
    dropped by message id, since Meta retries and a re-run would double-reply.
- Every turn is persisted per `thread_id`, so a returning user is picked up where they left off.

`/chat` returns `intent`, `reply`, `held`, `review_id`, `lead_info`, `booking_info`, `citations`, and
`needs_human`. When a message is escalated, `held` is `true`, `reply` is the holding message, and `review_id`
points at the queued item; the real reply goes out only once a human approves it. The request may
also carry `images` — a list of `data:image/…;base64,` URLs (max 4 per message, ~1.5 MB each,
~4 MB combined) — passed to the model as multimodal input; `message` may be empty when images are
present.

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

5. **Ingest the clinic documents into pgvector (one time, re-run after editing `data/sample-personas/brightsmile-dental/`):**
   ```bash
   uv run python scripts/ingest_docs.py
   ```
   This embeds every `data/sample-personas/brightsmile-dental/*.md` file so the `question` intent can answer from them.

6. **(Optional) Google Calendar for real bookings.** Skip this and booking uses an
   in-memory calendar (works, but not persisted). For real events:
   1. [Google Cloud Console](https://console.cloud.google.com/) → new project → **enable the Google Calendar API**.
   2. **Create a Service Account** → **Keys** → **Add key → JSON** → download it into the repo
      (e.g. `./service-account.json`; it's git-ignored).
   3. Open the JSON, copy the `client_email`. In **Google Calendar → your calendar → Settings →
      Share with specific people**, add that email with **"Make changes to events"**.
   4. In `.env` set `GOOGLE_SERVICE_ACCOUNT_FILE=./service-account.json`,
      `GOOGLE_CALENDAR_ID=<your calendar id>` (often your Google email), and `CLINIC_TIMEZONE`.

## Checks (lint, types, CI)

Tooling is pinned as dev dependencies (`uv sync` installs it), configured in
`pyproject.toml`, and enforced three ways — the same commands everywhere, so a clean
local run means a green pipeline:

```bash
uv run ruff check .              # Python lint  (config: [tool.ruff])
uv run pyright                   # Python types (config: [tool.pyright]; Pylance's engine)
cd dashboard && npm run lint     # eslint — same for clinic-site/
uv run pre-commit run --all-files  # everything, across the whole repo
```

- **Pre-commit** (`.pre-commit-config.yaml`, install once with `uv run pre-commit install`):
  hygiene hooks (whitespace, EOF, broken YAML/TOML/JSON, merge markers, stray private
  keys, oversized files) + `ruff --fix` + eslint on the staged files of each Next.js app.
- **GitHub Actions** (`.github/workflows/ci.yml`): three jobs on every push/PR — backend
  (`uv sync --frozen`, ruff, pyright, an import smoke test), dashboard and clinic-site
  (eslint, `tsc --noEmit`, production build). No secrets needed; `uv.lock` is committed
  so CI installs are reproducible.

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

**Clinic website + chat widget (Next.js):**
```bash
cd clinic-site
npm install          # first time only
npm run dev          # http://localhost:3000
```
A full BrightSmile Dental site (services, pricing, patient info, visit us) with the assistant
embedded. Its content is transcribed from `data/sample-personas/brightsmile-dental/*.md` into `clinic-site/lib/content.ts` — the same
documents the assistant answers from, so the page and the chat bubble agree. **Change a price in
one, change it in the other.**

Embedding the widget on any other site is one tag — it's plain JS in a Shadow DOM, served by the
API, with nothing Next.js-specific about it:
```html
<script src="http://localhost:8000/widget/widget.js" data-api="http://localhost:8000"></script>
```
It keeps a `web:<uuid>` thread in `localStorage` (history survives reloads), talks over a
**websocket** for live token-by-token replies, and falls back to `POST /chat` + polling
`GET /chat/{id}/messages` if the socket can't be established. Visitors can attach images
(sent as data URLs over `POST /chat`, never the socket); add `data-attachments="off"` to the
tag to disable the paperclip — like every appearance field it defaults on and is also
configurable from the console's Install page, with the explicit attribute winning. The header's
`⋮` menu offers **Reset conversation** (client-side: mints a fresh thread, nothing is deleted
server-side) and **Download transcript** (a plain-text `.txt` of the chat).

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
The dashboard follows the queue live over a **websocket** (`/ws/admin` — Postgres triggers NOTIFY on
every `pending_reviews`/`knowledge_sources` write, and the API pushes a "changed" signal to the
console, which refetches over HTTP), degrading to polling the `/reviews` endpoints if a socket can't
be opened (point it elsewhere via `NEXT_PUBLIC_API_URL` in `dashboard/.env.local` if the API isn't on
`localhost:8000`). Send the bot a complaint, watch it land in the queue instantly, then
**approve / edit / reject** — the final reply is delivered back to that Telegram chat. The
`pending_reviews` table and the notify triggers come from the migrations you applied in setup
(`supabase db push`).

**Follow-up worker (Step 7):**
```bash
uv run python scripts/run_followups.py                       # one sweep (cron-friendly)
uv run python scripts/run_followups.py --loop --interval 300 # or keep it polling
```
`--dry-run` shows what would be sent without sending; `--force` ignores the 48h timer so you can test
immediately. You can also set `FOLLOWUP_DELAY_HOURS=0` in `.env` (and `FOLLOWUP_MAX_SENDS` to allow
repeat nudges) instead of waiting two days. In production this is just a cron entry, e.g. hourly:
```
0 * * * * cd /path/to/replyo && uv run python scripts/run_followups.py >> /tmp/replyo-followups.log 2>&1
```

**WhatsApp (Meta Cloud API — free to test):** WhatsApp *pushes* to us, so unlike Telegram it
needs a public HTTPS URL. Free test setup:

1. [developers.facebook.com](https://developers.facebook.com/) → create an app → add the
   **WhatsApp** product. You get a free test number; copy its **Phone number ID**, and add your
   own phone as a verified recipient (dev mode allows up to 5).
2. Put the phone number id, the access token, and any random verify token you invent into `.env`
   (`WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_VERIFY_TOKEN`). The quick
   token expires in 24h — create a **System User** token for a permanent one.
3. Expose the API and register the webhook:
   ```bash
   uv run uvicorn app.api:app --reload      # terminal A
   cloudflared tunnel --url http://localhost:8000   # terminal B — free, no account
   ```
   In the Meta app set the Callback URL to `https://<tunnel-host>/webhooks/whatsapp`, paste the
   same verify token, click **Verify and save**, then subscribe to the **messages** field.
4. Message the test number from your verified phone.

Replies are free "service conversations" (you're answering someone who messaged you, inside the
24h window). Leave the vars blank and the channel is simply off — everything else still runs.

**Tracing (optional):** set `LANGSMITH_TRACING=true` and `LANGSMITH_API_KEY` in `.env`, restart,
then open [smith.langchain.com](https://smith.langchain.com). Each turn is one run named
`replyo:<channel>` (and `replyo:resume` for human-approved resumes), tagged `channel:telegram` /
`channel:web` / `channel:whatsapp` and carrying `thread_id` metadata — so you can jump straight
to one conversation and see the `triage → handler` node spans with their prompts.

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
  followups.py         # follow_ups queue + "does this thread deserve a nudge?" decision
  notify.py            # deliver an approved reply / follow-up on the customer's channel
  inbound.py           # one turn + the side effects every channel shares (review queue, nudge)
  api.py               # FastAPI: /health, /chat, /chat/{id}/messages, /reviews*, /widget, webhooks
  channels/
    telegram_bot.py    # Telegram long-polling worker (+ /start, /reset)
    whatsapp.py        # WhatsApp webhook: verify handshake, parse_inbound(), retry dedup
  static/
    widget.js          # embeddable chat widget (Shadow DOM, websocket + HTTP fallback)
  realtime.py          # Postgres LISTEN/NOTIFY hub -> pushes to widget + dashboard sockets
data/
  sample-personas/     # sample persona documents, one folder per persona
    brightsmile-dental/  # demo clinic docs (pricing, services, policies, hours)
    riverbend-wellness-spa/
clinic-site/           # Next.js clinic website (embeds the widget; content from the demo persona docs)
dashboard/             # Next.js approval dashboard (live over websocket, polls as fallback)
supabase/
  migrations/          # SQL migrations for app-owned tables (pending_reviews, …)
scripts/
  setup_checkpointer.py
  migrate.py           # apply supabase/migrations via `supabase db push` (reads DATABASE_URL from .env)
  ingest_docs.py       # chunk + embed the demo persona's .md docs into pgvector
  run_followups.py     # send due re-engagement nudges (cron-friendly; --dry-run/--force/--loop)
  smoke_chat.py        # comprehensive live test harness (real OpenAI + Supabase)
  test_booking.py      # deterministic booking + conflict + reschedule tests (offline)
  test_followups.py    # deterministic follow-up decision tests (offline)
  test_whatsapp.py     # deterministic webhook parsing + retry-dedup tests (offline)
```

## Roadmap

- ~~**Step 1** — foundation + working vertical slice (triage → respond, Postgres memory)~~ ✅
- ~~**Step 2** — per-intent routing + lead qualification (need/timeline/contact)~~ ✅
- ~~**Step 3** — RAG over clinic docs (pgvector) with citations + no-hallucination guard~~ ✅
- ~~**Step 4** — appointment booking (Google Calendar) with conflict handling~~ ✅
- **Step 5** — CRM sync (Airtable / HubSpot free tier)  *(deferred)*
- ~~**Step 6** — human-in-the-loop escalation + Next.js approval dashboard~~ ✅
- ~~**Step 7** — scheduled 48h re-engagement follow-ups~~ ✅
- ~~**Step 8 (cross-cutting)** — web chat widget, WhatsApp channel, LangSmith tracing~~ ✅
- ~~**Step 9** — multi-tenant SaaS: Supabase Auth, Postgres RLS isolation, per-persona
  knowledge (uploads + website crawl) & generated prompts, tenant-keyed widget, admin console~~ ✅
  *(phase 1: web widget; Telegram/WhatsApp and booking stay single-tenant for now)*
- ~~**Step 10** — console UI overhaul + landing page, per-persona widget theming
  (brand color, images), live dashboard via websockets, lint/CI tooling~~ ✅
- ~~**Step 11** — structured business catalog: LLM extraction of services/products (with
  verbatim pricing), guidelines, and content from ingested knowledge into editable tables
  (`catalog_items`, `business_snippets`), auto-run after each ingest with a re-extract
  endpoint; console **Catalog** page (tabbed, inline editing, user edits never overwritten
  by re-extraction); agent answers pricing/services from the catalog and follows extracted
  guidelines via the system prompt~~ ✅

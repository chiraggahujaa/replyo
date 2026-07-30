"""Structured business-catalog extraction from ingested knowledge.

RAG makes a persona's documents searchable, but the owner can't see or correct what
the assistant "knows" — a wrong price in a crawled page is invisible until a customer
gets quoted it. This module runs a second, structured pass over the SAME embedded
chunks: an LLM (temperature 0, forced schema) pulls out services, products, guidelines,
notable facts, opening hours and the standard appointment length, which land in
relational tables (catalog_items, business_snippets, business_profiles) the console can
list and edit. app/catalog.py then feeds the curated rows back into the agent's prompt
as an authoritative block, and app/booking.py books on the extracted hours/slot grid —
so a mistake here is visible and fixable in the console instead of only in a bad reply.

Design choices, and why:

  * Reads the chunks straight from the pgvector library tables rather than re-crawling
    or re-parsing sources — the text is already cleaned, chunked, and per-tenant, and
    reusing it means extraction can't disagree with what retrieval sees.
  * Batches chunks (~10k chars) and extracts per batch concurrently. A whole knowledge
    base rarely fits one context window, and per-batch failure is survivable: a failed
    batch is logged and skipped, never fatal to the run.
  * Merging is a pure function (`_merge`) so the dedupe rules are offline-testable:
    items dedupe by (kind, normalized name) keeping the richest candidate (its gaps
    coalesced from the loser), snippets by (kind, normalized title) keeping the longer
    body — length is a decent proxy for "the version with the actual details".
  * The DB upsert is ADDITIVE and edit-preserving: `on conflict … do update … where
    status = 'extracted'` refreshes machine rows but never touches a row the owner
    edited, and re-extraction never deletes — owners prune in the console, where a
    deliberate delete is distinguishable from a source that merely didn't re-mention
    something.
  * A single-statement upsert on business_profiles is the concurrent-run guard: two
    ingests finishing together both call extract_catalog, but only the one that flips
    extraction_status to 'running' proceeds. The loser doesn't vanish — it sets
    rerun_requested, and the winning run makes one more pass once it finishes, so
    knowledge embedded after the winner snapshotted its chunks still reaches the
    catalog. A 'running' older than STALE_RUN_MINUTES is treated as dead (background
    tasks die with their process, so a crash mid-run would otherwise wedge the status
    forever) and can be reclaimed. No locks, no in-process state, safe across workers.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Literal, cast

from langchain_core.messages import HumanMessage, SystemMessage
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from app.catalog import HHMM
from app.currency import DEFAULT_CURRENCY, normalize_currency
from app.llm import get_chat_model
from app.rag import collection_name
from app.tenancy import admin_connection, scoped_connection

logger = logging.getLogger("replyo.extraction")

# Cost guards. 400 chunks ≈ 320k chars ≈ 32 batches — a generous ceiling for a small
# business's knowledge base; anything beyond it is almost certainly boilerplate pages.
MAX_CHUNKS = 400
BATCH_CHARS = 10_000
MAX_CONCURRENT_BATCHES = 4

# A 'running' claim older than this is a dead run: mark_running touches updated_at at
# claim time and a max-size run (32 batches, 4 concurrent) finishes in a few minutes,
# so 15 leaves a wide margin. Used both by mark_running (reclaim) and reset_stale_run
# (surface the failure in the console).
STALE_RUN_MINUTES = 15

# Appointment length sanity bounds — a model that reads "open 9 to 5" as a slot length
# shouldn't be able to produce a 480-minute grid (one slot a day) or a 1-minute one.
MIN_SLOT_MINUTES, MAX_SLOT_MINUTES = 5, 240

EXTRACTION_PROMPT = """You extract structured business facts from a chunk of a business's \
documents or website text.

Extract ONLY facts explicitly stated in the text. NEVER infer, estimate, or invent prices, \
durations, or any other detail. If the text contains nothing extractable, return empty lists.

Definitions:
- item kind "service": something performed FOR a customer (treatments, consultations, procedures).
- item kind "product": a physical good sold to customers.
- snippet kind "guideline": a rule or policy about handling customers (cancellation policy, \
payment terms, dos-and-donts, tone rules).
- snippet kind "content": a notable general fact worth displaying (about the business, team, \
location, specialties).

Rules for items:
- price_text must QUOTE the source verbatim (e.g. "₹1,500", "from ₹500 per session"); null when \
the text states no price.
- price_amount only when the text states a single unambiguous number for the price; otherwise null.
- duration_min only when a duration is explicitly stated.
- Do not list the same service or product twice.

Rules for opening hours (the `hours` list) — one entry per weekday, and ONLY when the text \
explicitly states hours. Never guess or infer a weekday the text doesn't mention:
- weekday is 0=Monday, 1=Tuesday, ... 6=Sunday.
- Expand stated ranges into one entry per day: "Mon-Sat 9:30am-8pm" becomes six entries \
(weekday 0,1,2,3,4,5), each open "09:30" and close "20:00".
- open/close are 24-hour "HH:MM" ("9am" -> "09:00", "8pm" -> "20:00", "noon" -> "12:00").
- A day the text says is closed gets closed=true with open and close null.
- Return an empty list when the text states no hours at all.

Rules for slot_minutes:
- Only set it when the text states a standard appointment/treatment length (e.g. "appointments \
are 45 minutes", "all consultations are 20 min slots"). It is NOT the duration of one service \
and NOT the length of the working day. Otherwise null."""


# ---------------------------------------------------------------------------
# Structured-output schemas (the model is forced to fill these)
# ---------------------------------------------------------------------------

class ExtractedItem(BaseModel):
    """One service or product explicitly described in the text."""

    kind: Literal["service", "product"]
    name: str = Field(description="The service/product name as the business calls it.")
    description: str | None = Field(None, description="Short description, if stated.")
    price_text: str | None = Field(None, description="The price EXACTLY as written in the source.")
    price_amount: float | None = Field(
        None, description="Numeric price, ONLY when the source states a single unambiguous number."
    )
    currency: str | None = Field(None, description="Currency code or symbol, if stated.")
    duration_min: int | None = Field(None, description="Duration in minutes, only if stated.")
    category: str | None = Field(None, description="Grouping the source itself uses, if any.")


class ExtractedSnippet(BaseModel):
    """One guideline (customer-handling rule/policy) or content fact (display-worthy)."""

    kind: Literal["guideline", "content"]
    title: str = Field(description="Short headline for the rule or fact.")
    body: str = Field(description="The rule or fact itself, as stated in the text.")


class ExtractedHours(BaseModel):
    """Opening hours for ONE weekday, only as explicitly stated by the text.

    `closed` and open/close are mutually exclusive in practice: a stated closure sets
    closed=true and leaves the times null; a stated window sets both times. An entry
    that is neither is meaningless and gets dropped in _merge_hours.
    """

    weekday: int = Field(description="0=Monday, 1=Tuesday, ... 6=Sunday.")
    closed: bool = Field(False, description="True when the text says the business is closed that day.")
    open: str | None = Field(None, description='Opening time, 24-hour "HH:MM" (e.g. "09:30").')
    close: str | None = Field(None, description='Closing time, 24-hour "HH:MM" (e.g. "20:00").')


class ExtractionBatch(BaseModel):
    """Everything extracted from one batch of chunks. Empty lists when there's nothing."""

    items: list[ExtractedItem] = []
    snippets: list[ExtractedSnippet] = []
    hours: list[ExtractedHours] = []
    slot_minutes: int | None = Field(
        None, description="Standard appointment length in minutes, ONLY if the text states one."
    )


# ---------------------------------------------------------------------------
# Chunk access + batching
# ---------------------------------------------------------------------------

async def _all_chunks(tenant_id: str) -> list[tuple[str, str | None]]:
    """Every embedded chunk for this tenant as (text, source) — source is the chunk
    metadata's url or source (page title / filename), whichever exists.

    admin_connection is deliberate: the pgvector library tables are not under RLS (no
    tenant_id column — they're langchain-managed), so tenant scoping IS the collection
    name, exactly the trust posture of the LangGraph checkpointer. The tenant_id here
    always comes from trusted resolution upstream, never a client.
    """
    async with await admin_connection() as conn:
        rows = await (await conn.execute(
            "select e.document, e.cmetadata from langchain_pg_embedding e "
            "join langchain_pg_collection c on c.uuid = e.collection_id "
            "where c.name = %s",
            (collection_name(tenant_id),),
        )).fetchall()
    chunks: list[tuple[str, str | None]] = []
    for row in rows:
        meta = row.get("cmetadata") or {}
        if not isinstance(meta, dict):
            meta = {}
        source = meta.get("url") or meta.get("source")
        text = row.get("document") or ""
        if text.strip():
            chunks.append((text, source))
    if len(chunks) > MAX_CHUNKS:
        logger.warning(
            "Tenant %s has %d chunks; extracting only the first %d (cost guard)",
            tenant_id, len(chunks), MAX_CHUNKS,
        )
        chunks = chunks[:MAX_CHUNKS]
    return chunks


def _batches(chunks: list[tuple[str, str | None]]) -> list[list[tuple[str, str | None]]]:
    """Group consecutive chunks into ~BATCH_CHARS batches (one LLM call each)."""
    batches: list[list[tuple[str, str | None]]] = []
    current: list[tuple[str, str | None]] = []
    size = 0
    for text, source in chunks:
        if current and size + len(text) > BATCH_CHARS:
            batches.append(current)
            current, size = [], 0
        current.append((text, source))
        size += len(text)
    if current:
        batches.append(current)
    return batches


# ---------------------------------------------------------------------------
# Merging (pure — the offline-testable heart of the pipeline)
# ---------------------------------------------------------------------------

# Optional item fields that count towards "richness" and get coalesced on a merge.
# `image_url` is deliberately ABSENT, here and in _upsert's column lists: an image is
# never extracted from text, so extraction must not read, write, or resurrect one. An
# owner who deletes a product photo has deleted it, and the next run can't bring it back.
ITEM_FIELDS = ("description", "price_text", "price_amount", "currency", "duration_min", "category")


def _norm(text: str) -> str:
    """Dedupe key: lowercase, strip, collapse internal whitespace."""
    return " ".join(text.lower().split())


def _richness(item: dict) -> int:
    return sum(1 for f in ITEM_FIELDS if item.get(f) is not None)


def _merge(
    batches: list[tuple[ExtractionBatch, str | None]],
) -> tuple[list[dict], list[dict]]:
    """Dedupe extracted items/snippets across batches into upsert-ready dicts.

    Items collide on (kind, normalized name): the candidate with more non-null optional
    fields wins (ties: first seen), and the winner's remaining gaps are coalesced from
    the loser — two half-mentions of the same service add up. Snippets collide on
    (kind, normalized title): the longer body wins. Each candidate carries the source
    of the batch it came from; the winner's source is what survives.
    """
    items: dict[tuple[str, str], dict] = {}
    snippets: dict[tuple[str, str], dict] = {}

    for batch, source in batches:
        for item in batch.items:
            key = (item.kind, _norm(item.name))
            if not key[1]:
                continue
            cand = item.model_dump()
            cand["name"] = item.name.strip()
            cand["source"] = source
            # Single-currency product: whatever symbol the page used, the amount is
            # rupees (app/currency.py explains why the funnel is deliberate). An amount
            # with no stated currency is still rupees — otherwise the catalog block
            # would render a bare number.
            cand["currency"] = normalize_currency(cand.get("currency"))
            if cand["currency"] is None and cand.get("price_amount") is not None:
                cand["currency"] = DEFAULT_CURRENCY
            prev = items.get(key)
            if prev is None:
                items[key] = cand
                continue
            winner, loser = (cand, prev) if _richness(cand) > _richness(prev) else (prev, cand)
            for f in ITEM_FIELDS:
                if winner.get(f) is None and loser.get(f) is not None:
                    winner[f] = loser[f]
            if winner.get("source") is None:
                winner["source"] = loser.get("source")
            items[key] = winner

        for snippet in batch.snippets:
            key = (snippet.kind, _norm(snippet.title))
            if not key[1] or not snippet.body.strip():
                continue
            cand = snippet.model_dump()
            cand["title"] = snippet.title.strip()
            cand["source"] = source
            prev = snippets.get(key)
            if prev is None or len(cand["body"]) > len(prev["body"]):
                snippets[key] = cand

    return list(items.values()), list(snippets.values())


def _merge_hours(
    batches: list[tuple[ExtractionBatch, str | None]],
) -> tuple[dict[str, dict[str, str] | None] | None, int | None]:
    """Collapse per-batch hours/slot claims into one week + one appointment length.

    Kept beside `_merge` rather than inside it: hours are a single per-business value,
    not a list of rows, so they need none of the richness/coalesce machinery — and
    `_merge`'s signature stays stable for its existing callers and tests.

    Rules, all first-wins because later batches are later PAGES, not better evidence:
      * the first batch entry that mentions a weekday owns that weekday. An entry that
        is neither closed nor has both valid times is ignored entirely — it does NOT
        claim the day, so a good entry in a later batch can still fill it.
      * a stated closure stores null (the shape's "closed that day").
      * times must match HHMM exactly; anything else is dropped.
      * slot_minutes takes the first stated value, clamped to [5, 240].

    Returns (hours-or-None, slot-or-None); None means "nothing stated", which the
    caller must NOT write over existing data.
    """
    hours: dict[str, dict[str, str] | None] = {}
    slot: int | None = None

    for batch, _source in batches:
        for entry in batch.hours:
            if not 0 <= entry.weekday <= 6:
                continue
            key = str(entry.weekday)
            if key in hours:
                continue
            if entry.closed:
                hours[key] = None
                continue
            opens = (entry.open or "").strip()
            closes = (entry.close or "").strip()
            if not (HHMM.match(opens) and HHMM.match(closes)) or opens >= closes:
                continue
            hours[key] = {"open": opens, "close": closes}
        if slot is None and batch.slot_minutes is not None:
            slot = max(MIN_SLOT_MINUTES, min(MAX_SLOT_MINUTES, int(batch.slot_minutes)))

    return (hours or None), slot


# ---------------------------------------------------------------------------
# The run itself
# ---------------------------------------------------------------------------

async def mark_running(tenant_id: str) -> bool:
    """Flip this tenant's extraction to 'running' — False when a run is already in flight.

    One atomic statement, so two concurrent callers can't both win: the upsert only
    updates when the current status isn't 'running', and RETURNING tells us whether it
    did. A 'running' whose updated_at is older than STALE_RUN_MINUTES is reclaimed
    anyway — background tasks die with the process, so an old claim means a dead run,
    not a busy one. Claiming also clears rerun_requested: the new run will read a
    fresh chunk snapshot, which is all a pending re-run request was asking for.
    Shared by the manual-extract endpoint and the post-ingest auto-trigger.
    """
    async with await scoped_connection(tenant_id=tenant_id) as conn:
        row = await (await conn.execute(
            """insert into business_profiles (tenant_id, extraction_status)
                    values (%s, 'running')
               on conflict (tenant_id) do update
                      set extraction_status = 'running', rerun_requested = false,
                          updated_at = now()
                    where business_profiles.extraction_status <> 'running'
                       or business_profiles.updated_at < now() - make_interval(mins => %s)
                returning tenant_id""",
            (tenant_id, STALE_RUN_MINUTES),
        )).fetchone()
    return row is not None


async def reset_stale_run(tenant_id: str) -> None:
    """Coerce a dead 'running' (older than STALE_RUN_MINUTES) to 'error'.

    Called from the catalog GET so a run killed by a restart unwedges the console on
    the next load instead of showing 'Extracting…' forever. mark_running can already
    reclaim the stale row, but nothing re-triggers extraction on its own — the owner
    has to see the failure to click re-extract.
    """
    async with await scoped_connection(tenant_id=tenant_id) as conn:
        await conn.execute(
            """update business_profiles
                  set extraction_status = 'error',
                      extraction_error  = 'Extraction was interrupted — run it again.',
                      updated_at        = now()
                where tenant_id = %s
                  and extraction_status = 'running'
                  and updated_at < now() - make_interval(mins => %s)""",
            (tenant_id, STALE_RUN_MINUTES),
        )


async def _request_rerun(tenant_id: str) -> bool:
    """Ask the in-flight run for one more pass — False when no run is in flight.

    The losing side of the mark_running race calls this so its freshly-embedded chunks
    aren't silently dropped: the winner snapshotted the chunk set when it claimed the
    run, so anything embedded after that snapshot would otherwise be missing from the
    catalog until a manual re-extract. False means the run finished between the two
    statements — the caller should just claim the run itself.
    """
    async with await scoped_connection(tenant_id=tenant_id) as conn:
        row = await (await conn.execute(
            "update business_profiles set rerun_requested = true "
            "where tenant_id = %s and extraction_status = 'running' returning tenant_id",
            (tenant_id,),
        )).fetchone()
    return row is not None


async def _claim_rerun(tenant_id: str) -> bool:
    """Atomically consume a pending re-run request, re-claiming 'running' — False when none."""
    async with await scoped_connection(tenant_id=tenant_id) as conn:
        row = await (await conn.execute(
            "update business_profiles set rerun_requested = false, "
            "extraction_status = 'running', updated_at = now() "
            "where tenant_id = %s and rerun_requested returning tenant_id",
            (tenant_id,),
        )).fetchone()
    return row is not None


async def _run_batch(
    chunks: list[tuple[str, str | None]], sem: asyncio.Semaphore
) -> tuple[ExtractionBatch, str | None] | None:
    """One structured LLM call over one batch. Returns None on failure (logged, skipped)."""
    text = "\n\n---\n\n".join(t for t, _ in chunks)
    source = next((s for _, s in chunks if s), None)
    async with sem:
        try:
            model = get_chat_model(temperature=0.0).with_structured_output(ExtractionBatch)
            result = await model.ainvoke(
                [SystemMessage(content=EXTRACTION_PROMPT), HumanMessage(content=text)]
            )
            if result is None:
                # with_structured_output returns None when the model emits no parsable
                # tool call — a batch-local failure, handled exactly like an exception
                # (skipped), not something that should fail the whole run in _merge.
                logger.warning(
                    "Extraction batch returned no structured output (%d chunks) — skipping",
                    len(chunks),
                )
                return None
            return cast(ExtractionBatch, result), source
        except Exception:
            logger.exception("Extraction batch failed (%d chunks) — skipping", len(chunks))
            return None


async def _upsert(tenant_id: str, items: list[dict], snippets: list[dict]) -> None:
    """Additive, edit-preserving upsert of the merged results.

    `where status = 'extracted'` is the owner's shield: a row they edited keeps their
    values verbatim, no matter what the next extraction claims. Nothing is ever deleted
    here — pruning is a console action, so a source that stops mentioning a service
    can't silently drop it from the catalog.
    """
    async with await scoped_connection(tenant_id=tenant_id) as conn:
        for item in items:
            await conn.execute(
                """insert into catalog_items
                       (tenant_id, kind, name, description, price_text, price_amount,
                        currency, duration_min, category, source)
                   values (%(tenant_id)s, %(kind)s, %(name)s, %(description)s, %(price_text)s,
                           %(price_amount)s, %(currency)s, %(duration_min)s, %(category)s,
                           %(source)s)
                   on conflict (tenant_id, kind, lower(name)) do update
                          set description  = coalesce(excluded.description,  catalog_items.description),
                              price_text   = coalesce(excluded.price_text,   catalog_items.price_text),
                              price_amount = coalesce(excluded.price_amount, catalog_items.price_amount),
                              currency     = coalesce(excluded.currency,     catalog_items.currency),
                              duration_min = coalesce(excluded.duration_min, catalog_items.duration_min),
                              category     = coalesce(excluded.category,     catalog_items.category),
                              source       = coalesce(excluded.source,       catalog_items.source),
                              updated_at   = now()
                        where catalog_items.status = 'extracted'""",
                {**item, "tenant_id": tenant_id},
            )
        for snippet in snippets:
            await conn.execute(
                """insert into business_snippets (tenant_id, kind, title, body, source)
                   values (%(tenant_id)s, %(kind)s, %(title)s, %(body)s, %(source)s)
                   on conflict (tenant_id, kind, lower(title)) do update
                          set body       = excluded.body,
                              source     = coalesce(excluded.source, business_snippets.source),
                              updated_at = now()
                        where business_snippets.status = 'extracted'""",
                {**snippet, "tenant_id": tenant_id},
            )


async def _finish(
    tenant_id: str, *, error: str | None,
    hours: dict[str, dict[str, str] | None] | None = None,
    slot_minutes: int | None = None,
) -> None:
    """Record the run's outcome, and (on success) the extracted hours/settings.

    Two separate statements per column pair, each guarded by its own `…_status =
    'extracted'`, exactly like catalog_items' upsert: an owner who edited their hours
    keeps them verbatim no matter what the next run reads off a stale page. `coalesce`
    is the second half of that shield — a run that found no hours leaves the previous
    value alone instead of nulling the week. The run-state UPDATE is unconditional and
    last, so extraction_status/last_extracted_at are written even when both curated
    writes matched nothing.
    """
    async with await scoped_connection(tenant_id=tenant_id) as conn:
        if error is None:
            await conn.execute(
                """update business_profiles
                      set hours      = coalesce(%(hours)s, business_profiles.hours),
                          updated_at = now()
                    where tenant_id = %(tenant_id)s and hours_status = 'extracted'""",
                {"tenant_id": tenant_id, "hours": Jsonb(hours) if hours is not None else None},
            )
            await conn.execute(
                """update business_profiles
                      set slot_minutes = coalesce(%(slot)s, business_profiles.slot_minutes),
                          updated_at   = now()
                    where tenant_id = %(tenant_id)s and settings_status = 'extracted'""",
                {"tenant_id": tenant_id, "slot": slot_minutes},
            )
            await conn.execute(
                "update business_profiles set extraction_status = 'done', extraction_error = null, "
                "last_extracted_at = now(), updated_at = now() where tenant_id = %s",
                (tenant_id,),
            )
        else:
            await conn.execute(
                "update business_profiles set extraction_status = 'error', extraction_error = %s, "
                "updated_at = now() where tenant_id = %s",
                (error, tenant_id),
            )


async def extract_catalog(tenant_id: str, *, already_marked: bool = False) -> None:
    """Extract the structured catalog for one tenant (runs as a background task).

    `already_marked=True` is for callers that just claimed the run themselves via
    mark_running (the manual endpoint) — everyone else (the post-ingest auto-trigger)
    goes through the guard here, so concurrent finishes collapse to one runner. Losing
    the guard doesn't drop the work: the loser flags rerun_requested, and the run in
    flight makes one more pass over the (by then complete) chunk set after it
    finishes, so an ingest that lands mid-run still reaches the catalog.

    Runs outside any request (like followups' worker path), but every table it writes
    has a tenant context, so all writes go through scoped connections; only the chunk
    read needs admin (see _all_chunks).
    """
    if not already_marked:
        while not await mark_running(tenant_id):
            if await _request_rerun(tenant_id):
                logger.info(
                    "Extraction already running for tenant %s — re-run requested", tenant_id
                )
                return
            # The run finished between the two statements — loop and claim it ourselves.
    while True:
        try:
            chunks = await _all_chunks(tenant_id)
            sem = asyncio.Semaphore(MAX_CONCURRENT_BATCHES)
            results = await asyncio.gather(*(_run_batch(b, sem) for b in _batches(chunks)))
            done = [r for r in results if r is not None]
            items, snippets = _merge(done)
            hours, slot_minutes = _merge_hours(done)
            await _upsert(tenant_id, items, snippets)
            await _finish(tenant_id, error=None, hours=hours, slot_minutes=slot_minutes)
            logger.info(
                "Extracted catalog for tenant %s: %d items, %d snippets, hours for %d days, "
                "slot=%s, from %d chunks",
                tenant_id, len(items), len(snippets), len(hours or {}), slot_minutes, len(chunks),
            )
        except Exception as exc:
            logger.exception("Catalog extraction failed for tenant %s", tenant_id)
            try:
                await _finish(tenant_id, error=str(exc)[:500])
            except Exception:
                logger.exception("Could not record extraction error for tenant %s", tenant_id)
            # A pending re-run request (if any) is deliberately not honored after a
            # failure: the status is 'error', the console shows it, and the next
            # ingest or manual extract clears the flag when it claims the run.
            return
        try:
            if not await _claim_rerun(tenant_id):
                return
        except Exception:
            # Never raise out of a background task over a flag check; the run itself
            # finished 'done', and an unhonored request is recovered by the next run.
            logger.exception("Could not check the re-run flag for tenant %s", tenant_id)
            return
        logger.info("Knowledge changed mid-run — extracting again for tenant %s", tenant_id)

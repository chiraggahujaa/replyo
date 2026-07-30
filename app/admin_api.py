"""Tenant-management API — everything the dashboard drives.

All routes require a signed-in user (get_current_user). Anything about a specific
persona additionally goes through `_require_tenant`, which is the authorization
chokepoint: it 404s unless the user is a member, so a member of persona A can never
read or mutate persona B. Knowledge ingestion (upload/crawl) is slow, so it's kicked
off as a background task; the dashboard follows the source's status live over the
admin websocket (each status UPDATE fires the admin_change_notify trigger), polling
only as the fallback.
"""

from __future__ import annotations

import base64
import json
import logging
import uuid
from typing import Literal

import psycopg.errors
from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, Query, UploadFile
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field, field_validator

from app import extraction, storage
from app.catalog import HHMM
from app.config import settings
from app.currency import CURRENCY_CODES
from app.knowledge import ingest_upload, ingest_website
from app.persona import generate_system_prompt
from app.rag import build_store
from app.tenancy import (
    DEMO_TENANT_ID,
    User,
    create_tenant,
    get_current_user,
    list_user_tenants,
    scoped_connection,
    tenant_for_user,
)
from app.widget_config import cache_invalidate, sanitize_widget_config

logger = logging.getLogger("replyo.admin")

router = APIRouter(prefix="/api", tags=["admin"])


# ---------------------------------------------------------------------------
# request/response models
# ---------------------------------------------------------------------------

class CreatePersona(BaseModel):
    name: str = Field(..., min_length=1)
    timezone: str = "UTC"


class UpdatePersona(BaseModel):
    name: str | None = None
    system_prompt: str | None = None
    extra_notes: str | None = None
    onboarding_status: str | None = None
    # Lifecycle: paused personas keep their console but the public widget answers with
    # an "unavailable" notice and follow-ups skip them. Literal so nothing else can be
    # written into the column (it's CHECK-constrained anyway; fail at 422, not 500).
    status: Literal["active", "paused"] | None = None
    # Widget appearance (name + styling) from the Install page. Sanitized on write;
    # `{}` is the reset (embeds fall back to defaults + the persona's name).
    widget_config: dict | None = None


class AddWebsite(BaseModel):
    url: str
    # Extra "important" URLs the owner wants crawled for certain (deep pages a crawler
    # might not reach on its own). Always crawled first.
    extra_urls: list[str] = []


class GeneratePrompt(BaseModel):
    name: str
    notes: str = ""


def _not_blank(value: str | None) -> str | None:
    """Shared validator body: strip, and reject a value that's only whitespace."""
    if value is None:
        return None
    value = value.strip()
    if not value:
        raise ValueError("must not be blank")
    return value


def _valid_currency(value: str | None) -> str | None:
    """Shared validator body: a supported currency code, or None/blank to clear it.

    Replyo is single-currency (app/currency.py) and catalog_items has a matching CHECK,
    so an unsupported code has to fail at the edge with a readable 422 rather than as a
    500 from the database. Blank means "no currency stated", which is a legitimate value.
    """
    if value is None:
        return None
    code = value.strip().upper()
    if not code:
        return None
    if code not in CURRENCY_CODES:
        raise ValueError(f"must be one of: {', '.join(sorted(CURRENCY_CODES))}")
    return code


class CreateCatalogItem(BaseModel):
    kind: Literal["service", "product"]
    name: str = Field(..., max_length=200)
    description: str | None = Field(None, max_length=2000)
    price_text: str | None = Field(None, max_length=100)
    price_amount: float | None = Field(None, ge=0)
    currency: str | None = Field(None, max_length=50)
    duration_min: int | None = Field(None, ge=1, le=600)
    category: str | None = Field(None, max_length=50)

    _name_not_blank = field_validator("name")(_not_blank)
    _currency_supported = field_validator("currency")(_valid_currency)


class UpdateCatalogItem(BaseModel):
    """PATCH body: any subset of the create fields (unset fields are left untouched)."""

    kind: Literal["service", "product"] | None = None
    name: str | None = Field(None, max_length=200)
    description: str | None = Field(None, max_length=2000)
    price_text: str | None = Field(None, max_length=100)
    price_amount: float | None = Field(None, ge=0)
    currency: str | None = Field(None, max_length=50)
    duration_min: int | None = Field(None, ge=1, le=600)
    category: str | None = Field(None, max_length=50)

    _name_not_blank = field_validator("name")(_not_blank)
    _currency_supported = field_validator("currency")(_valid_currency)


class UpdateBusinessSettings(BaseModel):
    """PATCH body for the opening hours + appointment settings (business_profiles).

    Any subset; an omitted field is left untouched. Editing `hours` flips
    hours_status to 'edited' and editing slot/buffer flips settings_status, which is what
    stops the next extraction run from overwriting the owner's word (see app/extraction.py
    _finish). `hours` uses the stored shape — weekday index as a STRING key, null for a
    closed day — validated here so nothing malformed can reach the jsonb column.
    """

    hours: dict[str, dict[str, str] | None] | None = None
    slot_minutes: int | None = Field(None, ge=5, le=240)
    buffer_minutes: int | None = Field(None, ge=0, le=120)

    @field_validator("hours")
    @classmethod
    def _valid_hours(cls, value: dict | None) -> dict | None:
        if value is None:
            return None
        cleaned: dict[str, dict[str, str] | None] = {}
        for key, window in value.items():
            if key not in {"0", "1", "2", "3", "4", "5", "6"}:
                raise ValueError('keys must be weekday indexes as strings, "0" (Mon) .. "6" (Sun)')
            if window is None:
                cleaned[key] = None  # closed that day
                continue
            opens, closes = str(window.get("open", "")), str(window.get("close", ""))
            if not (HHMM.match(opens) and HHMM.match(closes)):
                raise ValueError(f'day {key}: open/close must be 24-hour "HH:MM"')
            if opens >= closes:
                raise ValueError(f"day {key}: close must be later than open")
            cleaned[key] = {"open": opens, "close": closes}
        return cleaned


class CreateSnippet(BaseModel):
    kind: Literal["guideline", "content"]
    title: str = Field(..., max_length=200)
    body: str = Field(..., max_length=5000)

    _not_blank = field_validator("title", "body")(_not_blank)


class UpdateSnippet(BaseModel):
    title: str | None = Field(None, max_length=200)
    body: str | None = Field(None, max_length=5000)

    _not_blank = field_validator("title", "body")(_not_blank)


async def _require_tenant(
    user: User = Depends(get_current_user), x_tenant_id: str = Header(..., alias="X-Tenant-Id")
) -> dict:
    """The active persona, or 404 unless the user is a member (the authz chokepoint)."""
    return await tenant_for_user(user, x_tenant_id)


# ---------------------------------------------------------------------------
# personas
# ---------------------------------------------------------------------------

@router.get("/personas")
async def personas(user: User = Depends(get_current_user)) -> list[dict]:
    """The signed-in user's personas — drives the switcher."""
    return await list_user_tenants(user)


@router.post("/personas", status_code=201)
async def create(body: CreatePersona, user: User = Depends(get_current_user)) -> dict:
    return await create_tenant(user, name=body.name, timezone=body.timezone)


@router.get("/personas/active")
async def active(tenant: dict = Depends(_require_tenant)) -> dict:
    """Full detail for the active persona (prompt, notes, key, status)."""
    return tenant


@router.patch("/personas/active")
async def update(
    body: UpdatePersona,
    user: User = Depends(get_current_user),
    tenant: dict = Depends(_require_tenant),
) -> dict:
    # The `tenants` table is USER-scoped by RLS (is_tenant_member -> app.user_id), so the
    # connection needs the user id too — with tenant_id alone the UPDATE matches no rows
    # and RETURNING comes back empty. (Data tables are tenant-scoped; this one is not.)
    fields = {k: v for k, v in body.model_dump(exclude_none=True).items()}
    if not fields:
        return tenant
    if "widget_config" in fields:
        # Whitelist keys + clamp values, and wrap for the jsonb column.
        fields["widget_config"] = Jsonb(sanitize_widget_config(fields["widget_config"]))
    sets = ", ".join(f"{k} = %s" for k in fields) + ", updated_at = now()"
    params = list(fields.values()) + [str(tenant["id"])]
    async with await scoped_connection(user_id=user.id, tenant_id=str(tenant["id"])) as conn:
        row = await (await conn.execute(
            # Column names come from the whitelisted pydantic model, never the client —
            # the dynamic SQL is trusted (pyright can't see that, hence the ignore).
            f"update tenants set {sets} where id = %s returning *",  # pyright: ignore[reportArgumentType]
            tuple(params),
        )).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Persona not found")
    if "widget_config" in fields or "name" in fields:
        # Drop the public config cache so embeds see the change next load ("" is the
        # demo-fallback entry, used when a tag carries no tenant key).
        cache_invalidate(row["public_key"])
        cache_invalidate("")
    return row


@router.post("/personas/active/generate-prompt")
async def generate(body: GeneratePrompt, tenant: dict = Depends(_require_tenant)) -> dict:
    """Synthesise a system prompt from the notes + already-ingested knowledge. Returns it
    for the user to review/edit; saving is a separate PATCH so hand-edits are never clobbered."""
    prompt = await generate_system_prompt(
        tenant_id=str(tenant["id"]), name=body.name, notes=body.notes
    )
    return {"system_prompt": prompt}


def _drop_vector_collection(tenant_id: str) -> None:
    """Best-effort removal of a deleted persona's pgvector collection. The collection is
    library-managed (no FK to tenants), so the row cascade can't reach it; sync SQLAlchemy
    under the hood, so it runs as a background task (FastAPI threads sync tasks). A failure
    only strands unreachable vectors — the collection is named by the now-deleted id."""
    try:
        build_store(tenant_id).delete_collection()
    except Exception:
        logger.exception("Could not drop vector collection for deleted persona %s", tenant_id)


@router.delete("/personas/active", status_code=204)
async def delete_persona(
    background: BackgroundTasks,
    user: User = Depends(get_current_user),
    tenant: dict = Depends(_require_tenant),
) -> None:
    """Permanently delete the active persona (knowledge, reviews, follow-ups cascade).

    RLS is the authorization: the tenants_delete policy only matches for an OWNER, so a
    plain member's DELETE touches 0 rows -> 403. LangGraph checkpointer threads are left
    behind on purpose — their ids embed the tenant id, and with the tenant (and its
    public key) gone no request can resolve to them again.
    """
    tid = str(tenant["id"])
    if tid == DEMO_TENANT_ID:
        raise HTTPException(400, "The demo persona is shared infrastructure and cannot be deleted.")
    async with await scoped_connection(user_id=user.id, tenant_id=tid) as conn:
        row = await (await conn.execute(
            "delete from tenants where id = %s returning id", (tid,)
        )).fetchone()
    if not row:
        raise HTTPException(403, "Only an owner can delete a persona.")
    # Embeds must stop resolving the key now (this process), not after the cache TTL.
    cache_invalidate(tenant["public_key"])
    background.add_task(_drop_vector_collection, tid)


# ---------------------------------------------------------------------------
# knowledge sources
# ---------------------------------------------------------------------------

@router.get("/personas/active/knowledge")
async def list_knowledge(tenant: dict = Depends(_require_tenant)) -> list[dict]:
    async with await scoped_connection(tenant_id=str(tenant["id"])) as conn:
        return await (await conn.execute(
            "select * from knowledge_sources where tenant_id = %s order by created_at",
            (str(tenant["id"]),),
        )).fetchall()


@router.post("/personas/active/knowledge/upload", status_code=202)
async def upload(
    background: BackgroundTasks,
    file: UploadFile,
    tenant: dict = Depends(_require_tenant),
) -> dict:
    """Accept a .txt/.md document; embed it in the background."""
    raw = await file.read()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise HTTPException(400, "Only UTF-8 text files (.txt/.md) are supported for now.") from None
    if not text.strip():
        raise HTTPException(400, "The file appears to be empty.")

    tid = str(tenant["id"])
    async with await scoped_connection(tenant_id=tid) as conn:
        row = await (await conn.execute(
            "insert into knowledge_sources (tenant_id, kind, name, status) "
            "values (%s, 'upload', %s, 'pending') returning *",
            (tid, file.filename or "document"),
        )).fetchone()
    assert row is not None  # INSERT .. RETURNING always yields the new row

    background.add_task(
        ingest_upload, tenant_id=tid, source_id=str(row["id"]), name=row["name"], text=text
    )
    return row


@router.post("/personas/active/knowledge/website", status_code=202)
async def add_website(
    body: AddWebsite, background: BackgroundTasks, tenant: dict = Depends(_require_tenant)
) -> dict:
    """Register a website source; deep-crawl + embed it in the background."""
    if not body.url.startswith("http"):
        raise HTTPException(400, "URL must start with http(s)://")

    tid = str(tenant["id"])
    async with await scoped_connection(tenant_id=tid) as conn:
        row = await (await conn.execute(
            "insert into knowledge_sources (tenant_id, kind, name, url, status) "
            "values (%s, 'website', %s, %s, 'pending') returning *",
            (tid, body.url, body.url),
        )).fetchone()
    assert row is not None  # INSERT .. RETURNING always yields the new row

    background.add_task(
        ingest_website,
        tenant_id=tid, source_id=str(row["id"]), url=body.url, extra_urls=tuple(body.extra_urls),
    )
    return row


@router.delete("/personas/active/knowledge/{source_id}", status_code=204)
async def delete_knowledge(source_id: str, tenant: dict = Depends(_require_tenant)) -> None:
    """Remove a source row. (Its already-embedded chunks are pruned on the next full
    re-ingest — per-chunk deletion is a later refinement.)"""
    async with await scoped_connection(tenant_id=str(tenant["id"])) as conn:
        await conn.execute("delete from knowledge_sources where id = %s", (source_id,))


# ---------------------------------------------------------------------------
# business catalog (structured extraction — app/extraction.py writes, this reviews)
# ---------------------------------------------------------------------------

ENTRY_KINDS = ("service", "product", "guideline", "content")
EntryKind = Literal["service", "product", "guideline", "content"]

# How many rows one scroll page carries, and the ceiling a caller may ask for. 15 is a
# screenful in the console's list; the ceiling stops a client turning "page" back into
# "load everything" (the whole point of this endpoint).
ENTRIES_LIMIT_DEFAULT = 15
ENTRIES_LIMIT_MAX = 50

# Per-table keyset recipe. `sort_sql`/`row_value` must stay character-identical in
# spirit: the ORDER BY and the WHERE comparison are built from the SAME expressions, so
# the tuple ordering and the filter can never drift apart. `extra` re-selects those
# expressions as columns (k1/k2/k3) so the cursor is built from values POSTGRES
# computed — Python's str.lower() and Postgres' lower() need not agree on every
# codepoint/collation, and a cursor built from the wrong one would skip or repeat rows.
# `key_columns` is the cursor tuple in ORDER BY order; `types` validates a decoded one.
_ENTRY_TABLES: dict[str, dict] = {
    "catalog_items": {
        "extra": "(category is null)::int as k1, coalesce(lower(category), '') as k2, "
                 "lower(name) as k3",
        "sort_sql": "(category is null)::int, coalesce(lower(category), ''), lower(name), id",
        "row_value": "((category is null)::int, coalesce(lower(category), ''), lower(name), id)",
        "placeholders": "(%s::int, %s, %s, %s::uuid)",
        "key_columns": ("k1", "k2", "k3", "id"),
        "types": (int, str, str, str),
    },
    "business_snippets": {
        "extra": "lower(title) as k2",
        "sort_sql": "sort, lower(title), id",
        "row_value": "(sort, lower(title), id)",
        "placeholders": "(%s::int, %s, %s::uuid)",
        "key_columns": ("sort", "k2", "id"),
        "types": (int, str, str),
    },
}
# service/product live in catalog_items, guideline/content in business_snippets.
_ENTRY_TABLE_FOR_KIND = {
    "service": "catalog_items", "product": "catalog_items",
    "guideline": "business_snippets", "content": "business_snippets",
}
# The k1/k2/k3 helper columns exist only to build the cursor — they are stripped before
# the row is serialized, so an entry looks exactly like the CRUD endpoints' rows.
_ENTRY_HELPER_COLUMNS = frozenset({"k1", "k2", "k3"})


def encode_cursor(values: list) -> str:
    """A page cursor: base64url(compact JSON of the last row's sort tuple), unpadded.

    JSON because the tuple mixes ints and text (and text can contain anything a name or
    title can); base64url because it travels in a query string; unpadded because '=' in
    a URL is noise. Opaque by intent — the console only ever echoes it back.
    """
    raw = json.dumps(values, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def decode_cursor(raw: str | None) -> list | None:
    """The sort tuple inside a cursor, or None if it isn't one.

    POLICY: an absent, truncated, non-base64, non-JSON or non-list cursor decodes to
    None and the caller starts from the beginning. Never an exception, never a 500, and
    deliberately not a 400 either: a cursor is a transient scroll position, and the only
    ways to get a bad one are a stale bookmark or a hand-edited URL — restarting the
    list is a strictly better answer there than an error the console has to render.
    """
    if not raw:
        return None
    try:
        padded = raw + "=" * (-len(raw) % 4)
        values = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")))
    except Exception:
        return None
    return values if isinstance(values, list) else None


def clamp_entries_limit(limit: object) -> int:
    """A page size inside 1..ENTRIES_LIMIT_MAX; anything unusable becomes the default.

    Clamped rather than rejected: `limit` is a display detail, so an out-of-range value
    should still return a usable page instead of a 422 that empties the console's list.
    """
    if isinstance(limit, bool) or not isinstance(limit, int):
        return ENTRIES_LIMIT_DEFAULT
    return max(1, min(ENTRIES_LIMIT_MAX, limit))


def _entries_page(
    rows: list[dict], limit: int, key_columns: tuple[str, ...]
) -> tuple[list[dict], str | None]:
    """Turn a limit+1 fetch into (entries, next_cursor) — the whole "is there more?" rule.

    Reading one row past the page is how `next_cursor` can be null EXACTLY when the list
    is exhausted: getting the extra row is proof another page exists, so the console
    never has to spend a request that comes back empty. The cursor is built from the last
    KEPT row (not the extra one), which is the last row the client will have seen.
    """
    kept = rows[:limit]
    next_cursor = None
    if len(rows) > limit and kept:
        last = kept[-1]
        next_cursor = encode_cursor([
            # The id is the only non-JSON-primitive in either tuple (psycopg hands back
            # a uuid.UUID); everything else is already an int or str.
            str(last[col]) if col == "id" else last[col]
            for col in key_columns
        ])
    entries = [{k: v for k, v in row.items() if k not in _ENTRY_HELPER_COLUMNS} for row in kept]
    return entries, next_cursor


def _cursor_params(raw: str | None, spec: dict) -> list | None:
    """A decoded cursor validated against this table's tuple shape, else None.

    Shape-checking here is what keeps a mismatched cursor (a snippet cursor replayed on
    an items query, say) from reaching Postgres as a type error: wrong length, wrong
    element type or a non-UUID id all mean "not a cursor for this list" -> start over.
    """
    values = decode_cursor(raw)
    types: tuple[type, ...] = spec["types"]
    if values is None or len(values) != len(types):
        return None
    for value, expected in zip(values, types, strict=True):
        if isinstance(value, bool) or not isinstance(value, expected):
            return None
    try:
        uuid.UUID(str(values[-1]))  # the id tie-breaker is bound as ::uuid
    except (ValueError, AttributeError, TypeError):
        return None
    return list(values)


@router.get("/personas/active/catalog")
async def get_catalog(tenant: dict = Depends(_require_tenant)) -> dict:
    """Catalog METADATA only — per-tab counts, extraction state, settings. No rows.

    The rows come from /catalog/entries a page at a time; a real persona already has
    tens of services and notes, and shipping all of them (with descriptions) on every
    console load is a payload that only grows. Two grouped aggregates give the tab
    badges their numbers for the price of an index scan.

    A tenant that has never extracted has no business_profiles row yet — that's the
    'idle' state, not an error. A 'running' left behind by a process that died mid-run
    is coerced to 'error' first, so the console recovers on its next load instead of
    showing an extraction that will never finish.
    """
    tid = str(tenant["id"])
    await extraction.reset_stale_run(tid)
    async with await scoped_connection(tenant_id=tid) as conn:
        item_counts = await (await conn.execute(
            "select kind, count(*) as n from catalog_items where tenant_id = %s group by kind",
            (tid,),
        )).fetchall()
        snippet_counts = await (await conn.execute(
            "select kind, count(*) as n from business_snippets where tenant_id = %s group by kind",
            (tid,),
        )).fetchall()
        profile = await (await conn.execute(
            "select * from business_profiles where tenant_id = %s", (tid,)
        )).fetchone()
    # Every kind is always present (0 when the tenant has none of it), so the console
    # renders four tabs from one shape instead of guarding each lookup.
    counts = dict.fromkeys(ENTRY_KINDS, 0)
    for row in (*item_counts, *snippet_counts):
        if row["kind"] in counts:
            counts[row["kind"]] = int(row["n"])
    return {
        "counts": counts,
        "extraction": {
            "status": profile["extraction_status"] if profile else "idle",
            "error": profile["extraction_error"] if profile else None,
            "last_extracted_at": profile["last_extracted_at"] if profile else None,
        },
        # Opening hours + appointment settings. A persona with no profile row yet reports
        # the column defaults, so the console renders one state, not two.
        "settings": {
            "hours": (profile or {}).get("hours"),
            "slot_minutes": (profile or {}).get("slot_minutes") or 30,
            "buffer_minutes": (profile or {}).get("buffer_minutes") or 0,
            "hours_status": (profile or {}).get("hours_status") or "extracted",
            "settings_status": (profile or {}).get("settings_status") or "extracted",
        },
        # Whether the image endpoints below will work at all, so the console can disable
        # the picker with an explanation instead of showing a 503 after a 5 MB upload.
        "storage_enabled": settings.storage_enabled,
    }


@router.get("/personas/active/catalog/entries")
async def get_catalog_entries(
    kind: EntryKind,
    limit: int = Query(
        ENTRIES_LIMIT_DEFAULT,
        description=f"Rows per page, clamped to 1..{ENTRIES_LIMIT_MAX}.",
    ),
    cursor: str | None = Query(
        None, description="`next_cursor` from the previous page; omit for the first page."
    ),
    tenant: dict = Depends(_require_tenant),
) -> dict:
    """One page of catalog rows for a single tab: {entries, next_cursor}.

    Ordered exactly as app/catalog.py feeds the agent — items by category (unset last)
    then name, snippets by sort then title, each with the row id as the tie-breaker that
    makes the order total (a keyset needs a unique last column, and two rows CAN share a
    name-and-category). So the owner reads the catalog in the order the assistant does.

    KEYSET, not OFFSET, and that's the point: an extraction run can be inserting rows in
    the background while the owner scrolls. With OFFSET, a row inserted above the window
    pushes everything down, so page 2 re-shows the last row of page 1 (or, on delete,
    skips a row entirely). A cursor names the last row the client actually saw, so the
    next page continues from THERE regardless of what changed above it.

    The cursor is the row's sort tuple, compared as a whole with a row-value `>` against
    the very same expressions the ORDER BY uses — one source of truth for "after this
    row", so the ordering and the filter cannot disagree. We fetch limit+1 rows and drop
    the extra: getting it proves another page exists, so `next_cursor` is null exactly
    when the list is exhausted and the console never spends a request to learn that.

    Rows are serialized exactly as the item/snippet CRUD endpoints return them (all
    columns), so the console's types are unchanged. A bad `kind` is a 422; an
    unintelligible `cursor` restarts the list (see decode_cursor).
    """
    tid = str(tenant["id"])
    table = _ENTRY_TABLE_FOR_KIND[kind]
    spec = _ENTRY_TABLES[table]
    page = clamp_entries_limit(limit)
    after = _cursor_params(cursor, spec)

    # Interpolated: only this module's own table name and its fixed sort expressions
    # (chosen by the validated `kind`). Every value — tenant, kind, cursor, limit — is
    # parameter-bound.
    keyset = f"and {spec['row_value']} > {spec['placeholders']}" if after else ""
    sql = (
        f"select *, {spec['extra']} from {table} "
        f"where tenant_id = %s and kind = %s {keyset} "
        f"order by {spec['sort_sql']} limit %s"
    )
    params = [tid, kind, *(after or []), page + 1]  # +1: the row that proves there's more
    async with await scoped_connection(tenant_id=tid) as conn:
        rows = await (await conn.execute(sql, params)).fetchall()  # pyright: ignore[reportArgumentType]

    entries, next_cursor = _entries_page(rows, page, spec["key_columns"])
    return {"entries": entries, "next_cursor": next_cursor}


@router.patch("/personas/active/catalog/settings")
async def update_business_settings(
    body: UpdateBusinessSettings, tenant: dict = Depends(_require_tenant)
) -> dict:
    """Edit the opening hours / appointment settings; the edited half becomes the owner's word.

    Two status flags, flipped independently: touching `hours` sets hours_status='edited',
    touching slot/buffer sets settings_status='edited'. From then on extraction refreshes
    only the half the owner hasn't claimed (app/extraction.py _finish). The row is
    upserted because a persona that has never run an extraction has no profile row yet —
    editing hours must not require extracting first.

    `hours: null` is the way BACK: it clears the owner's claim (hours_status='extracted')
    so the next extraction repopulates them from the documents. Without this, one stray
    save — e.g. accepting the all-closed blank week the panel seeds when nothing was
    extracted yet — would silently disable hours extraction for that persona forever,
    with no route back through the console.
    """
    fields = body.model_dump(exclude_unset=True)
    if not fields:
        return {}
    sets: list[str] = []
    params: dict[str, object] = {"tenant_id": str(tenant["id"])}
    if "hours" in fields:
        if fields["hours"] is None:
            sets.append("hours = null, hours_status = 'extracted'")
        else:
            sets.append("hours = %(hours)s, hours_status = 'edited'")
            params["hours"] = Jsonb(fields["hours"])
    for col in ("slot_minutes", "buffer_minutes"):
        if col in fields and fields[col] is not None:
            sets.append(f"{col} = %({col})s")
            params[col] = fields[col]
    if any(c in fields and fields[c] is not None for c in ("slot_minutes", "buffer_minutes")):
        sets.append("settings_status = 'edited'")

    async with await scoped_connection(tenant_id=str(tenant["id"])) as conn:
        row = await (await conn.execute(
            # Column names come from the whitelisted pydantic model, never the client.
            f"""insert into business_profiles (tenant_id) values (%(tenant_id)s)
                on conflict (tenant_id) do update
                       set {", ".join(sets)}, updated_at = now()
                 returning *""",  # pyright: ignore[reportArgumentType]
            params,
        )).fetchone()
    if not row:
        # The INSERT branch won (first ever edit): the row now exists with defaults, so
        # re-run to apply the values on the conflict path.
        async with await scoped_connection(tenant_id=str(tenant["id"])) as conn:
            row = await (await conn.execute(
                f"update business_profiles set {', '.join(sets)}, updated_at = now() "  # pyright: ignore[reportArgumentType]
                "where tenant_id = %(tenant_id)s returning *",
                params,
            )).fetchone()
    if not row:
        raise HTTPException(404, "Persona not found")
    return row


@router.post("/personas/active/catalog/items", status_code=201)
async def create_catalog_item(
    body: CreateCatalogItem, tenant: dict = Depends(_require_tenant)
) -> dict:
    """Hand-added items are the owner's word from birth: status='edited', so a later
    extraction run can never overwrite them."""
    tid = str(tenant["id"])
    async with await scoped_connection(tenant_id=tid) as conn:
        try:
            row = await (await conn.execute(
                "insert into catalog_items (tenant_id, kind, name, description, price_text, "
                "price_amount, currency, duration_min, category, status) "
                "values (%s, %s, %s, %s, %s, %s, %s, %s, %s, 'edited') returning *",
                (tid, body.kind, body.name, body.description, body.price_text,
                 body.price_amount, body.currency, body.duration_min, body.category),
            )).fetchone()
        except psycopg.errors.UniqueViolation:
            raise HTTPException(409, f"A {body.kind} named {body.name!r} already exists.") from None
    assert row is not None  # INSERT .. RETURNING always yields the new row
    return row


@router.patch("/personas/active/catalog/items/{item_id}")
async def update_catalog_item(
    item_id: str, body: UpdateCatalogItem, tenant: dict = Depends(_require_tenant)
) -> dict:
    """Apply any subset of fields; the row becomes (or stays) status='edited'."""
    fields = body.model_dump(exclude_unset=True)
    for col in ("kind", "name"):  # NOT NULL columns — an explicit null isn't a clear
        if col in fields and fields[col] is None:
            fields.pop(col)
    sets = "".join(f"{k} = %s, " for k in fields) + "status = 'edited', updated_at = now()"
    params = [*fields.values(), item_id, str(tenant["id"])]
    async with await scoped_connection(tenant_id=str(tenant["id"])) as conn:
        try:
            row = await (await conn.execute(
                # Column names come from the whitelisted pydantic model, never the
                # client — the dynamic SQL is trusted (hence the pyright ignore).
                f"update catalog_items set {sets} where id = %s and tenant_id = %s returning *",  # pyright: ignore[reportArgumentType]
                tuple(params),
            )).fetchone()
        except psycopg.errors.UniqueViolation:
            raise HTTPException(409, "An item of that kind with that name already exists.") from None
    if not row:
        raise HTTPException(404, "Catalog item not found")
    return row


@router.delete("/personas/active/catalog/items/{item_id}", status_code=204)
async def delete_catalog_item(item_id: str, tenant: dict = Depends(_require_tenant)) -> None:
    """Remove the row, then its stored image — deleting a product must not orphan its file."""
    tid = str(tenant["id"])
    async with await scoped_connection(tenant_id=tid) as conn:
        # RETURNING gives us the URL of a row we definitely deleted, so we never delete an
        # object that is still referenced (and read+delete can't race each other).
        row = await (await conn.execute(
            "delete from catalog_items where id = %s and tenant_id = %s returning image_url",
            (item_id, tid),
        )).fetchone()
    if row and row["image_url"]:
        # Best-effort and last: the owner asked for the row to be gone, and it is. An
        # unreachable bucket must not turn a successful delete into a 500 (the helper
        # logs and swallows), it just leaves a few KB behind.
        await storage.delete_catalog_image(row["image_url"])


# --- product images (Supabase Storage; app/storage.py owns the bucket calls) -------

@router.post("/personas/active/catalog/items/{item_id}/image")
async def upload_catalog_item_image(
    item_id: str, file: UploadFile, tenant: dict = Depends(_require_tenant)
) -> dict:
    """Store one product photo and point the row at its CDN URL.

    Order matters: upload first, then flip the column, then delete the OLD object. A
    failure at any earlier step therefore leaves the item showing the picture it had, and
    the worst case is an orphaned file rather than a row pointing at nothing.

    The image is only ever attached to a product (a service has no photo slot in the
    widget), and the file itself is validated by app/storage.py — its ValueError is the
    operator's/owner's problem (400 with the message), StorageNotConfigured is the
    deployment's (503), and a refusal from Storage itself is an upstream failure (502).
    """
    tid = str(tenant["id"])
    async with await scoped_connection(tenant_id=tid) as conn:
        row = await (await conn.execute(
            "select kind, image_url from catalog_items where id = %s and tenant_id = %s",
            (item_id, tid),
        )).fetchone()
    if not row:
        raise HTTPException(404, "Catalog item not found")
    if row["kind"] != "product":
        raise HTTPException(400, "Images are only supported for products")
    if not settings.storage_enabled:
        # Checked before reading the body so a misconfigured deployment answers instantly
        # instead of after a 5 MB upload.
        raise HTTPException(
            503,
            "Image storage is not configured — set SUPABASE_SERVICE_ROLE_KEY and run "
            "scripts/setup_storage.py.",
        )

    data = await file.read()
    try:
        url = await storage.upload_catalog_image(tenant_id=tid, item_id=item_id, data=data)
    except storage.StorageNotConfigured as exc:  # a RuntimeError — must precede that arm
        raise HTTPException(503, str(exc)) from None
    except ValueError as exc:  # empty / too large / not a PNG-JPEG-WebP
        raise HTTPException(400, str(exc)) from None
    except RuntimeError as exc:  # Storage answered 4xx/5xx — not the caller's fault
        raise HTTPException(502, str(exc)) from None

    async with await scoped_connection(tenant_id=tid) as conn:
        updated = await (await conn.execute(
            "update catalog_items set image_url = %s, status = 'edited', updated_at = now() "
            "where id = %s and tenant_id = %s returning *",
            (url, item_id, tid),
        )).fetchone()
    if not updated:
        # The item was deleted while we were uploading: bin the object we just wrote.
        await storage.delete_catalog_image(url)
        raise HTTPException(404, "Catalog item not found")
    if row["image_url"] and row["image_url"] != url:
        await storage.delete_catalog_image(row["image_url"])
    return updated


@router.delete("/personas/active/catalog/items/{item_id}/image")
async def delete_catalog_item_image(
    item_id: str, tenant: dict = Depends(_require_tenant)
) -> dict:
    """Clear a product's photo (row first, object after) and return the updated item."""
    tid = str(tenant["id"])
    async with await scoped_connection(tenant_id=tid) as conn:
        # RETURNING gives the NEW row (image_url already null), so the old URL is read
        # first — in the same connection, so both statements share the tenant scope.
        previous = await (await conn.execute(
            "select image_url from catalog_items where id = %s and tenant_id = %s",
            (item_id, tid),
        )).fetchone()
        row = await (await conn.execute(
            "update catalog_items set image_url = null, status = 'edited', updated_at = now() "
            "where id = %s and tenant_id = %s returning *",
            (item_id, tid),
        )).fetchone()
    if not row:
        raise HTTPException(404, "Catalog item not found")
    if previous and previous["image_url"]:
        await storage.delete_catalog_image(previous["image_url"])
    return row


@router.post("/personas/active/catalog/snippets", status_code=201)
async def create_snippet(body: CreateSnippet, tenant: dict = Depends(_require_tenant)) -> dict:
    tid = str(tenant["id"])
    async with await scoped_connection(tenant_id=tid) as conn:
        try:
            row = await (await conn.execute(
                "insert into business_snippets (tenant_id, kind, title, body, status) "
                "values (%s, %s, %s, %s, 'edited') returning *",
                (tid, body.kind, body.title, body.body),
            )).fetchone()
        except psycopg.errors.UniqueViolation:
            raise HTTPException(409, f"A {body.kind} titled {body.title!r} already exists.") from None
    assert row is not None  # INSERT .. RETURNING always yields the new row
    return row


@router.patch("/personas/active/catalog/snippets/{snippet_id}")
async def update_snippet(
    snippet_id: str, body: UpdateSnippet, tenant: dict = Depends(_require_tenant)
) -> dict:
    fields = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
    sets = "".join(f"{k} = %s, " for k in fields) + "status = 'edited', updated_at = now()"
    params = [*fields.values(), snippet_id, str(tenant["id"])]
    async with await scoped_connection(tenant_id=str(tenant["id"])) as conn:
        try:
            row = await (await conn.execute(
                # Whitelisted column names again — trusted dynamic SQL.
                f"update business_snippets set {sets} where id = %s and tenant_id = %s returning *",  # pyright: ignore[reportArgumentType]
                tuple(params),
            )).fetchone()
        except psycopg.errors.UniqueViolation:
            raise HTTPException(409, "A snippet of that kind with that title already exists.") from None
    if not row:
        raise HTTPException(404, "Snippet not found")
    return row


@router.delete("/personas/active/catalog/snippets/{snippet_id}", status_code=204)
async def delete_snippet(snippet_id: str, tenant: dict = Depends(_require_tenant)) -> None:
    async with await scoped_connection(tenant_id=str(tenant["id"])) as conn:
        await conn.execute("delete from business_snippets where id = %s", (snippet_id,))


@router.post("/personas/active/catalog/extract", status_code=202)
async def extract_catalog_now(
    background: BackgroundTasks, tenant: dict = Depends(_require_tenant)
) -> dict:
    """Kick off (or join) a structured extraction run over the ingested knowledge.

    409 only when there is nothing ready to extract from. Otherwise idempotent: the
    single-statement guard in extraction.mark_running decides whether we schedule a
    run or one is already in flight — either way the client's desired state ('an
    extraction is running') is true, so both answers are 202.
    """
    tid = str(tenant["id"])
    async with await scoped_connection(tenant_id=tid) as conn:
        ready = await (await conn.execute(
            "select 1 from knowledge_sources where tenant_id = %s and status = 'ready' limit 1",
            (tid,),
        )).fetchone()
    if not ready:
        raise HTTPException(409, "Add knowledge first")
    if await extraction.mark_running(tid):
        # We just claimed the run, so the task skips its own guard (already_marked) —
        # scheduled exactly like the knowledge upload route schedules ingest.
        background.add_task(extraction.extract_catalog, tid, already_marked=True)
    return {"status": "running"}

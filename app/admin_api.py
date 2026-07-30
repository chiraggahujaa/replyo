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

import logging
from typing import Literal

import psycopg.errors
from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, UploadFile
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field, field_validator

from app import extraction
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

@router.get("/personas/active/catalog")
async def get_catalog(tenant: dict = Depends(_require_tenant)) -> dict:
    """Everything the catalog console shows: items, snippets, and the extraction state.

    A tenant that has never extracted has no business_profiles row yet — that's the
    'idle' state, not an error. A 'running' left behind by a process that died mid-run
    is coerced to 'error' first, so the console recovers on its next load instead of
    showing an extraction that will never finish.
    """
    tid = str(tenant["id"])
    await extraction.reset_stale_run(tid)
    async with await scoped_connection(tenant_id=tid) as conn:
        items = await (await conn.execute(
            "select * from catalog_items where tenant_id = %s "
            "order by kind, category nulls last, lower(name)",
            (tid,),
        )).fetchall()
        snippets = await (await conn.execute(
            "select * from business_snippets where tenant_id = %s "
            "order by kind, sort, lower(title)",
            (tid,),
        )).fetchall()
        profile = await (await conn.execute(
            "select * from business_profiles where tenant_id = %s", (tid,)
        )).fetchone()
    return {
        "items": items,
        "snippets": snippets,
        "extraction": {
            "status": profile["extraction_status"] if profile else "idle",
            "error": profile["extraction_error"] if profile else None,
            "last_extracted_at": profile["last_extracted_at"] if profile else None,
        },
    }


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
    async with await scoped_connection(tenant_id=str(tenant["id"])) as conn:
        await conn.execute("delete from catalog_items where id = %s", (item_id,))


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

"""Tenant-management API — everything the dashboard drives.

All routes require a signed-in user (get_current_user). Anything about a specific
persona additionally goes through `_require_tenant`, which is the authorization
chokepoint: it 404s unless the user is a member, so a member of persona A can never
read or mutate persona B. Knowledge ingestion (upload/crawl) is slow, so it's kicked
off as a background task and the dashboard polls the source's status.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, UploadFile
from pydantic import BaseModel, Field

from app.knowledge import ingest_upload, ingest_website
from app.persona import generate_system_prompt
from app.tenancy import (
    User,
    create_tenant,
    get_current_user,
    list_user_tenants,
    scoped_connection,
    tenant_for_user,
)

router = APIRouter(prefix="/api", tags=["admin"])


# ---------------------------------------------------------------------------
# request/response models
# ---------------------------------------------------------------------------

class CreatePersona(BaseModel):
    name: str = Field(..., min_length=1)
    timezone: str = "UTC"


class UpdatePersona(BaseModel):
    name: Optional[str] = None
    system_prompt: Optional[str] = None
    extra_notes: Optional[str] = None
    onboarding_status: Optional[str] = None


class AddWebsite(BaseModel):
    url: str
    # Extra "important" URLs the owner wants crawled for certain (deep pages a crawler
    # might not reach on its own). Always crawled first.
    extra_urls: list[str] = []


class GeneratePrompt(BaseModel):
    name: str
    notes: str = ""


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
    sets = ", ".join(f"{k} = %s" for k in fields) + ", updated_at = now()"
    params = list(fields.values()) + [str(tenant["id"])]
    async with await scoped_connection(user_id=user.id, tenant_id=str(tenant["id"])) as conn:
        row = await (await conn.execute(
            f"update tenants set {sets} where id = %s returning *", tuple(params)
        )).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Persona not found")
    return row


@router.post("/personas/active/generate-prompt")
async def generate(body: GeneratePrompt, tenant: dict = Depends(_require_tenant)) -> dict:
    """Synthesise a system prompt from the notes + already-ingested knowledge. Returns it
    for the user to review/edit; saving is a separate PATCH so hand-edits are never clobbered."""
    prompt = await generate_system_prompt(
        tenant_id=str(tenant["id"]), name=body.name, notes=body.notes
    )
    return {"system_prompt": prompt}


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
        raise HTTPException(400, "Only UTF-8 text files (.txt/.md) are supported for now.")
    if not text.strip():
        raise HTTPException(400, "The file appears to be empty.")

    tid = str(tenant["id"])
    async with await scoped_connection(tenant_id=tid) as conn:
        row = await (await conn.execute(
            "insert into knowledge_sources (tenant_id, kind, name, status) "
            "values (%s, 'upload', %s, 'pending') returning *",
            (tid, file.filename or "document"),
        )).fetchone()

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

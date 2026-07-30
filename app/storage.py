"""Product images — a thin Supabase Storage client.

Why Storage and not bytes in Postgres: a product photo is 100 KB–5 MB of immutable
binary that every widget render wants. In a `bytea` column it bloats every backup, is
read through a pooled DB connection, and has to be re-served by this process on each
view. In Storage it lives on Supabase's CDN, so `catalog_items.image_url` is just a
public URL and the API process is not in the image path at all — no streaming
endpoint, no bandwidth through the app, no cache to invalidate.

Why the REST API and not the supabase-py SDK: two calls (PUT one object, DELETE one
object) against a documented HTTP surface, using the httpx we already depend on for
Telegram/WhatsApp (app/notify.py). A whole SDK for that is not worth the dependency.

Trust posture — the service-role key is the ONLY credential that can write to a
bucket, and it bypasses RLS entirely. It is therefore server-only: it lives in this
process's env, is used exactly here, and is never returned by an endpoint, embedded in
a page, or logged. Browsers never talk to Storage directly; they upload through the
authenticated admin API, which has already proved the caller owns the persona.

The stored content type comes from a magic-byte sniff, never from the client's
`Content-Type` header. A public bucket serves objects back with the type we recorded,
so trusting the client would let someone store HTML/SVG as `text/html` and have
Supabase's CDN serve active content from a URL our own dashboard renders.
"""

from __future__ import annotations

import logging
from uuid import uuid4

import httpx

from app.config import settings

logger = logging.getLogger("replyo.storage")

# Created by scripts/setup_storage.py as a PUBLIC bucket with these same limits.
CATALOG_IMAGE_BUCKET = "catalog-images"

# mime -> file extension. The keys are also the bucket's allowed_mime_types, so a
# rejected type fails here (400, with a useful message) rather than at Supabase.
ALLOWED_IMAGE_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}
MAX_IMAGE_BYTES = 5 * 1024 * 1024

UPLOAD_TIMEOUT = 30  # seconds — a 5 MB upload over a slow link is still a small request


class StorageNotConfigured(RuntimeError):
    """Raised when SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_URL) is missing.

    Distinct from ValueError/RuntimeError so the API can answer 503 ("the operator has
    not set this up") instead of 400 ("your file is wrong") — the two need very
    different messages.
    """


def _base_url() -> str:
    return settings.supabase_url.rstrip("/")


def _headers() -> dict[str, str]:
    """Service-role auth. Both headers are required: `apikey` gets past the gateway,
    `Authorization` is what Storage checks for write permission."""
    key = settings.supabase_service_role_key
    return {"apikey": key, "Authorization": f"Bearer {key}"}


def public_url_prefix() -> str:
    """The one URL prefix we own — everything under it, and nothing else, is ours.

    Used both to build a public URL after an upload and to decide whether a URL is
    safe to derive a DELETE from (see delete_catalog_image).
    """
    return f"{_base_url()}/storage/v1/object/public/{CATALOG_IMAGE_BUCKET}/"


def object_path(*, tenant_id: str, item_id: str, ext: str) -> str:
    """The storage key for one image: '<tenant>/<item>/<random>.<ext>'.

    Tenant-first so a persona's objects are listable/prunable as a prefix, item second
    so an item's history is grouped, and a random basename so a re-upload gets a NEW
    URL — a CDN never has to be told the old one changed.
    """
    return f"{tenant_id}/{item_id}/{uuid4().hex}.{ext}"


def object_path_from_url(url: object) -> str | None:
    """The object key inside a URL of ours, or None for anything else.

    Deliberately strict: a delete is only ever derived from a URL that starts with our
    own public prefix. `image_url` is a plain text column, so treating any string as a
    storage path would turn a bad row (or a hand-edited one) into a DELETE against an
    arbitrary bucket/key. Pure — the offline tests exercise this instead of the network.
    """
    if not isinstance(url, str):
        return None
    prefix = public_url_prefix()
    if not url.startswith(prefix):
        return None
    return url[len(prefix):] or None


def sniff_image_type(data: bytes) -> str | None:
    """The real mime type from the file's magic bytes, or None if it isn't one we allow.

    Pure and tiny on purpose — this is the security boundary for what a public bucket
    will serve back, so it must be readable at a glance and testable without a network.
    """
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if len(data) >= 12 and data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    return None


async def upload_catalog_image(*, tenant_id: str, item_id: str, data: bytes) -> str:
    """Store one product image and return its public CDN URL.

    Raises StorageNotConfigured when the service-role key is missing, ValueError for an
    empty/oversized/unsupported file (both mapped to HTTP by the caller), RuntimeError
    when Storage itself refuses the write.
    """
    if not settings.storage_enabled:
        raise StorageNotConfigured(
            "Image storage is not configured — set SUPABASE_SERVICE_ROLE_KEY and run "
            "scripts/setup_storage.py."
        )
    if not data:
        raise ValueError("The uploaded file is empty.")
    if len(data) > MAX_IMAGE_BYTES:
        raise ValueError(
            f"Image is too large ({len(data) / 1_048_576:.1f} MB). The limit is "
            f"{MAX_IMAGE_BYTES // 1_048_576} MB."
        )
    content_type = sniff_image_type(data)
    if content_type is None:
        raise ValueError("Unsupported image type — upload a PNG, JPEG or WebP file.")

    path = object_path(tenant_id=tenant_id, item_id=item_id, ext=ALLOWED_IMAGE_TYPES[content_type])
    url = f"{_base_url()}/storage/v1/object/{CATALOG_IMAGE_BUCKET}/{path}"
    async with httpx.AsyncClient(timeout=UPLOAD_TIMEOUT) as client:
        resp = await client.post(
            url,
            content=data,
            # x-upsert: the path carries a fresh uuid, so this can only ever matter on a
            # (astronomically unlikely) collision — cheaper than a failed request.
            headers={**_headers(), "Content-Type": content_type, "x-upsert": "true"},
        )
    if resp.status_code >= 400:
        logger.error("Storage upload failed (%s): %s", resp.status_code, resp.text[:300])
        raise RuntimeError(f"Storage rejected the upload ({resp.status_code}).")
    return f"{public_url_prefix()}{path}"


async def delete_catalog_image(url: str) -> None:
    """Best-effort removal of a stored image. Never raises.

    An orphaned object costs a few KB of storage; a raised exception here would block
    the DB update that the owner actually asked for (replacing or clearing the image),
    which is far worse. A 404 is success — the object is gone, which is the goal.
    """
    path = object_path_from_url(url)
    if path is None:
        # Not one of ours (a foreign URL, a hand-edited row, None): nothing to delete,
        # and we never issue a delete derived from an arbitrary string.
        return
    if not settings.storage_enabled:
        logger.warning("Storage not configured — leaving object %r in place.", path)
        return
    try:
        async with httpx.AsyncClient(timeout=UPLOAD_TIMEOUT) as client:
            resp = await client.delete(
                f"{_base_url()}/storage/v1/object/{CATALOG_IMAGE_BUCKET}/{path}",
                headers=_headers(),
            )
        if resp.status_code >= 400 and resp.status_code != 404:
            logger.error("Storage delete failed (%s): %s", resp.status_code, resp.text[:300])
    except Exception:
        logger.exception("Storage delete failed for %r — leaving the object orphaned.", path)

"""One-time Storage setup — the product-image bucket.

Product images live in Supabase Storage, not in Postgres (see app/storage.py for why),
which means one piece of infrastructure has to exist before the catalog's image upload
works: a PUBLIC bucket named `catalog-images`, restricted to the image types and size
cap the app enforces. Creating it is a single REST call, and it's idempotent — an
"already exists" answer is success, so this is safe to re-run.

Public bucket, deliberately: the URL is what `catalog_items.image_url` stores and what
the console/widget render, so objects must be readable without a token. Nothing secret
goes in here — only product photos the business already shows customers. Writes still
require the service-role key, which never leaves the server.

Run:  uv run python scripts/setup_storage.py
"""

from __future__ import annotations

import sys

import httpx

from app.config import settings
from app.storage import ALLOWED_IMAGE_TYPES, CATALOG_IMAGE_BUCKET, MAX_IMAGE_BYTES


def main() -> None:
    if not settings.supabase_url:
        print("ERROR: SUPABASE_URL is not set. Add it to .env (see .env.example).")
        raise SystemExit(1)
    if not settings.supabase_service_role_key:
        print(
            "ERROR: SUPABASE_SERVICE_ROLE_KEY is not set, so the bucket cannot be created.\n"
            "  1. Supabase dashboard -> Project Settings -> API -> service_role key.\n"
            "  2. Add it to .env as SUPABASE_SERVICE_ROLE_KEY=... (server-side only —\n"
            "     it bypasses RLS, so never put it in the dashboard's NEXT_PUBLIC_* env).\n"
            "  3. Re-run: uv run python scripts/setup_storage.py"
        )
        raise SystemExit(1)

    base = settings.supabase_url.rstrip("/")
    key = settings.supabase_service_role_key
    print(f"Creating the {CATALOG_IMAGE_BUCKET!r} bucket on {base} ...")

    resp = httpx.post(
        f"{base}/storage/v1/bucket",
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
        json={
            "id": CATALOG_IMAGE_BUCKET,
            "name": CATALOG_IMAGE_BUCKET,
            "public": True,
            "file_size_limit": MAX_IMAGE_BYTES,
            "allowed_mime_types": sorted(ALLOWED_IMAGE_TYPES),
        },
        timeout=30,
    )

    body = resp.text or ""
    if resp.status_code < 300:
        print(
            f"Done. Bucket {CATALOG_IMAGE_BUCKET!r} is public, capped at "
            f"{MAX_IMAGE_BYTES // 1_048_576} MB, and limited to "
            f"{', '.join(sorted(ALLOWED_IMAGE_TYPES))}."
        )
        return
    # Supabase answers 409 (or a 400 mentioning duplication) when it's already there —
    # that IS the desired end state, so this script stays re-runnable.
    if resp.status_code == 409 or "already exists" in body.lower() or "duplicate" in body.lower():
        print(f"Bucket {CATALOG_IMAGE_BUCKET!r} already exists — nothing to do.")
        return

    print(f"ERROR: bucket creation failed ({resp.status_code}): {body[:500]}", file=sys.stderr)
    print(
        "Check that SUPABASE_SERVICE_ROLE_KEY is the service_role key (not the anon/publishable "
        "key) and that SUPABASE_URL points at the right project.",
        file=sys.stderr,
    )
    raise SystemExit(1)


if __name__ == "__main__":
    main()

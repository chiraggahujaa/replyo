"""Multi-tenancy: connections, identity, and the trust boundary.

Two connection kinds, and getting the distinction right is the whole ballgame:

  * `scoped_connection(user_id=…, tenant_id=…)` — the normal path. Connects, then
    `SET ROLE authenticated` (Supabase's non-RLS-bypassing role) and stamps the
    identity into two GUCs the RLS policies read. Every user- or tenant-facing query
    goes through here, so RLS is always in force.

  * `admin_connection()` — connects as `postgres`, which BYPASSES RLS. Reserved for
    genuinely cross-tenant infrastructure (the follow-up worker scanning every
    tenant's due rows) — never for anything driven by a request.

The trust boundary is **setting `app.tenant_id`**. The data-table policies only check
`tenant_id = current_tenant_id()`, so the guarantee that a caller is entitled to that
tenant lives here, in exactly two validated entry points:
  * `tenant_for_user()`  — the dashboard: the tenant must be one the user is a member of
  * `tenant_by_public_key()` — the widget: the tenant is whoever owns that public key
Nothing else may choose a tenant id out of thin air.
"""

from __future__ import annotations

import logging
import secrets
import uuid
from dataclasses import dataclass
from typing import Any

import jwt
import psycopg
from fastapi import Header, HTTPException
from psycopg.rows import DictRow, dict_row
from psycopg.types.numeric import FloatLoader

from app.config import settings

# Postgres `numeric` comes back as decimal.Decimal by default, and FastAPI routes
# annotated `-> dict` hand their payload to pydantic v2, which serializes Decimal as a
# JSON *string* ("500", not 500). The console's types say number, so every numeric
# column — price_amount was the first casualty, rendering as "No price" — would need
# per-endpoint patching. Registering the float loader on psycopg's global adapter map
# fixes the contract once, at the layer that owns it: our numerics are display values
# (prices), where float precision is ample; storage stays exact `numeric` in Postgres.
psycopg.adapters.register_loader("numeric", FloatLoader)

logger = logging.getLogger("replyo.tenancy")

# The demo/seed persona created by the multitenancy_schema migration. Single-tenant
# channels (Telegram/WhatsApp in phase 1) and any pre-auth path map here, so existing
# flows keep working while per-tenant channels are built out.
DEMO_TENANT_ID = "00000000-0000-0000-0000-000000000001"


# ---------------------------------------------------------------------------
# Connections
# ---------------------------------------------------------------------------

async def scoped_connection(
    *, user_id: str | None = None, tenant_id: str | None = None
) -> psycopg.AsyncConnection[DictRow]:
    """Open an autocommit connection that runs under RLS as `authenticated`.

    The GUCs are set with `set_config(..., is_local => false)`, i.e. for the session;
    since these connections are short-lived (opened per operation, closed after) the
    role and GUCs are discarded on close, so nothing leaks between callers.
    """
    # Parameterizing the class (AsyncConnection[DictRow]) is what tells the type
    # checker rows are dicts — connect() alone is typed TupleRow in psycopg's stubs.
    conn = await psycopg.AsyncConnection[DictRow].connect(
        settings.database_url, autocommit=True, row_factory=dict_row
    )
    await conn.execute("set role authenticated")
    if user_id is not None:
        await conn.execute("select set_config('app.user_id', %s, false)", (str(user_id),))
    if tenant_id is not None:
        await conn.execute("select set_config('app.tenant_id', %s, false)", (str(tenant_id),))
    return conn


async def admin_connection() -> psycopg.AsyncConnection[DictRow]:
    """Open a connection as `postgres` (BYPASSES RLS). Cross-tenant infra only."""
    return await psycopg.AsyncConnection[DictRow].connect(
        settings.database_url, autocommit=True, row_factory=dict_row
    )


# ---------------------------------------------------------------------------
# Identity — verify the Supabase-issued JWT the dashboard sends
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class User:
    id: str
    email: str | None


_jwk_client: jwt.PyJWKClient | None = None


def _jwks() -> jwt.PyJWKClient:
    global _jwk_client
    if _jwk_client is None:
        if not settings.supabase_url:
            raise HTTPException(500, "SUPABASE_URL not configured — cannot verify tokens")
        _jwk_client = jwt.PyJWKClient(
            f"{settings.supabase_url.rstrip('/')}/auth/v1/.well-known/jwks.json"
        )
    return _jwk_client


def verify_token(token: str) -> dict[str, Any]:
    """Verify a Supabase access token and return its claims.

    Picks the verification method from the token's own `alg` header: HS256 uses the
    shared JWT secret (legacy projects), everything else (ES256/RS256) verifies against
    the project's published JWKS. `aud` is always `authenticated` for a logged-in user.
    """
    try:
        alg = jwt.get_unverified_header(token).get("alg", "")
        if alg == "HS256":
            if not settings.supabase_jwt_secret:
                raise HTTPException(500, "SUPABASE_JWT_SECRET not set for HS256 tokens")
            key: Any = settings.supabase_jwt_secret
        else:
            key = _jwks().get_signing_key_from_jwt(token).key
        return jwt.decode(token, key, algorithms=[alg or "HS256"], audience="authenticated")
    except HTTPException:
        raise
    except jwt.PyJWTError as exc:
        raise HTTPException(401, f"Invalid token: {exc}") from exc


async def get_current_user(authorization: str = Header(default="")) -> User:
    """FastAPI dependency: the signed-in user, or 401."""
    if not authorization.startswith("Bearer "):
        raise HTTPException(401, "Missing bearer token")
    claims = verify_token(authorization[len("Bearer "):])
    sub = claims.get("sub")
    if not sub:
        raise HTTPException(401, "Token has no subject")
    return User(id=sub, email=claims.get("email"))


# ---------------------------------------------------------------------------
# Tenant resolution — the two trusted ways to obtain a tenant id
# ---------------------------------------------------------------------------

async def tenant_for_user(user: User, tenant_id: str) -> dict[str, Any]:
    """The active persona for a dashboard request — 404 unless the user is a member.

    Runs under RLS with the user's identity, so the tenants row is only visible if
    `is_tenant_member` holds. That single visibility check *is* the authorization.
    """
    async with await scoped_connection(user_id=user.id, tenant_id=tenant_id) as conn:
        row = await (await conn.execute("select * from tenants where id = %s", (tenant_id,))).fetchone()
    if not row:
        raise HTTPException(404, "Persona not found")
    return row


async def list_user_tenants(user: User) -> list[dict[str, Any]]:
    """Every persona this user can administer (drives the switcher)."""
    async with await scoped_connection(user_id=user.id) as conn:
        return await (await conn.execute(
            "select t.* from tenants t join tenant_members m on m.tenant_id = t.id "
            "where m.user_id = %s order by t.created_at",
            (user.id,),
        )).fetchall()


def new_public_key() -> str:
    """A widget key that's safe to expose — it only authorises chatting AS this persona."""
    return "pk_" + secrets.token_urlsafe(24)


async def create_tenant(user: User, *, name: str, timezone: str = "UTC") -> dict[str, Any]:
    """Create a persona and make the caller its owner, in one transaction.

    Both inserts must land together: the tenants INSERT policy allows any signed-in user,
    but membership is what makes the persona visible afterwards, so a failure mid-way would
    leave an orphan nobody can see. We generate the id in Python and skip `RETURNING` on the
    tenant insert on purpose — `RETURNING` re-checks the row against the SELECT policy
    (`is_tenant_member`), which can't hold until the membership row exists a line later.
    """
    tenant_id = str(uuid.uuid4())
    async with await scoped_connection(user_id=user.id) as conn:
        async with conn.transaction():
            await conn.execute(
                "insert into tenants (id, name, public_key, timezone) values (%s, %s, %s, %s)",
                (tenant_id, name, new_public_key(), timezone),
            )
            await conn.execute(
                "insert into tenant_members (tenant_id, user_id, role) values (%s, %s, 'owner')",
                (tenant_id, user.id),
            )
        # Now visible via the fresh membership.
        row = await (await conn.execute("select * from tenants where id = %s", (tenant_id,))).fetchone()
        assert row is not None  # both inserts committed above, so the row must be visible
        return row


async def tenant_by_public_key(public_key: str) -> dict[str, Any] | None:
    """Resolve the widget's public key to a tenant. Read via admin (no user context);
    the public key is the credential, and the row is safe to return as-is."""
    async with await admin_connection() as conn:
        return await (await conn.execute(
            "select * from tenants where public_key = %s", (public_key,)
        )).fetchone()


async def get_tenant(tenant_id: str) -> dict[str, Any] | None:
    """Fetch a tenant row by id (admin). For trusted infra that already knows the id —
    the single-tenant channels and the follow-up worker resolving a row's tenant."""
    async with await admin_connection() as conn:
        return await (await conn.execute(
            "select * from tenants where id = %s", (tenant_id,)
        )).fetchone()

-- Multi-tenancy foundation — schema, seed, and grants.
--
-- Turns Replyo from one hardcoded assistant into a platform where one login owns
-- many "personas" (businesses), each with its own knowledge, prompt, embed key and
-- review queue. The RLS *policies* that enforce isolation live in the next migration
-- (…_multitenancy_rls.sql); this one creates the tables and wires up the grants.
--
-- Isolation model (see app/tenancy.py for the runtime half):
--   * The app connects as `postgres` (which BYPASSES RLS) but immediately does
--     `SET ROLE authenticated` — Supabase's built-in, non-bypassing role — and sets
--     two GUCs per connection: app.user_id (the signed-in user) and app.tenant_id
--     (the active persona). Policies read those via the helper functions below.
--   * A custom role was the original plan, but Supabase's pooler blocks the role
--     MEMBERSHIP grant it would need; `authenticated` is the role Supabase built for
--     exactly this, and `postgres` can already SET ROLE into it. (Verified.)
--   * Trust boundary: setting app.tenant_id is privileged. app/tenancy.py only ever
--     sets it to a tenant the user is a member of, or one resolved from a valid
--     public_key. Data-table policies then just check tenant_id = current_tenant_id(),
--     so a forgotten WHERE can never leak all tenants and an unset tenant sees zero
--     rows (not everything).

-- ---------------------------------------------------------------------------
-- Context helpers. STABLE + tiny so they inline into policies. `true` = missing_ok,
-- so an unset GUC yields NULL rather than erroring — and NULL never matches a
-- tenant_id, which is what makes "no tenant set -> zero rows" hold.
-- ---------------------------------------------------------------------------
create or replace function public.current_user_id() returns uuid
    language sql stable
    as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

create or replace function public.current_tenant_id() returns uuid
    language sql stable
    as $$ select nullif(current_setting('app.tenant_id', true), '')::uuid $$;

-- ---------------------------------------------------------------------------
-- tenants — one row per persona (a business's assistant).
-- ---------------------------------------------------------------------------
create table if not exists tenants (
    id            uuid primary key default gen_random_uuid(),
    name          text not null,
    slug          text unique,
    public_key    text not null unique,          -- pk_… ; identifies the tenant to the widget
    system_prompt text,                           -- the generated, user-editable instruction
    extra_notes   text,                           -- freeform "anything else" from the wizard
    timezone      text not null default 'Asia/Kolkata',
    onboarding_status text not null default 'draft',  -- draft | ready
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- tenant_members — which user can administer which persona (many-to-many).
-- ---------------------------------------------------------------------------
create table if not exists tenant_members (
    id         uuid primary key default gen_random_uuid(),
    tenant_id  uuid not null references tenants(id) on delete cascade,
    user_id    uuid not null references auth.users(id) on delete cascade,
    role       text not null default 'owner',     -- owner | member
    created_at timestamptz not null default now(),
    unique (tenant_id, user_id)
);
create index if not exists tenant_members_user_idx on tenant_members (user_id);

-- Membership check used by the tenants policy so the persona switcher can list every
-- business a user belongs to. SECURITY DEFINER so it runs as owner and isn't itself
-- filtered by tenant_members' own RLS (which would otherwise recurse).
create or replace function public.is_tenant_member(t uuid) returns boolean
    language sql stable security definer set search_path = public
    as $$
        select exists (
            select 1 from public.tenant_members m
            where m.tenant_id = t and m.user_id = public.current_user_id()
        )
    $$;

-- ---------------------------------------------------------------------------
-- knowledge_sources — a persona's uploaded docs and website URLs. Many per tenant.
-- The extracted text lives on the pgvector chunks, not here; this tracks ingestion.
-- ---------------------------------------------------------------------------
create table if not exists knowledge_sources (
    id              uuid primary key default gen_random_uuid(),
    tenant_id       uuid not null references tenants(id) on delete cascade,
    kind            text not null,                 -- upload | website
    name            text,                          -- filename or a human label
    url             text,                          -- for website sources
    status          text not null default 'pending', -- pending | ingesting | ready | error
    page_count      integer not null default 0,    -- pages reached (website crawl)
    chunk_count     integer not null default 0,
    error           text,
    last_ingested_at timestamptz,
    created_at      timestamptz not null default now()
);
create index if not exists knowledge_sources_tenant_idx on knowledge_sources (tenant_id, created_at);

-- ---------------------------------------------------------------------------
-- Tenant-scope the existing conversation tables. They may already hold dev rows with
-- no tenant, so: add nullable, backfill to the demo tenant, then enforce NOT NULL.
-- ---------------------------------------------------------------------------
alter table pending_reviews add column if not exists tenant_id uuid references tenants(id) on delete cascade;
alter table follow_ups      add column if not exists tenant_id uuid references tenants(id) on delete cascade;

-- Demo/seed tenant: the original BrightSmile clinic. Keeps the clinic-site + widget
-- and any existing conversations working during the multi-tenant build-out. Fixed id
-- so app code and the seed can reference it. system_prompt mirrors the old hardcoded
-- PERSONA so behaviour is unchanged.
insert into tenants (id, name, slug, public_key, system_prompt, timezone, onboarding_status)
values (
    '00000000-0000-0000-0000-000000000001',
    'BrightSmile Dental',
    'brightsmile',
    'pk_demo_brightsmile',
    'You are the friendly front-desk assistant for BrightSmile Dental, a dental clinic. '
    'You help patients and prospects over chat. Be warm, concise, and professional. '
    'Answer only from the clinic''s documents; do not invent prices, insurance coverage, '
    'or availability. If you are unsure, say you''ll confirm and offer to take their details. '
    'Keep replies to a few sentences.',
    'Asia/Kolkata',
    'ready'
)
on conflict (id) do nothing;

update pending_reviews set tenant_id = '00000000-0000-0000-0000-000000000001' where tenant_id is null;
update follow_ups      set tenant_id = '00000000-0000-0000-0000-000000000001' where tenant_id is null;

alter table pending_reviews alter column tenant_id set not null;
alter table follow_ups      alter column tenant_id set not null;

-- follow_ups previously had a GLOBAL unique on thread_id; per-tenant now.
alter table follow_ups drop constraint if exists follow_ups_thread_id_key;
create unique index if not exists follow_ups_tenant_thread_idx on follow_ups (tenant_id, thread_id);

create index if not exists pending_reviews_tenant_idx on pending_reviews (tenant_id, created_at);

-- ---------------------------------------------------------------------------
-- Grants. The app acts as `authenticated` at runtime (SET ROLE), so it needs table
-- privileges — the tables are owned by postgres and `authenticated` has none by
-- default. RLS still governs *which rows*; grants only govern *which tables*.
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on tenants, tenant_members, knowledge_sources,
    pending_reviews, follow_ups to authenticated;
grant execute on function public.current_user_id(), public.current_tenant_id(),
    public.is_tenant_member(uuid) to authenticated;

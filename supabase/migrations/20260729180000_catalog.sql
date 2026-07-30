-- Structured business catalog — services, products, guidelines, and profile state.
--
-- RAG chunks answer questions, but the owner can't SEE or FIX what the assistant
-- believes about their business. This migration adds the relational half: after every
-- ingest an LLM pass (app/extraction.py) distils the embedded chunks into rows the
-- console can list and edit — services/products with pricing (catalog_items),
-- customer-handling rules and notable facts (business_snippets). The agent then
-- prefers these curated rows over raw retrieval (app/catalog.py builds the prompt
-- blocks). `status` tracks provenance: 'extracted' rows may be refreshed by the next
-- extraction run; 'edited' rows are the owner's word and are never clobbered.
--
-- business_profiles is a singleton per tenant holding the extraction run state
-- (idle | running | done | error) — the running-guard that keeps concurrent ingest
-- finishes from double-extracting lives on this row. Later phases add per-business
-- settings here too (opening hours, booking-slot config), which is why it's a
-- profile table and not just a status column somewhere.
--
-- RLS mirrors the data-table pattern from …_multitenancy_rls.sql: enable + FORCE,
-- one FOR ALL policy per table on tenant_id = current_tenant_id(), grants to
-- `authenticated` (the role the app assumes via SET ROLE — see app/tenancy.py).

-- ---------------------------------------------------------------------------
-- catalog_items — services performed for customers and physical products sold.
-- ---------------------------------------------------------------------------
create table if not exists catalog_items (
    id           uuid primary key default gen_random_uuid(),
    tenant_id    uuid not null references tenants(id) on delete cascade,
    kind         text not null check (kind in ('service', 'product')),
    name         text not null,
    description  text,
    price_text   text,     -- verbatim from the source ("AED 300", "from $50") — always safe to display
    price_amount numeric,  -- only when the source states a single unambiguous number
    currency     text,
    duration_min integer,
    category     text,
    image_url    text,     -- unused for now; future product images
    sort         integer not null default 0,
    source       text,     -- filename / page title the fact came from
    status       text not null default 'extracted' check (status in ('extracted', 'edited')),
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);
-- Case-insensitive per-tenant identity: also the ON CONFLICT target the extraction
-- upsert uses to refresh extracted rows without duplicating them.
create unique index if not exists catalog_items_tenant_kind_name_idx
    on catalog_items (tenant_id, kind, lower(name));
create index if not exists catalog_items_tenant_kind_sort_idx
    on catalog_items (tenant_id, kind, sort);

-- ---------------------------------------------------------------------------
-- business_snippets — customer-handling guidelines and notable display-worthy facts.
-- ---------------------------------------------------------------------------
create table if not exists business_snippets (
    id         uuid primary key default gen_random_uuid(),
    tenant_id  uuid not null references tenants(id) on delete cascade,
    kind       text not null check (kind in ('guideline', 'content')),
    title      text not null,
    body       text not null,
    source     text,
    sort       integer not null default 0,
    status     text not null default 'extracted' check (status in ('extracted', 'edited')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create unique index if not exists business_snippets_tenant_kind_title_idx
    on business_snippets (tenant_id, kind, lower(title));

-- ---------------------------------------------------------------------------
-- business_profiles — one row per tenant: extraction run state (and, later,
-- hours/slot settings). The PK is the tenant id itself, so the single-statement
-- upsert in app/extraction.py can act as the concurrent-run guard.
-- ---------------------------------------------------------------------------
create table if not exists business_profiles (
    tenant_id         uuid primary key references tenants(id) on delete cascade,
    extraction_status text not null default 'idle'
                      check (extraction_status in ('idle', 'running', 'done', 'error')),
    extraction_error  text,
    last_extracted_at timestamptz,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- RLS — tenant-scoped, enable + FORCE, one FOR ALL policy per table (the pattern
-- from the multitenancy RLS migration). business_profiles keys on its tenant_id PK.
-- ---------------------------------------------------------------------------
alter table catalog_items     enable row level security;
alter table catalog_items     force  row level security;
alter table business_snippets enable row level security;
alter table business_snippets force  row level security;
alter table business_profiles enable row level security;
alter table business_profiles force  row level security;

drop policy if exists catalog_items_tenant on catalog_items;
create policy catalog_items_tenant on catalog_items for all
    using (tenant_id = public.current_tenant_id())
    with check (tenant_id = public.current_tenant_id());

drop policy if exists business_snippets_tenant on business_snippets;
create policy business_snippets_tenant on business_snippets for all
    using (tenant_id = public.current_tenant_id())
    with check (tenant_id = public.current_tenant_id());

drop policy if exists business_profiles_tenant on business_profiles;
create policy business_profiles_tenant on business_profiles for all
    using (tenant_id = public.current_tenant_id())
    with check (tenant_id = public.current_tenant_id());

-- Grants: the app runs as `authenticated` (SET ROLE), which starts with no table
-- privileges. RLS governs which rows; grants govern which tables.
grant select, insert, update, delete on catalog_items, business_snippets, business_profiles
    to authenticated;

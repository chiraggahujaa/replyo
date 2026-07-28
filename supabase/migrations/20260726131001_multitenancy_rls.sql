-- Multi-tenancy — Row-Level Security policies.
--
-- Runs after …_multitenancy_schema.sql. Enables + FORCEs RLS on every tenant table
-- and defines the policies. Reminder on why this actually enforces anything:
--   * The app queries as `authenticated` (via SET ROLE), which does NOT bypass RLS.
--   * FORCE is belt-and-braces: a table's *owner* also bypasses RLS by default, and
--     FORCE makes the policy apply even to the owner. (BYPASSRLS roles like postgres
--     still bypass — that's intentional, the migration/admin path uses postgres.)
--   * "no tenant set -> zero rows" comes from current_tenant_id() returning NULL,
--     which never equals a real tenant_id.

alter table tenants           enable row level security;
alter table tenants           force  row level security;
alter table tenant_members    enable row level security;
alter table tenant_members    force  row level security;
alter table knowledge_sources enable row level security;
alter table knowledge_sources force  row level security;
alter table pending_reviews   enable row level security;
alter table pending_reviews   force  row level security;
alter table follow_ups        enable row level security;
alter table follow_ups        force  row level security;

-- ---------------------------------------------------------------------------
-- tenants — USER-scoped. A user sees/edits every persona they're a member of (so the
-- switcher can list them), and any authenticated user may create one. is_tenant_member
-- is SECURITY DEFINER, so it isn't re-filtered by tenant_members' own RLS.
-- ---------------------------------------------------------------------------
drop policy if exists tenants_select on tenants;
create policy tenants_select on tenants for select
    using (public.is_tenant_member(id));

drop policy if exists tenants_update on tenants;
create policy tenants_update on tenants for update
    using (public.is_tenant_member(id))
    with check (public.is_tenant_member(id));

-- Creating a persona: the row has no membership yet, so gate on "is a signed-in user".
-- The app inserts the owning tenant_members row in the same transaction (see tenancy).
drop policy if exists tenants_insert on tenants;
create policy tenants_insert on tenants for insert
    with check (public.current_user_id() is not null);

-- ---------------------------------------------------------------------------
-- tenant_members — a user sees and manages only their own memberships.
-- ---------------------------------------------------------------------------
drop policy if exists members_select on tenant_members;
create policy members_select on tenant_members for select
    using (user_id = public.current_user_id());

drop policy if exists members_insert on tenant_members;
create policy members_insert on tenant_members for insert
    with check (user_id = public.current_user_id());

drop policy if exists members_delete on tenant_members;
create policy members_delete on tenant_members for delete
    using (user_id = public.current_user_id());

-- ---------------------------------------------------------------------------
-- Data tables — TENANT-scoped. Simple and uniform: the row's tenant must equal the
-- active tenant. The app-layer trust boundary (tenancy.py) guarantees app.tenant_id
-- is only ever a tenant this caller is entitled to — admin path validates membership,
-- widget path resolves it from a valid public_key. This is what lets the public chat
-- widget (no user_id) still write reviews/follow-ups for its tenant.
-- ---------------------------------------------------------------------------
drop policy if exists knowledge_tenant on knowledge_sources;
create policy knowledge_tenant on knowledge_sources for all
    using (tenant_id = public.current_tenant_id())
    with check (tenant_id = public.current_tenant_id());

drop policy if exists reviews_tenant on pending_reviews;
create policy reviews_tenant on pending_reviews for all
    using (tenant_id = public.current_tenant_id())
    with check (tenant_id = public.current_tenant_id());

drop policy if exists followups_tenant on follow_ups;
create policy followups_tenant on follow_ups for all
    using (tenant_id = public.current_tenant_id())
    with check (tenant_id = public.current_tenant_id());

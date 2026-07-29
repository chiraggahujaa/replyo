-- Persona management: pause/resume + owner-only delete.
--
-- Two gaps this closes so the dashboard can manage personas end-to-end:
--   * `tenants` had no lifecycle state — add `status` (active | paused). Paused is
--     enforced in the app: the widget chat answers with an "unavailable" notice and
--     the follow-up worker skips the persona's due nudges (app/api.py, followups.py).
--   * `tenants` had SELECT/UPDATE/INSERT policies but NO DELETE policy, so no
--     request-driven path could delete a persona at all. Add one, gated on OWNER —
--     any member may edit/pause, but only an owner may destroy. Child rows
--     (tenant_members, knowledge_sources, pending_reviews, follow_ups) already
--     declare `on delete cascade`; the pgvector collection is library-managed (no FK)
--     and is dropped by the API after the row delete (app/admin_api.py).

alter table tenants add column if not exists status text not null default 'active';

-- Named constraint + drop-first so the migration can be re-run, matching the
-- drop-policy-if-exists style used across these files.
alter table tenants drop constraint if exists tenants_status_check;
alter table tenants add constraint tenants_status_check check (status in ('active', 'paused'));

-- Ownership check, mirroring is_tenant_member: SECURITY DEFINER so it isn't
-- re-filtered by tenant_members' own RLS when a policy evaluates it.
create or replace function public.is_tenant_owner(t uuid) returns boolean
    language sql stable security definer set search_path = public
    as $$
        select exists (
            select 1 from public.tenant_members m
            where m.tenant_id = t
              and m.user_id = public.current_user_id()
              and m.role = 'owner'
        )
    $$;

drop policy if exists tenants_delete on tenants;
create policy tenants_delete on tenants for delete
    using (public.is_tenant_owner(id));

-- DELETE table privilege was already granted in the schema migration; the function
-- needs its own execute grant.
grant execute on function public.is_tenant_owner(uuid) to authenticated;

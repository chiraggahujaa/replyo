-- Extraction re-run flag — don't lose an ingest that finishes mid-extraction.
--
-- extract_catalog snapshots the embedded chunks the moment it claims the run, then
-- spends a while on LLM calls. A second ingest finishing during that window used to
-- be swallowed by the running-guard: its caller saw 'running', skipped, and the new
-- content silently never reached catalog_items until a manual re-extract. Now the
-- losing caller sets rerun_requested instead of giving up, and the run in flight
-- atomically checks-and-clears the flag after finishing and does one more pass over
-- the (by then complete) chunk set. A column on business_profiles — not in-process
-- state — so the handshake stays correct across workers, exactly like the
-- extraction_status guard it complements (see app/extraction.py).
--
-- No RLS changes: business_profiles already has enable + FORCE and its FOR ALL
-- tenant policy from the catalog migration; a new column inherits both.
alter table business_profiles
    add column if not exists rerun_requested boolean not null default false;

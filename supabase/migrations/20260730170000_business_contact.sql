-- Contact details on the business profile.
--
-- The catalog already answers "what do you sell?" (catalog_items), "how should you treat
-- customers?" (business_snippets) and "when are you open?" (business_profiles.hours). The
-- one front-desk question left was "how do I reach you?" — a phone number or an address
-- lived only in whichever crawled page happened to mention it, so the assistant quoted
-- retrieval and the owner had no way to see or fix what it believed. This is the same
-- treatment the other sections get: extracted from the ingested knowledge
-- (app/extraction.py), editable in the console, and fed back to the agent as part of the
-- authoritative catalog block (app/catalog.py).
--
-- `contact` shape — a flat object, every key optional, every value a one-line string:
--     {"phone": "+91 98765 43210", "whatsapp": "…", "email": "hello@example.com",
--      "address": "12 MG Road, Bengaluru 560001", "website": "example.com",
--      "maps_url": "https://maps.app.goo.gl/…"}
-- An absent key means "not stated". jsonb rather than six columns for the reason
-- ...business_hours.sql gives for `hours`: the whole object is read and written as one
-- unit (extract a card, edit a card) and is never queried by field. The allowed keys and
-- their per-field validation live in app/catalog.py (CONTACT_FIELDS,
-- clean_contact_value), shared by the extractor and the admin API so a value that passed
-- validation can never fail rendering later.
--
-- `contact_status` mirrors `hours_status` / `settings_status`: 'extracted' rows may be
-- refreshed by the next extraction run, 'edited' is the owner's word and is never
-- clobbered (app/extraction.py guards its UPDATE with `where contact_status =
-- 'extracted'`). Its own flag, not a share of hours_status, because contact details and
-- opening hours are edited on different cards and re-extracted with different confidence.
-- `{}` is a meaningful edited value: "this business has no contact details to give out".
--
-- No RLS changes needed: business_profiles already has enable + FORCE and its FOR ALL
-- tenant policy from the catalog migration; new columns inherit both.

alter table business_profiles
    add column if not exists contact        jsonb,
    add column if not exists contact_status text not null default 'extracted'
        check (contact_status in ('extracted', 'edited'));

-- `add column if not exists` skips the whole clause (inline CHECK included) on a re-run,
-- so this file stays idempotent without any guarded DO blocks.

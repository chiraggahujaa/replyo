-- Opening hours + appointment settings on the business profile.
--
-- 20260729180000_catalog.sql said business_profiles was a profile table (not just a
-- status column) because "later phases add per-business settings here too (opening
-- hours, booking-slot config)". This is that phase: the booking engine stops using the
-- hardcoded CLINIC_HOURS/30-minute grid in app/booking.py and reads the persona's own
-- hours and slot length instead, so a spa open 09:00–20:00 with 45-minute treatments
-- stops being offered 09:30 half-hour dental slots.
--
-- `hours` shape — one key per weekday, keyed by the PYTHON weekday index as a STRING
-- (jsonb object keys are always text): "0" = Monday .. "6" = Sunday.
--     {"0": {"open": "09:30", "close": "20:00"}, ..., "6": null}
-- A null value (or an absent key) means CLOSED that day. Times are "HH:MM" 24-hour
-- local time; jsonb rather than seven pairs of columns because the whole object is
-- read and written as one unit (extract a week, edit a week) and never queried by day.
--
-- Timezone is deliberately NOT duplicated here: it already lives on `tenants.timezone`,
-- and two places to set the same thing is two places to disagree. app/booking.py
-- tenant_tz() reads that column and falls back to CLINIC_TIMEZONE.
--
-- `slot_minutes` is the appointment LENGTH; `buffer_minutes` is turnaround padding
-- between appointments. The slot grid steps by slot+buffer while the appointment
-- itself is slot long, so a 45+15 clinic books 09:00–09:45, 10:00–10:45, ...
--
-- The two *_status columns mirror `catalog_items.status`: 'extracted' rows may be
-- refreshed by the next extraction run, 'edited' is the owner's word and is never
-- clobbered (app/extraction.py guards each UPDATE with `where …_status = 'extracted'`).
-- Two separate flags, not one, because hours and slot length are edited on different
-- screens and re-extracted with very different confidence.
--
-- No RLS changes needed: business_profiles already has enable + FORCE and its FOR ALL
-- tenant policy from the catalog migration; new columns inherit both.

alter table business_profiles
    add column if not exists hours            jsonb,
    add column if not exists slot_minutes     integer not null default 30,
    add column if not exists buffer_minutes   integer not null default 0,
    add column if not exists hours_status     text not null default 'extracted'
        check (hours_status in ('extracted', 'edited')),
    add column if not exists settings_status  text not null default 'extracted'
        check (settings_status in ('extracted', 'edited'));

-- `add column if not exists` skips the whole clause (inline CHECK included) on a
-- re-run, so this file stays idempotent without any guarded DO blocks.

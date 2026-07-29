-- Per-tenant widget appearance (name + styling), set from the console's Install page.
-- The widget fetches it at boot (GET /widget/config?tenant_key=pk_...) so a plain
-- src+data-tenant embed follows the console's customization; explicit data-* attributes
-- on the script tag still win per field. Sanitized on write AND on read by
-- app/widget_config.py, so a hand-edited row can never leak junk into embeds.
alter table tenants add column if not exists widget_config jsonb;

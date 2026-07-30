-- Single-currency catalog: every price is in Indian rupees.
--
-- app/currency.py is the source of truth for that decision (one row in CURRENCIES,
-- DEFAULT_CURRENCY = 'INR'); this migration makes the database agree, so the two can't
-- drift. Without the CHECK, an extraction run over a page that happens to quote "$50"
-- could write currency = 'USD' on a row whose amount the business charges in rupees —
-- and the catalog block would then quote a price nobody sells at.
--
-- The normalizing UPDATE runs first so the constraint can be added without a rewrite
-- failure: `normalize_currency` maps every foreign code/symbol to INR on the way in
-- from now on, but rows written before this migration may still say 'AED'/'USD'. The
-- amount is kept as-is on purpose — it was always a rupee amount misattributed to a
-- foreign symbol, and inventing an FX conversion would silently change real prices.
--
-- Adding a second currency later = a row in app/currency.py CURRENCIES + a migration
-- that drops and re-adds this constraint with the extra code. Keeping the check
-- explicit (rather than skipping it) is what makes that a deliberate, reviewable change.

update catalog_items
   set currency = 'INR', updated_at = now()
 where currency is not null
   and currency <> 'INR';

-- Idempotent constraint add: `alter table … add constraint` has no IF NOT EXISTS, so
-- the existence check is explicit (a named constraint keeps the check greppable).
do $$
begin
    if not exists (
        select 1 from pg_constraint
         where conrelid = 'public.catalog_items'::regclass
           and conname  = 'catalog_items_currency_inr'
    ) then
        alter table catalog_items
            add constraint catalog_items_currency_inr
            check (currency is null or currency in ('INR'));
    end if;
end
$$;

-- Live dashboard events — the Postgres half of socket-pushed queue/knowledge updates.
--
-- The dashboard's review queue and knowledge list used to poll. Now every write to
-- pending_reviews / knowledge_sources NOTIFYs the app's existing realtime channel
-- ('replyo_events' — app/realtime.py LISTENs in every API process), and the API
-- forwards a slim "something changed" event to any dashboard socket registered under
-- the key 'admin:<tenant_id>'. The event carries no row data on purpose: clients
-- refetch over the authenticated HTTP API, so RLS still decides what they can see,
-- and the NOTIFY payload stays far below Postgres's 8000-byte cap.
--
-- A trigger (rather than app-level publish calls) catches every write path in one
-- place: the API process, the Telegram worker, knowledge-ingest background tasks,
-- even manual SQL in Supabase Studio.

create or replace function public.notify_admin_change() returns trigger
language plpgsql as $$
declare
    rec record;
begin
    if tg_op = 'DELETE' then rec := old; else rec := new; end if;
    -- Pre-multitenancy dev rows could lack a tenant; nobody can be subscribed to them.
    if rec.tenant_id is null then
        return null;
    end if;
    -- Same channel + envelope app/realtime.py already parses: {key, event}.
    perform pg_notify(
        'replyo_events',
        json_build_object(
            'key', 'admin:' || rec.tenant_id,
            'event', json_build_object(
                'type',  'change',
                'topic', tg_argv[0],       -- 'reviews' | 'knowledge'
                'op',    lower(tg_op),
                'id',    rec.id
            )
        )::text
    );
    return null;  -- AFTER trigger: the return value is ignored
end
$$;

drop trigger if exists pending_reviews_notify on pending_reviews;
create trigger pending_reviews_notify
    after insert or update or delete on pending_reviews
    for each row execute function public.notify_admin_change('reviews');

drop trigger if exists knowledge_sources_notify on knowledge_sources;
create trigger knowledge_sources_notify
    after insert or update or delete on knowledge_sources
    for each row execute function public.notify_admin_change('knowledge');

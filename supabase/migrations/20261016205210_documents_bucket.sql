-- ============================================================================
-- Phase 3 — private Storage bucket for uploaded PDFs.
-- The ingestion pipeline (server/ingest/store.ts) uploads with the service_role
-- key; the Phase 5 viewer gets short-lived signed URLs from a Nitro route.
-- Private + no storage.objects policies = no anon/authenticated access.
--
-- Guarded: the storage schema is created by Supabase's storage service, not by
-- Postgres itself, so it is absent in the plain supabase/postgres CI image.
-- ============================================================================

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('documents', 'documents', false, 20 * 1024 * 1024, array['application/pdf'])
    on conflict (id) do update
      set public = excluded.public,
          file_size_limit = excluded.file_size_limit,
          allowed_mime_types = excluded.allowed_mime_types;
  end if;
end $$;

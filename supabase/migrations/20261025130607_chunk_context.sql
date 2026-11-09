-- ============================================================================
-- Document titles and a per-chunk context column, searched with the content.
--
-- Applied to the hosted project on 2026-10-25 and committed now, unchanged, so
-- the repo's migrations match the hosted schema again. Dropping `fts` also
-- drops chunks_fts_idx (the init migration's index on it), so the index is
-- recreated under the same name on the new column.
-- ============================================================================

alter table documents add column title text;
comment on column documents.title is
  'Derived at ingestion: PDF metadata title, else the largest page-1 lines, else the filename stem (server/ingest/title.ts).';

alter table chunks add column context text not null default '';
comment on column chunks.context is
  'Contextual header (the document title): embedded with the chunk and searched by the keyword arm, never shown (ADR-0003).';

alter table chunks drop column fts;
alter table chunks add column fts tsvector
  generated always as (to_tsvector('english', context || ' ' || content)) stored;
create index chunks_fts_idx on chunks using gin (fts);

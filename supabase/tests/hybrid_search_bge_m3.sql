-- ============================================================================
-- Acceptance check for hybrid_search_bge_m3: it searches the new 1024-dim
-- column, ignores the old one, and is server-only. Rolls back. Needs an empty
-- `chunks`, so run it on a fresh database, not the hosted project.
-- ============================================================================

begin;

create function pg_temp.unit_vec(theta_deg float8) returns extensions.vector
language sql immutable as $$
  select (array[cos(radians(theta_deg)), sin(radians(theta_deg))]
          || array_fill(0::float8, array[1022]))::extensions.vector
$$;

do $$
declare
  doc uuid;
  labels int[];
begin
  if exists (select 1 from chunks) then
    raise exception 'chunks is not empty, run this check on a fresh database';
  end if;

  insert into documents (filename, page_count) values ('bge-m3-check.pdf', 1) returning id into doc;
  insert into chunks (document_id, page_number, content, embedding_bge_m3) values
    (doc, 1, 'first passage', pg_temp.unit_vec(5)),
    (doc, 2, 'second passage', pg_temp.unit_vec(60)),
    (doc, 3, 'not embedded with bge-m3 yet', null);

  select array_agg(page_number order by score desc) into labels
  from hybrid_search_bge_m3('zzzz', pg_temp.unit_vec(0)::extensions.vector(1024), 8);
  if labels is distinct from array[1, 2] then
    raise exception 'expected pages {1,2} in that order, got %', labels;
  end if;

  if has_function_privilege('anon', 'hybrid_search_bge_m3(text, extensions.vector, int, float, float, int, uuid, int)', 'execute') then
    raise exception 'anon can execute hybrid_search_bge_m3';
  end if;
  if not has_function_privilege('service_role', 'hybrid_search_bge_m3(text, extensions.vector, int, float, float, int, uuid, int)', 'execute') then
    raise exception 'service_role cannot execute hybrid_search_bge_m3';
  end if;
  raise notice 'hybrid_search_bge_m3: ok';
end $$;

rollback;

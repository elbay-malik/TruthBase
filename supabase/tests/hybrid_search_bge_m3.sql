-- ============================================================================
-- Acceptance check for hybrid_search_bge_m3: it searches the new 1024-dim
-- column, ignores the old one, returns each chunk's context (whose words the
-- keyword arm searches), and is server-only. Rolls back. Needs an empty
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
  hit record;
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

  -- 'quokka' is only in page 4's context: the keyword arm alone finds it, and
  -- the row carries the context next to the content.
  insert into chunks (document_id, page_number, content, context, embedding_bge_m3) values
    (doc, 4, 'continued table row', 'Table 9 header quokka', pg_temp.unit_vec(120));
  select array_agg(page_number) into labels
  from hybrid_search_bge_m3('quokka', pg_temp.unit_vec(0)::extensions.vector(1024), 8, semantic_weight => 0);
  if labels is distinct from array[4] then
    raise exception 'expected the keyword arm to find page {4} by its context, got %', labels;
  end if;
  select * into hit from hybrid_search_bge_m3('quokka', pg_temp.unit_vec(0)::extensions.vector(1024), 8, semantic_weight => 0);
  if hit.content is distinct from 'continued table row' or hit.context is distinct from 'Table 9 header quokka' then
    raise exception 'expected content and context of page 4, got % / %', hit.content, hit.context;
  end if;
  select * into hit from hybrid_search_bge_m3('zzzz', pg_temp.unit_vec(0)::extensions.vector(1024), 1);
  if hit.context is distinct from '' then
    raise exception 'expected an empty context by default, got %', hit.context;
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

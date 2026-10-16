-- ============================================================================
-- Phase 2 acceptance check: hybrid_search returns sensibly fused results.
--
-- Seeds a tiny corpus whose arm rankings are known by construction, asserts
-- the RRF fusion, weights, filters, stemming and access control, prints the
-- fused ranking, then ROLLS BACK — nothing persists. Safe to run on the hosted
-- project (SQL Editor, or psql) as long as `chunks` is still empty.
--
-- Embeddings are 2-D unit vectors padded to 768 dims: angle θ from the query
-- vector e1, so cosine similarity = cos θ and the semantic order is fixed.
--
--   label  content                         θ     keyword arm   semantic arm
--   1 (A)  verify backups, once            5°    rank 2        rank 1   ← both arms
--   2 (B)  backups/verify, repeated        60°   rank 1        rank 3   ← keyword-strong
--   3 (C)  synonyms only, no keywords      15°   –             rank 2   ← semantic-only
--   4 (D)  unrelated                       170°  –             rank 4
--   5 (E)  no embedding yet, no keywords   –     –             –        ← never returned
--
-- Expected RRF (k=50, weights 1): A = 1/52 + 1/51 > B = 1/51 + 1/53 > C = 1/52 > D = 1/54
-- `label` is stored in page_number to keep assertions readable.
-- ============================================================================

begin;

create function pg_temp.unit_vec(theta_deg float8) returns extensions.vector
language sql immutable as $$
  select (array[cos(radians(theta_deg)), sin(radians(theta_deg))]
          || array_fill(0::float8, array[766]))::extensions.vector
$$;

do $$
begin
  if exists (select 1 from chunks) then
    raise exception 'chunks is not empty — run this check on a fresh database (it asserts exact rankings)';
  end if;
end $$;

insert into documents (id, filename) values
  ('00000000-0000-0000-0000-00000000d001', 'seed-recovery.pdf'),
  ('00000000-0000-0000-0000-00000000d002', 'seed-other.pdf');

insert into chunks (document_id, page_number, content, embedding) values
  ('00000000-0000-0000-0000-00000000d001', 1,
   'Before restoring service, the recovery team must verify the integrity of backups and other restoration assets.',
   pg_temp.unit_vec(5)),
  ('00000000-0000-0000-0000-00000000d001', 2,
   'Backups: verify backups. Verified backups, verified backup copies, backups verified daily.',
   pg_temp.unit_vec(60)),
  ('00000000-0000-0000-0000-00000000d002', 3,
   'Restoration assets must be checked for integrity prior to being used.',
   pg_temp.unit_vec(15)),
  ('00000000-0000-0000-0000-00000000d002', 4,
   'Risk tolerance is highly contextual and application specific.',
   pg_temp.unit_vec(170)),
  ('00000000-0000-0000-0000-00000000d002', 5,
   'Pending chunk whose embedding has not been computed yet.',
   null);

do $$
declare
  q constant extensions.vector := pg_temp.unit_vec(0);
  labels int[];
  top_score float8;
begin
  -- 1. Fusion: the row strong in BOTH arms beats each single-arm winner.
  select array_agg(page_number order by ord) into labels
  from hybrid_search('verify backups', q, 10) with ordinality as r(id, document_id, page_number, content, highlight, created_at, score, ord);
  assert labels = array[1, 2, 3, 4], format('default fusion order: got %s, want {1,2,3,4}', labels);

  -- 2. Score is exactly Σ weight / (k + rank).
  select score into top_score from hybrid_search('verify backups', q, 1);
  assert abs(top_score - (1.0/51 + 1.0/52)) < 1e-9, format('RRF score of top row: got %s', top_score);

  -- 3. Weights: keyword arm off → pure semantic order.
  select array_agg(page_number order by ord) into labels
  from hybrid_search('verify backups', q, 10, full_text_weight => 0) with ordinality as r(id, document_id, page_number, content, highlight, created_at, score, ord);
  assert labels = array[1, 3, 2, 4], format('semantic-only order: got %s, want {1,3,2,4}', labels);

  -- 4. Weights: semantic arm off → keyword winners first.
  select array_agg(page_number order by ord) into labels
  from hybrid_search('verify backups', q, 10, semantic_weight => 0) with ordinality as r(id, document_id, page_number, content, highlight, created_at, score, ord);
  assert labels[1:2] = array[2, 1], format('keyword-only top 2: got %s, want {2,1,…}', labels);

  -- 5. Document filter applies to both arms.
  select array_agg(page_number order by ord) into labels
  from hybrid_search('verify backups', q, 10, filter_document_id => '00000000-0000-0000-0000-00000000d002') with ordinality as r(id, document_id, page_number, content, highlight, created_at, score, ord);
  assert labels = array[3, 4], format('filtered to doc 2: got %s, want {3,4}', labels);

  -- 6. match_count caps the result.
  assert (select count(*) from hybrid_search('verify backups', q, 2)) = 2, 'match_count = 2 should return 2 rows';

  -- 7. No keyword hits → semantic arm alone still answers.
  select array_agg(page_number order by ord) into labels
  from hybrid_search('zebra', q, 10) with ordinality as r(id, document_id, page_number, content, highlight, created_at, score, ord);
  assert labels = array[1, 3, 2, 4], format('no-keyword query: got %s, want {1,3,2,4}', labels);

  -- 8. English stemming: inflected query matches the same keyword rows.
  select array_agg(page_number order by ord) into labels
  from hybrid_search('verified backup', q, 10, semantic_weight => 0) with ordinality as r(id, document_id, page_number, content, highlight, created_at, score, ord);
  assert labels[1:2] = array[2, 1], format('stemmed query top 2: got %s, want {2,1,…}', labels);

  raise notice 'hybrid_search: all fusion assertions passed';
end $$;

-- 9. Access control: anon sees no chunks (RLS), cannot call the RPC, can read keep_alive.
set local role anon;
do $$
begin
  assert (select count(*) from chunks) = 0, 'anon must not see chunks (RLS)';
  assert (select count(*) from documents) = 0, 'anon must not see documents (RLS)';
  assert (select count(*) from keep_alive) >= 1, 'anon must be able to read keep_alive';
  begin
    perform hybrid_search('verify backups', array_fill(0.1::float8, array[768])::extensions.vector, 10);
    raise exception 'anon was able to execute hybrid_search';
  exception when insufficient_privilege then
    if sqlerrm not like '%hybrid_search%' then
      raise; -- denied for some other reason: not the check we meant
    end if;
  end;
  raise notice 'access control: all assertions passed';
end $$;
reset role;

-- Human-readable view of the fused ranking.
select page_number as label, round(score::numeric, 6) as rrf_score, left(content, 60) as content
from hybrid_search('verify backups', pg_temp.unit_vec(0), 10);

rollback;

# ADR-0006: Why hybrid search, and how it is tuned

- **Status:** Accepted
- **Date:** 2026-10-19

## Context

Phase 2 shipped `hybrid_search`: a keyword arm (Postgres full-text search) and a semantic arm (pgvector cosine), fused with Reciprocal Rank Fusion. The post-Phase-5 audit's corrected eval showed it wasn't earning its keep. Hybrid recall@8 was 76%, the same as dense-only, and the keyword arm alone found the evidence for only 27% of answerable golden questions.

The cause was the keyword query. `websearch_to_tsquery` ANDs every term, so a natural-language question such as "How does RAPTOR cluster text chunks?" only matches a chunk that contains every stemmed word. Few do. The arm returned nothing for most questions, and hybrid fell back to dense.

Phase 6's acceptance criterion (SPEC): hybrid beats dense-only on golden recall@k, overall and on the `keyword` / `paraphrase` tag slices, with the numbers recorded.

## Decision

`hybrid_search` v2 (`supabase/migrations/20261019120000_hybrid_search_v2.sql`):

1. **The keyword arm matches any query term.** The query is the OR of the question's own lexemes, taken straight from `to_tsvector`, the parser that builds the indexed `fts` column. "What does PR.DS-11 require?" becomes `'-11' | 'pr.ds' | 'requir'`, exactly the tokens the document holds. Punctuation-joined words ("logging,monitoring") split the same way, and quotes or a leading `-` are plain text. A first version that regex-split the raw text and OR'ed it through `websearch_to_tsquery` broke control IDs (`-11` became `11`, which never matches) and phrase-matched punctuation-joined words. The arm ranks with `ts_rank_cd`.
2. **The defaults come from the tuning grid:** keyword weight **0.5**, semantic weight **1**, RRF **k = 60** and **40 candidates per arm** (v1 used 2 × `match_count`, 16 for the chat's top 8). The TypeScript wrapper omits unset parameters, so the SQL defaults are the single source of truth.
3. **The semantic arm stays an exact cosine scan** (as in v1). An index-friendly rewrite with `hnsw.iterative_scan` was tried and dropped. A SQL function's body is planned generically, and the planner chose Seq Scan + top-N sort over the HNSW index even at 50k rows. Forcing the index made document-filtered searches come back short (24 of 30 rows at 50k rows) once the iterative scan hit its tuple limit. Exact is exhaustive and deterministic, and the review measured about 0.1 s at 50k rows.
4. **Order is deterministic.** Score ties break by semantic rank, then chunk id, and rows with score 0 are dropped (a zero-weight arm adds no filler rows).

## Rationale

Measured with `pnpm tune:retrieval` on a local copy of the corpus (564 chunks; the hosted project's data, synced with `--sync`) and the 45 answerable golden questions, using cached Gemini query embeddings. A question counts at k when **all** its evidence spans are in the top k. The harness runs each arm exactly as the function does and fuses in TypeScript, and `--function` confirms that the installed function reproduces the chosen row.

| Configuration | recall@5 | recall@8 | recall@10 | MRR | filtered @8 |
|---|---|---|---|---|---|
| Dense only | 60% | 76% | 78% | 0.495 | 78% |
| Keyword only, v1 (AND) | 27% | 27% | 27% | 0.239 | 29% |
| Keyword only, OR + `ts_rank_cd` | 51% | 60% | 71% | 0.335 | 61% |
| Keyword only, OR + `ts_rank` | 64% | 67% | 71% | 0.529 | 66% |
| Hybrid v1 (AND, k 50, weights 1/1) | 62% | 76% | 78% | 0.513 | 78% |
| **Hybrid v2 (OR, `ts_rank_cd`, k 60, 0.5/1, 40)** | **76%** | **87%** | **87%** | 0.515 | **88%** |

"Filtered" repeats each single-document question with the document filter on, as the chat UI's filter does (n = 41).

**Guarding against overfitting.** The grid has 72 hybrid configurations:
- keyword query: OR, or AND with an OR fallback
- rank function: `ts_rank_cd` or `ts_rank`
- RRF k: 10, 30 or 60
- weights: 1/1, 0.5/1 or 1/0.5
- pool: 20 or 40

With only 45 questions, one question moves a metric by 2.2 points, so the best single row is partly noise. Two checks:

- **Cross-validation of the selection procedure.** 200 random 5-fold splits, each picking the best configuration on 80% of the questions (recall@8 + ½ MRR) and scoring it on the held-out 20%. Held-out averages:
  - selection procedure: recall@5 **70%**, @8 **84%**, MRR 0.517
  - v1: 62% / 76% / 0.513
  - dense-only: 60% / 76% / 0.495

  So the gain survives on unseen questions, and MRR doesn't move.
- **A plateau, not a peak.** The shipped configuration isn't the argmax. It is the family with the best *worst case*: OR + `ts_rank_cd` + weights 0.5/1 stays at 82–87% recall@8 for every k (10/30/60) and pool (20/40), with a mean of 84.4%. The next family reaches 80–84%. Within it, k = 60 is the literature default (Cormack et al.), and the 40-row pool gives the Phase 7 reranker room.

**Tag slices** (recall@5 · recall@8, v1 → v2): `keyword` 3/5 · 4/5 → 4/5 · 5/5, `paraphrase` 2/3 · 3/3 → 3/3 · 3/3, `factoid` 4/9 · 6/9 → 7/9 · 8/9, `table` 4/6 · 5/6 → 4/6 · 6/6, `cross-document` 1/4 · 2/4 → 2/4 · 3/4. No slice got worse. The slices hold 1–11 questions, so they are a consistency check, not evidence on their own.

**Why the keyword weight is 0.5.** Over the six k × pool settings, down-weighting the keyword arm beats equal weights in five, on average (recall@8 0.844 vs 0.822) and in the worst case (0.822 vs 0.800). OR matching is loose, and frequent terms like "framework" or "risk" pull in many weak matches. The semantic arm is the better ranker, and the keyword arm adds the exact-term hits it misses (control IDs, acronyms, table values).

**Why `ts_rank_cd` over `ts_rank`.** `ts_rank` is the better ranker inside the keyword arm on its own (64% vs 51% @5). Fused, `ts_rank_cd` gives higher recall@8 (84.4% vs 80.4% averaged over the weights-0.5/1 family) at about the same MRR (0.519 vs 0.524). Recall@8 is what the chat uses, and Phase 7's reranker reorders the top of the list anyway.

**Index behaviour.** The HNSW index exists, but no query uses it (v1 didn't either). At 564 chunks, exact search costs nothing. If Phase 11 uploads grow the corpus past ~10⁵ chunks, an index path needs a PL/pgSQL body (so the plan sees the real LIMIT), separate filtered and unfiltered branches, and an exact scan for single-document searches.

## Rejected alternatives

- **Strict AND with an OR fallback when AND finds fewer than 3 rows:** never better in any of the six k × pool settings (family mean recall@8 0.822 vs 0.844), and it costs an extra count query.
- **The cross-validation's most frequent pick** (OR, `ts_rank_cd`, k 10, 0.5/1, pool 40: 69% / 87% / 87%, MRR 0.531): same family and the same recall@8. It was chosen on noise between neighbours, and k = 10 makes a single arm's top ranks dominate.
- **Equal weights (v1's 1/1):** lower recall@8 on average and in the worst case across k and pool (see above).
- **A learned or linear score fusion:** 45 questions can't fit it without overfitting, and RRF needs no score calibration across the two arms.
- **An external vector DB:** unnecessary at this scale, and not free (EXECUTION_PLAN Phase 6).
- **HNSW with `hnsw.iterative_scan` inside the SQL function:** not used by the generic plan, and short results under a document filter when forced (see Decision 3).

## Consequences

- The defaults live in SQL. Tuning them again is `create or replace`, not an app deploy, and `pnpm tune:retrieval --function` checks the installed function against the golden set.
- `supabase/tests/hybrid_search.sql` (CI `db` job) asserts the OR matching (including a hyphenated control ID), the new default scores, `candidate_count` and the absence of zero-score rows.
- OR matching computes `ts_rank_cd` for every chunk that shares a word with the question. That's cheap at this size. At 10⁵+ chunks, consider a `ts_rank` cut-off or a GIN-friendly pre-filter.
- Revisit when the corpus or golden set changes materially, or with Phase 7: a reranker may prefer a bigger pool or different weights.

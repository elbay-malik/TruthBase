# ADR-0013: Leaving Gemini for bge-m3 on Cloudflare

- **Status:** Accepted
- **Date:** 2026-11-04

## Context

Every question and every chunk went through `gemini-embedding-001` (768 dims, ADR-0001, ADR-0002). Gemini's terms allow only Paid Services for users in the EEA, Switzerland or the UK, and the owner won't pay. The answer fallback had already moved to Cloudflare Workers AI on 2026-11-03, which left the terms problem open for embeddings (ADR-0005 note). The Cloudflare account was already in use for that fallback, and its free plan gives 10,000 Neurons a day, with requests failing over quota rather than billing.

The switch had to keep the demo's answers as good as they were, measured on the golden set, and at 0 EUR/month.

## Decision

1. **Embeddings are `@cf/baai/bge-m3` on Cloudflare Workers AI**, 1024 dims, L2-normalized (`server/ingest/embed.ts`).
2. **Documents are embedded as `title\n\ncontent`** (`server/ingest/title.ts`), and questions are embedded bare. The title isn't stored in `chunks.content`.
3. **A new column and function:** `chunks.embedding_bge_m3` and `hybrid_search_bge_m3`, which is `hybrid_search` v2 with only the column and vector size changed (`supabase/migrations/20261104120000_bge_m3_column.sql`).
4. **`RERANK_CANDIDATES` goes from 15 to 20.** bge-m3 ranks some evidence lower than Gemini did: the fused top 20 holds it for 40 of 45 golden records against 38 in the top 15.
5. **Cloudflare is required.** Chat, search and ingest answer 503 without `NUXT_CLOUDFLARE_ACCOUNT_ID` and `NUXT_CLOUDFLARE_API_TOKEN`.
6. **Removal follows after a 7-day soak:** `NUXT_GEMINI_API_KEY`, which now only serves the explicit `gemini` model choices, the old column, the old function and `@ai-sdk/google`.

## Rationale

**Retrieval without LLM steps got weaker at recall and slightly better at order.** `pnpm eval:retrieval`, question only, 45 answerable ([retrieval-baseline.json](../evals/retrieval-baseline.json), [retrieval-baseline-gemini.json](../evals/retrieval-baseline-gemini.json)):

| Embedding | recall@5 | recall@8 | recall@10 | recall@15 | MRR | nDCG@5 |
|---|---|---|---|---|---|---|
| bge-m3 | 33/45 (73%) | 34 (76%) | 34 (76%) | 38 (84%) | 0.548 | 0.640 |
| Gemini | 34/45 (76%) | 39 (87%) | 39 (87%) | 39 (87%) | 0.515 | 0.633 |

**The full pipeline held.** The go/no-go ran rewrites, fusion, reranking, answers and the judge on the 50 golden records in a one-off harness, 2026-11-02 to 2026-11-03 ([bge-m3-cutover.json](../evals/bge-m3-cutover.json)). The Gemini arm's answer figures cover 47 of the 50 records.

| Metric | bge-m3, 20 candidates | Gemini, 15 candidates |
|---|---|---|
| Chat, final top 8 | 39/45 | 39/45 |
| Question only after reranking, recall@10 | 38/45 | 39/45 |
| Chat MRR | 0.769 | 0.746 |
| Faithfulness | 100% | 95.7% |
| Citation precision | 95.0% | 92.4% |
| Unanswerable refused | 5/5 | 5/5 |
| False refusals | 3 (g-027, g-032, g-040) | 4 |

- **One gate failed:** question only after reranking, recall@10, 38/45 against 39/45. The owner accepted it. Against Gemini, bge-m3 gains g-030 and loses g-026 and g-043 (rank 11); chat rewrites recover g-026. Going from 15 to 20 candidates fixes g-028.
- **Blind correctness grading** on the answerable records gave 38 correct, 3 partial, 0 wrong and 4 no answer, the same as Gemini. The fourth no answer is g-035, a hedge that says the source doesn't give the answer, rather than a refusal.

## Rejected alternatives

- **Paying for Gemini:** it would satisfy the terms, but the owner won't pay.
- **Staying on Gemini's unpaid tier:** the terms don't allow it for users in the EEA, Switzerland or the UK.
- **bge-m3 without the title in front:** it lost 5-8 golden records in the 2026-11-02 bake-off, because a chunk often doesn't name its own document.
- **Keeping 15 candidates:** the fused top 15 holds evidence for 38 of 45 records, the top 20 for 40.
- **Replacing the `embedding` column in place:** the vectors have different dimensions and come from a different model. A new column let both run side by side until the app switched, and it leaves the old deployment runnable during the soak.

## Consequences

- **`/api/search` is weaker than it was.** It has no rewrites or reranker, so it sees 34/45 in the top 8, where Gemini had 39/45.
- **Fewer enhanced chats a day.** 20 candidates is about 4.2K reranker tokens per chat against 3.1K, so about 40 fully enhanced chats a day on Groq's 200K tokens/day for gpt-oss-20b. When the reranker's quota is spent, the answer still works from fused order, which is 34/45 in the top 8 rather than 39.
- **Cloudflare is now a hard dependency.** Without its two values the routes answer 503, and past 10,000 Neurons in a day embedding requests fail. The same Neurons pay for the answer fallback.
- **`/api/search` errors are clearer:** 503 "busy" on provider limits, 502 otherwise.
- **The Gemini-era evals were not re-run.** The Phase 5 to 9 tables and `phase-*.json` stay as dated history. `pnpm eval:llm` measures the bge-m3 pipeline from here on.
- **The hosted migration list lacks `20261104120000_bge_m3_column.sql`,** because it was pasted into the SQL Editor (DEPLOYMENT §0).
- **Revisit** if the free Neurons stop covering the demo, or if the reranker's quota runs out often enough that most chats see fused order.

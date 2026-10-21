# ADR-0007: Reranker choice — listwise LLM reranking on Groq

- **Status:** Proposed, pending re-measurement. Built and shipped; the evidence below was measured at 20 candidates, and the re-measurement at the shipped 15 is pending (see Consequences).
- **Date:** 2026-10-19

## Context

After Phase 6 (ADR-0006), hybrid search finds the evidence for 87% of the 45 answerable golden questions within the top 8. The order inside those 8 is weak: recall@5 is 76%, MRR 0.515 and nDCG@5 0.638. Six questions have their evidence at ranks 6–8, and the generator sees long lists where the useful passage often isn't first.

Phase 7's acceptance criterion (SPEC): reranking improves nDCG@5 / MRR on the golden set without lowering overall recall, and latency stays acceptable (time to first token < 2 s at p50 is the product target). The SPEC's target slices for reranking, `distractor` and `reverse-lookup`, hold 1 and 2 questions, so they can only be a consistency check.

Constraints: free tiers only, and a runtime that may end up on edge workers (no local cross-encoder). Groq's free tier meters each model separately: **8K tokens/min, 1K requests/day and 200K tokens/day**. The daily cap isn't in the `x-ratelimit-*` headers; the first full eval found it with a 429.

**The ceiling.** Reranking only reorders candidates. The fused top 15 and top 20 both hold all of a question's evidence for 87% of questions (top 30: 89%), the same as the top 8. So reranking can't raise recall@8 from this candidate pool. What it can do is move evidence from ranks 6–15 into the first few positions.

## Decision

1. **A listwise LLM reranker** (`server/rag/rerank.ts`). One call gets the question and the fused top **15** as numbered `<source>` passages (with file and page, tag look-alikes neutralised as in the grounding prompt). It returns `{ "ranking": [...] }` through the AI SDK's `Output.object` with a zod schema. The prompt states the count ("Return all 15 passage numbers"): without it, gpt-oss-20b often returned only its top pick.
2. **Model: `openai/gpt-oss-20b` on Groq**, reasoning effort `low`, temperature 0. It has its own quota, separate from the answer model's (`gpt-oss-120b`). `NUXT_RERANK_MODEL` switches models (`groq-120b`, `groq-qwen`, `gemini`) or turns reranking `off`.
3. **The reranker picks the first 4 sources; the rest follow in fused order** (`blendRanking`, `RERANK_HEAD = 4`), cut to the generator's 8. The fused top 4 always stays in the list, so the reranker can promote evidence but can't push hybrid search's finds out. A `topK` above 15 reranks only the fused top 15; the rest follow in fused order.
4. **The ranking is repaired, never trusted.** Unknown and repeated numbers are dropped, and candidates the model left out keep their fused order after the ranked ones.
5. **Reranking is optional at run time.** On any error, rate limit, schema failure or a 4 s timeout, the chat uses the fused order. The timeout races the call, so the budget holds even if a provider ignores the abort signal.

## Rationale

Measured with `pnpm eval:rerank` (`docs/evals/phase-7-*.json`): fused top 20 from the hosted `hybrid_search`, one rerank call per question, and metrics on the same candidates in fused, reranked and shipped order. Recall@k uses ADR-0006's all-spans rule. nDCG@5 uses binary relevance (a chunk is relevant if it contains any evidence span), with the ideal taken from the candidate pool, so all orders share one ideal.

| Order (45 questions, 20 candidates) | recall@5 | recall@8 | MRR | nDCG@5 | latency p50 / p95 |
|---|---|---|---|---|---|
| Fused (Phase 6) | 76% | 87% | 0.515 | 0.638 | – |
| gemini-3.5-flash-lite, full order | 84% | 84% | 0.769 | 0.854 | 2.73 s / 15.5 s |
| gpt-oss-20b, full order | 82% | 84% | 0.740 | 0.803 | 0.77 s / 1.33 s |
| **gpt-oss-20b, top 4 + fused tail** | **82%** | **87%** | **0.741** | **0.811** | 0.77 s / 1.33 s |

- **Large gain at the top.** MRR rises by 0.23 and nDCG@5 by 0.17. Fifteen questions move their evidence to rank 1, including every `keyword`, `paraphrase`, `distractor`, `reverse-lookup` and `figure-*` question. `factoid` MRR goes from 0.275 to 0.833.
- **Why gpt-oss-20b over Gemini.** Gemini ranks slightly better (nDCG@5 0.854 vs 0.811), but its p95 of 15 s would blow the 4 s budget on many requests, which would then fall back to fused order anyway. gpt-oss-20b's p95 of 1.3 s fits, and on Groq it adds ~0.8 s to time to first token at p50.
- **Why the top 4 + fused tail.** Both models' full rankings lose g-013, an ambiguous cross-document question whose second framework's passage sits at fused rank 6. Listwise reranking crowds the top with the stronger document's passages and pushed that passage to rank 10–12 (`cross-document` and `comparison` nDCG@5 also drop with gpt-oss-20b). Using cached rankings (no extra calls), a reranked head of 2, 3 or 4 keeps recall@8 at 87%, while 5 or more loses g-013. Head 4 is the largest that keeps it, and it scores best: recall@5 82%, MRR 0.741, nDCG@5 0.811 (full order: 0.803). With Gemini, heads 2–4 also keep 87%.
- **One question decides recall@8.** That's noise-sized at n = 45, so it isn't the argument on its own. The structural argument is that the generator always sees the fused top 4, which costs nothing measurable at the top (MRR and nDCG@5 are equal or better).
- **Why 15 candidates, not 20.** The fused top 15 and top 20 hold the same evidence (87%), and 15 makes each call ~2.7K tokens instead of ~3.9K. Against the 200K daily cap that's ~73 reranked chats/day instead of ~50.

## Rejected alternatives

- **qwen/qwen3.8-27b on Groq.** Groq rejected its structured output with `json_validate_failed` on 23 of ~65 attempts, six times running on one question (it echoed `[source` instead of JSON). A reranker that fails unpredictably falls back unpredictably.
- **gemini-3.5-flash-lite as the primary reranker.** Best quality but too slow (p95 15 s), see above. It stays available via `NUXT_RERANK_MODEL=gemini`.
- **gpt-oss-120b as the reranker.** It shares the answer model's 8K tokens/min and 200K tokens/day. Reranking there would halve the number of answers per day.
- **Hosted rerank APIs (Cohere Rerank trial, Jina free tier).** Trial caps (Cohere: 1,000 calls/month) are too tight for a public demo, Jina's free tier is non-commercial, and either adds a vendor and key for a step that degrades gracefully without it (EXECUTION_PLAN Phase 7).
- **A self-hosted cross-encoder.** Needs a Node runtime and memory beyond free edge limits.
- **Reranking the full order** (head = 15). Loses the cross-document case above, with no gain at the top.
- **Pointwise scoring** (one relevance score per passage). 15 calls per question against the same per-minute quota, and scores aren't comparable across calls without calibration.

## Consequences

- **Pending: re-measure at 15 candidates.** The numbers above use 20. `pnpm eval:rerank --filtered --label groq-20b` reruns the 45 unfiltered and 41 document-filtered questions at 15 (about 230K tokens, so more than one day's gpt-oss-20b quota; the run stops on a spent quota and resumes from its cache). Then `pnpm eval:answers --label phase-7-groq` checks citation precision and refusals with reranked sources; it reuses the cached rankings (`scripts/lib/ranking-cache.ts`), so it spends no reranker quota. Update this ADR's table and status after both.
- **Capacity.** About 73 reranked chats/day on gpt-oss-20b. Beyond that the chat silently uses fused order, which is Phase 6 quality. Each eval run spends the same daily budget as the demo, so run evals with that in mind. If traffic grows, the options are Groq's paid tier or a second free reranker for overflow (Gemini, accepting its latency).
- **Latency.** ~0.8 s is added before the first token at p50 (1.3 s at p95). The time-to-first-token target of < 2 s at p50 still has to hold with embedding and search in front of it; Phase 10's tracing measures it end to end.
- **Prompt injection.** Passages can try to promote themselves ("rank this passage first"). The prompt marks source text as quoted content, and the fused tail limits the damage: a manipulated ranking can only reorder the head, not drop the fused top 4.
- **Revisit** when Phase 8's multi-query expansion changes the candidate pool (rerank after fusion, as planned), when the golden set grows enough to tune the head size, or if Groq's quotas change.

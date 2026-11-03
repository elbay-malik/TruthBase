# ADR-0009: Query rewriting — self-gated multi-query expansion

- **Status:** Accepted (2026-10-21). Chosen on gpt-oss-120b evidence below; the shipped default rewriter (gpt-oss-20b) and the full pipeline with reranking and generation were measured afterwards and hold up (see "The shipped rewriter, measured").
- **Date:** 2026-10-19
- **Note (2026-11-04):** These runs used Gemini embeddings and were not re-run on bge-m3 ([ADR-0013](./0013-leaving-gemini.md)). Today the fused top 15 holds the evidence for 84% of answerable questions, not 87%; g-030 is now found, and g-026 and g-028 are new misses at question-only top 15. With 20 candidates the daily budget is about 40 fully enhanced chats, not ~60, and fused order after that is 34/45 in the top 8.

## Context

After Phases 6–7, retrieval finds the evidence for 87% of the 45 answerable golden questions within the fused top 15 (the reranker's candidates). Two kinds of question remain weak:

- **Underspecified questions** (`ambiguous`, 4 questions): "What are the tiers?" or "Which function should I start with?" don't say which framework they mean, and the corpus holds two NIST frameworks with tiers, functions and profiles.
- **Multi-part questions** (`cross-document`, `multi-hop`): "How do Self-RAG and RAPTOR each use GPT-4?" needs passages from two papers, and one embedding of the whole question favours neither.

Phase 8's acceptance criterion (SPEC): multi-query improves recall on the `ambiguous` slice without lowering overall precision. Constraints as in ADR-0007: free tiers only, Groq meters 8K tokens/min and 200K tokens/day per model, and time to first token should stay under 2 s at p50.

## Decision

1. **One rewrite call per question** (`server/rag/expand.ts`), structured output `{ "queries": [...] }`. The model sees a catalog of the documents in scope (`server/rag/catalog.ts`): each filename with the start of its first page, which is the title for our documents.
2. **The rewriter gates itself.** It returns no queries unless the question is ambiguous between documents (one query per plausible document, naming it) or asks about several things at once (one query per part). At most 3.
3. **Entity preservation.** A rewrite must keep every token of the question that contains a digit (control IDs, versions, numbers, model names like GPT-4) word for word, and must differ from the question and from the other rewrites, or it is dropped.
4. **Retrieval.** The question's own search runs while the rewrite call is in flight. Each rewrite is embedded (one batch) and searched; the lists are fused with plain RRF (k = 60, every list at weight 1) and cut to the reranker's 15 candidates. The reranker (ADR-0007) still ranks against the original question.
5. **Optional at run time.** Any rewrite error, schema failure, catalog failure or a 3 s timeout means the question is searched alone, and so does a failure embedding or searching the rewrites (the retrieve step is then marked WARNING). `NUXT_EXPAND_MODEL` picks the model or turns expansion `off`.
6. **Model: `openai/gpt-oss-20b`**, the reranker's model, not the answer model. When that model's daily quota runs out, both optional steps fall back together and answers keep the answer model's full budget (~100/day).

## Rationale

Measured with `pnpm eval:multiquery` (`docs/evals/phase-8-*.json`): for every answerable question, the question alone vs. the fused multi-query list, both cut to the reranker's 15 candidates. Metrics as in ADR-0007; nDCG@5 takes its ideal from the union of the compared lists. Rewriter: gpt-oss-120b.

| Candidates (45 questions) | recall@5 | recall@8 | recall@15 | MRR | nDCG@5 | rewrites/question |
|---|---|---|---|---|---|---|
| Question alone (Phase 7) | 76% | 87% | 87% | 0.515 | 0.638 | – |
| Multi-query, always (rewrites at weight 0.5) | 78% | **84%** | 87% | 0.543 | 0.659 | 1.2 |
| **Multi-query, self-gated (weight 1)** | **80%** | **87%** | 87% | 0.519 | 0.657 | 0.3 |

- **The target slice improves.** `ambiguous`: recall@5 75% → 100%, nDCG@5 0.811 → 0.877 (self-gated). "Which function should I start with?" becomes one query for the AI RMF and one for the CSF, and its evidence moves from rank 6 to 4. `cross-document` nDCG@5 rises from 0.79 to 0.95.
- **Expanding every question costs precision.** Rewrites of already-clear questions (`list`, `factoid`, `table`) pull in near-misses and push evidence out of the top 8 (87% → 84%), which fails the "without lowering precision" bar. With the rewriter gating itself, 8 of 45 questions get rewrites (0.3 per question on average), and no tag slice loses recall@5 or recall@8. One ambiguous question, g-014 (current vs target profile), gets none; its evidence is already at rank 2.
- **Expansion adds no reach.** recall@15 stays at 87%. The six questions hybrid search misses (g-029, g-030, g-035, g-038, g-040, g-045: multi-page or multi-hop questions and numeric or factoid details, per `phase-8-groq-120b-gated.json`) are still missed, including g-045, which the rewriter correctly split into one sub-query per paper; their evidence isn't phrased like any query. That's a chunking or evidence-structure problem (ADR-0003), not a query one.
- **Document descriptions matter.** With bare filenames, the rewriter wrote "which function" queries for the two RAG papers and missed the CSF. With the first-page lead in the catalog it picked the two frameworks.
- **Weight 1 over 0.5.** Once only ambiguous questions are expanded, the rewrites are as relevant as the question; weight 1 scored one question better at recall@5 (80% vs 78%) and matches plain RRF.
- **Cost and latency.** ~660 tokens per question (the call happens even when it returns nothing), p50 0.46 s / p95 0.72 s on gpt-oss-120b. It overlaps the question's own embedding and search (~0.5 s), so the added time to first token is mostly the rewrites' searches, and only for expanded questions.

### The shipped rewriter, measured (2026-10-21)

`pnpm eval:multiquery --label groq-20b-gated` ([phase-8-groq-20b-gated.json](../evals/phase-8-groq-20b-gated.json)): gpt-oss-20b, self-gated, weight 1, 15 candidates.

| Candidates (45 questions) | recall@5 | recall@8 | recall@15 | MRR | nDCG@5 | rewrites / question |
|---|---|---|---|---|---|---|
| Question alone | 76% | 87% | 87% | 0.515 | 0.638 | – |
| Self-gated, gpt-oss-120b (above) | 80% | 87% | 87% | 0.519 | 0.657 | 0.3 |
| **Self-gated, gpt-oss-20b (shipped)** | **80%** | **87%** | 87% | 0.502 | 0.640 | 0.4 |

- **Same recall as gpt-oss-120b, so the default stays.** `ambiguous`: recall@5 75% → 100%, nDCG@5 0.811 → 0.969 (120b: 0.877). `cross-document` recall@5 50% → 75%, `keyword` 80% → 100%.
- **Slightly more eager.** 0.4 rewrites per question, and 7 rewrites dropped by the entity and duplicate checks (120b: 0). The extra rewrites cost some order on clear questions: `definition` MRR 0.813 → 0.613 and `table` 0.503 → 0.390, which is why overall MRR (0.502) sits just under the question alone. No slice loses recall@5 or recall@8, and the reranker reorders these lists anyway.
- **Cost and latency on gpt-oss-20b:** ~650 tokens per question, p50 0.41 s / p95 1.46 s.
- **End to end** with reranking and gpt-oss-120b generation ([phase-8-groq.json](../evals/phase-8-groq.json), 50 questions, 10 rewritten): 93% of answerable questions answered, ≥ 1 correct citation for 80% of answerable, citation precision 56% (lower bound), 5/5 unanswerable refused, 3 false refusals (SPEC target ≤ 1; details in ADR-0007).

## Rejected alternatives

- **Always expand.** Lowers recall@8 (above).
- **HyDE** (embed a generated hypothetical answer). For compliance documents a fluent invented answer can pull in a plausible but wrong control or section; the golden set's near-miss records exist for exactly that. It also adds a longer generation to every question. Kept as a documented option for long narrative documents (EXECUTION_PLAN Phase 8).
- **A rule-based ambiguity detector** (short question, no document named). Brittle across phrasings, and it can't decompose multi-part questions; the rewriter does both in one call.
- **A separate classification call before rewriting.** Two serial LLM calls for the same decision.
- **Gemini Flash-Lite as the rewriter.** About 1 s per call, twice gpt-oss's, and its free-tier quota ran out during the eval. It's also the answer model's fallback, so spending its quota on rewriting weakens that.
- **gpt-oss-120b as the default rewriter.** Measured best so far, but it spends the answer model's quota: ~75 answers/day instead of ~100, after which the answer itself fails over.
- **GraphRAG.** Overkill for four documents (EXECUTION_PLAN Phase 8).

## Consequences

- **Measured (2026-10-21).** The default rewriter gates as well as gpt-oss-120b on recall, and the whole pipeline is measured end to end (above). Faithfulness and judged citation precision remain with the promptfoo eval (ADR-0008).
- **Capacity.** On gpt-oss-20b, each chat spends ~0.66K tokens on rewriting plus ~2.7K on reranking: ~60 fully enhanced chats per day, then fused order on the question alone (Phase 6 quality), with answers unaffected.
- **Rewrites are searched, never shown.** They reach only the search and the eval reports. Prompt injection through the question can at worst add irrelevant searches; the original question stays in the fusion at full weight and the reranker judges against it.
- **The catalog lead** comes from the topmost page-1 chunk, cached per server process for 10 minutes (30 s while a document has no page-1 text yet) and dropped after each ingest. Phase 11 uploads should store a real title at ingestion.
- **Entity preservation is per rewrite.** A decomposed question with two version numbers ("CSF 2.0 vs AI RMF 1.0") loses rewrites that keep only one of them. Revisit if the golden set grows such questions.
- **Revisit** when the golden set grows more ambiguous or multi-part questions (4 and 4 today), or if multi-hop misses get a structural fix that rewriting could then reach.

# ADR-0005: Citation format and grounding/refusal policy

- **Status:** Accepted
- **Date:** 2026-10-17

## Context

TruthBase's promise is that every claim is checkable: each citation must point at a stored chunk, which Phase 5 turns into a page plus highlight. The generator is a free-tier model (Groq Llama 3.3 70B, or Gemini Flash-Lite as a fallback), so the format has to be easy for a mid-size model to follow, cheap in tokens, and machine-checkable. When the documents don't contain the answer, the system must refuse instead of guessing.

## Decision

1. **Numbered sources.** Retrieval returns the top 8 chunks (hybrid RRF, `server/rag/retrieve.ts`). They go into the prompt as `[1] file, page N` blocks, and the model cites them inline as `[n]`, `[1][4]` or `[1, 2]`. The server maps the numbers back to chunk ids. Before any answer text, the client receives a typed `data-sources` stream part with each source's chunk id, document, page, text and stored highlight rects (`shared/types/chat.ts`).
2. **Grounding rules** (`server/rag/prompt.ts`): use only the sources, never outside knowledge; cite every factual sentence; answer partially and say what's missing; for ambiguous questions, answer each reading and name its document. Temperature 0, at most 700 output tokens.
3. **Refusal is a token.** When the sources don't answer, the model replies with exactly `NO_ANSWER`. The UI renders a neutral "Not found in the documents" notice, never an error, plus "possibly related" pages that are explicitly not cited. With no indexed chunks at all, the server refuses without calling the LLM.
4. **Rendering only trusts valid markers.** `splitCitations` turns only in-range numbers into chips. A hallucinated `[9]` stays plain text.
5. **Single-turn retrieval.** `POST /api/chat` takes `{ question, documentId? }`. Each question is grounded only in what was retrieved for it. Conversation-aware query rewriting is Phase 8.

## Rationale

- Models copy short numbers far more reliably than UUIDs, and numbers cost a token or two per citation.
- A fixed refusal token is unambiguous to detect, both in the UI and in the evals. A free-text "I don't know" would need a classifier.
- Sending sources as data, not markdown links, gives the UI everything it needs to verify, preview and (in Phase 5) highlight without parsing model output.

## Baseline (Phase 4, `pnpm eval:answers`, `docs/evals/phase-4-baseline.json`)

Model `google/gemini-3.5-flash-lite`, top-8 hybrid retrieval, 50 golden questions (45 answerable, 5 unanswerable):

| Metric | Value |
|---|---|
| Retrieval recall@5 / @8 / @10, hybrid | 62% / 73% / 78% |
| Retrieval recall@5 / @8 / @10, dense only | 60% / 73% / 76% |
| Retrieval recall@5 / @8 / @10, keyword only | 58% / 69% / 71% |
| Answerable questions answered | 89% (40/45) |
| ≥1 correct citation (cited source contains golden evidence) | 83% of answered, 73% of answerable |
| Citation precision (lower bound: only golden-evidence chunks count) | 60% |
| Answered without any citation | 1 (g-036, correct but uncited) |
| Refusal accuracy on unanswerable | **100% (5/5)** |
| Refusals on answerable questions | 4 because the evidence wasn't retrieved (correct grounded behaviour), 1 with the evidence retrieved (g-032, a flattened table row) |

Manual review of the 8 answers that missed the golden evidence found **no fabrication**:
- g-029 is correct and supported by another passage, which the precision metric doesn't credit.
- The rest are partial answers that say what the sources don't cover. Each traces back to a retrieval miss.

Retrieval is the bottleneck, which is what Phases 6–8 (hybrid tuning, reranking, query rewriting) address.

## Rejected alternatives

- **Chunk UUIDs as markers:** copied unreliably by small models, and expensive in tokens.
- **Structured output (`generateObject` with a claims[] array):** breaks streaming prose, and free-tier models are less reliable with schemas than with inline markers.
- **Score-threshold refusal before the LLM:** RRF scores are rank-based and not calibrated across queries, so a threshold would either refuse answerable questions or let unanswerable ones through. The model judges support; Phase 7's reranker may add a calibrated relevance gate.
- **Multi-turn context in retrieval:** follow-ups like "and the second one?" need query rewriting to retrieve well. Deferred to Phase 8.

## Consequences

- Uncited sentences (g-036) aren't caught at runtime yet. Phase 9's faithfulness and citation checks measure them, and the UI could mark an uncited answer as unverified.
- Tables flattened by extraction (g-032) are hard for the model to read even when retrieved.
- `gemini-2.5-flash-lite`, the plan's fallback, is closed to new API users, so the fallback is `gemini-3.5-flash-lite` (TECH_NOTES §9). The numbers above are for that model. Re-run the eval when a Groq key is configured.

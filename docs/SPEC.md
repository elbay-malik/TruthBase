# TruthBase: Product Spec

- **Status:** Accepted (Phase 0)
- **Date:** 2026-10-16
- Related: [EXECUTION_PLAN.md](./EXECUTION_PLAN.md) · [WIREFRAMES.md](./WIREFRAMES.md) · [golden/](./golden/README.md) · [adr/](./adr/)

## Problem

RAG chatbots say "according to the document…" and leave it to the reader to verify. Checking a claim means opening the PDF, finding the page and scanning for the passage, so most people don't, and hallucinations go unnoticed.

## Product

TruthBase answers questions over a set of PDFs. **Every claim carries an inline citation, and clicking a citation scrolls the PDF to the exact page and highlights the exact supporting passage.** When the documents don't support an answer, TruthBase says so instead of guessing.

It is a portfolio project. It shows senior-level retrieval engineering (hybrid search, reranking, query rewriting) that is **measured** against a golden dataset, not just claimed.

## Users

| User | Need |
|---|---|
| **Demo visitor** (recruiter, hiring manager, engineer) | Try it in under a minute without signing up; see a citation highlight work; find the eval numbers. |
| **Technical reviewer** | Read the README/ADRs, check the evals in CI, and trust that the numbers are real. |
| **Bring-your-own-docs user** (optional, later) | Upload their own PDFs and get the same verifiable answers. |

## Scope

**In scope (core):**

1. A public **demo workspace**, preloaded with the 4 golden PDFs, that needs no login.
2. Ask a question → a streamed answer with inline citation chips `[1]`, each tied to a chunk ID.
3. Citation click → the PDF viewer scrolls to the page and highlights the passage. This works at any zoom level and from the keyboard.
4. Grounded refusal when no retrieved chunk supports an answer.
5. Ingestion: upload → parse with positions → chunk → embed (768-dim) → store.
6. Retrieval: hybrid (dense + full-text, fused with RRF) → LLM rerank → optional multi-query expansion.
7. Evals on the golden set: an offline retrieval gate on every PR, plus a manual and weekly promptfoo LLM eval ([ADR-0008](./adr/0008-evals-and-ci-gate.md)). Tracing with Langfuse.
8. Abuse protection: per-IP rate limits, output-token caps and a clean 429 response.

**Out of scope (decided):**

- **Full multi-tenant auth from day one.** It adds cost and complexity without portfolio payoff. Optional Supabase Auth only gates bring-your-own-docs (Phase 11).
- Non-PDF formats, OCR of scanned PDFs, and editing documents.
- Stretch goals, labeled as such: contextual retrieval, GraphRAG-lite, multi-document compare and an agentic query router.

## Core flows

1. **Ask (demo):** land on the page → pick a document or "all documents" → ask → the answer streams in with citation chips → click a chip → the viewer jumps to the page and highlights the passage.
2. **Verify:** hover a chip to preview the passage text. Use the next/previous controls to move between multiple citations.
3. **Refuse:** ask something the documents don't cover → a "not found in the documents" response with no citations, plus the closest passages shown as "possibly related".
4. **Upload (BYO, later):** drop a PDF → ingestion progress (parse → chunk → embed) → the document becomes selectable.

## Acceptance metrics

All metrics are computed on [`docs/golden/golden.json`](./golden/golden.json) (50 records: 45 answerable, 5 unanswerable). Retrieval metrics are gated on every PR against a committed baseline; answer metrics are gated by a manual and weekly LLM eval on the targets below ([ADR-0008](./adr/0008-evals-and-ci-gate.md), [docs/evals](./evals/README.md)).

| Metric | Definition | Measured from | Provisional target |
|---|---|---|---|
| **Recall@k** (k = 5, 10) | Share of answerable records where the top-k retrieved chunks cover **all** of the record's evidence spans. A chunk covers a span if it is on the same document and page and its text contains the span. | Phase 4 (dense baseline) → 6 → 7 → 8 | Hybrid > dense-only (Phase 6); ≥ 0.85 @10 after rerank |
| **MRR / nDCG@5** | Rank quality of the first and of all evidence-covering chunks | Phase 6 → 7 | Rerank > no-rerank (Phase 7) |
| **Faithfulness** | Share of answer claims that the cited chunks support (LLM-as-judge, spot-checked by hand) | Phase 9 | ≥ 0.90 |
| **Citation precision** | Share of emitted citations whose chunk actually supports the claim it is attached to | Phase 4 → 9 | ≥ 0.90 |
| **Refusal accuracy** | Unanswerable records refused, **and** answerable records not refused | Phase 4 → 9 | 5/5 refused; ≤ 1 false refusal |
| **Highlight accuracy** | For every golden evidence span at zoom 50%, 100% and 200%: overlay on the correct page; start/end edges vs **MuPDF glyph positions** (independent engine) and vs the text layer at item boundaries; vertical **ink coverage** of each line on the rendered canvas. The text layer is *not* ground truth inside items or vertically (ADR-0004) | Phase 3.5 (measured) → 5 → 13 (E2E) | 100% on the right page; edges ≤ 0.05 pt vs MuPDF and ≤ 1 pt on screen; ink coverage ≥ 0.99 at zoom ≥ 100% |

Each Phase 6–8 technique must beat the previous configuration on its target tag slice (`keyword`/`paraphrase` for hybrid, `distractor`/`reverse-lookup` for rerank, `ambiguous` for multi-query) without lowering overall precision.

Non-functional targets: infra ≤ 5 EUR/month, time to first token < 2 s at p50 on the demo, Lighthouse accessibility ≥ 95, and a keyboard-only citation flow.

## ADR backlog

These decisions get recorded as they are made, using the [ADR template](./adr/template.md). Each ADR includes rejected alternatives with reasons.

| ADR | Decision | Phase |
|---|---|---|
| 0001 | Overall stack selection | ✅ Accepted |
| 0002 | Retrieval schema, 768-dim embeddings, RRF in SQL | ✅ Accepted |
| 0003 | **Chunking strategy and sizes**: unit (page-bounded vs cross-page), target tokens, overlap, sentence boundaries | 3 |
| 0004 | **PDF extraction and highlight coordinate model**: unpdf text items → per-line rects, PDF-space storage, text-match fallback | 3 / 3.5 |
| 0005 | **Citation format and grounding/refusal policy**: inline chunk-ID markers, prompt contract, refusal threshold | 4 |
| 0006 | **Why hybrid search**: dense vs full-text vs hybrid, RRF `k` and weights, with measured golden numbers | 6 |
| 0007 | **Reranker choice**: listwise LLM-as-reranker on Groq vs cross-encoders vs hosted rerank APIs | 📝 Proposed (final numbers pending) |
| 0008 | **Eval methodology and CI gate**: metric definitions, judge model, thresholds, tolerance | 📝 Proposed (first full LLM eval pending) |
| 0009 | **Query rewriting**: multi-query vs HyDE, guardrails (entity preservation, rerank after fusion) | 📝 Proposed (final numbers pending) |
| 0010 | **Abuse protection and demo mode**: rate-limit store, caps, BYO-docs gating | ✅ Accepted (BYO docs: Phase 11b) |
| 0011 | **Deployment topology**: Workers Paid vs free Workers + Node ingestion host | 14 |

## Risks

The top five technical risks and their mitigations are in [EXECUTION_PLAN.md § Risk Register](./EXECUTION_PLAN.md). The two that shape the order of work:

1. **Highlight mapping**, the highest risk. Phase 3.5 spikes it on one hard-coded chunk before any retrieval is built. Golden records tagged `table` and `figure-caption` are the hardest fixtures.
2. **Free-tier LLM limits.** Per-IP caps and response caching keep a public demo alive.
3. **Prompt injection through document text** (found in the post-Phase-5 audit). A PDF can carry instructions or persuasive claims that the model repeats with a citation to a different, genuine source. Sources are delimited and declared non-instructional ([ADR-0005](./adr/0005-citations-and-grounding.md) §6), which reduces but doesn't remove the risk. It must be re-assessed before Phase 11 opens uploads, with Phase 9's faithfulness check as the detection.

# TruthBase Roadmap

Phase-by-phase progress against the [execution plan](./docs/EXECUTION_PLAN.md). Each phase lists its acceptance criterion; check it off only when the criterion is met.

## Phases

- [x] **Phase 0 — Scoping, golden dataset, mockups** *(~1 wk)*
  Spec, golden Q&A set (30–50 pairs, see [docs/golden/](./docs/golden/README.md)), and wireframes committed.
  <br>Done: [SPEC.md](./docs/SPEC.md) (scope, acceptance metrics, ADR backlog), [WIREFRAMES.md](./docs/WIREFRAMES.md), 4 demo PDFs + 50-record [golden.json](./docs/golden/golden.json), with every quote verified against `unpdf` page text in CI.
- [x] **Phase 1 — Repo and Nuxt 4 setup** *(~0.5 wk)*
  App builds, placeholder page deploys, TypeScript strict passes, secrets load from env. *(This bootstrap.)*
- [x] **Phase 2 — Database schema + pgvector** *(hosted project `ezgfuoaukozwylgkdtft`)*
  RRF hybrid-search RPC returns sensibly fused results for a seeded row set. Keep-alive ping running.
  <br>Done: migrations (schema + GIN/HNSW indexes + RLS + `hybrid_search` RRF RPC + keep-alive table) applied to the hosted project; the [acceptance check](./supabase/tests/hybrid_search.sql) (fused order, exact RRF scores, weights, filter, stemming, access control) passes there and in the CI `db` job; server-only Supabase client + typed `hybridSearch()`; keep-alive secrets set and first ping green.
- [x] **Phase 3 — Ingestion pipeline** *(~2 wk)*
  Upload → parse-with-positions → chunk → embed (768-dim, L2-normalized) → store; spot-checked rects match source passages.
  <br>Done: extraction with char→item map ([ADR-0004](./docs/adr/0004-extraction-and-highlights.md)), page-bounded 800-char sentence chunking measured on the golden set ([ADR-0003](./docs/adr/0003-chunking.md)), per-line PDF-space rects (visually verified via `pnpm render:highlights`), Gemini embedder, compensating-rollback store + private `documents` bucket, token-gated `POST /api/ingest` with SSE progress, `pnpm ingest:golden`. Demo corpus ingested: 4 PDFs, 133 pages, 566 chunks (all 768-dim, unit norm, rects on the right page; 60/60 golden spans inside a stored chunk). Untuned smoke baseline on the hosted DB: recall@10 hybrid 0.78 / dense 0.76 / keyword 0.71 — formal numbers come in Phases 4 and 6.
- [x] **Phase 3.5 — Highlight spike (risk front-load)**
  Throwaway overlay of one hard-coded chunk's rects in PDF.js — validate the rect math before building retrieval.
  <br>Done, and broader than planned: all 60 golden spans × zoom 0.5/1/2 in headless Chromium (`/spike/highlight`, `pnpm spike:highlight`). The PDF→screen conversion is exact (item-boundary edges: median 0.00 pt, max 0.6 pt, zoom-invariant), and vertical ink coverage is ≥ 0.996 at zoom ≥ 1 with 0/117 lines missing their ink. The spike found the proportional partial-item cut off by up to 15.6 pt, so ingestion now replays PDF.js glyph advances: edges exact to 0.001 pt against MuPDF, an independent engine (`test/unit/ingest-glyphs.test.ts`). It also rejected the planned text-layer refinement, because the text layer uses a substitute font. Stored highlights refreshed in place (`pnpm ingest:golden --highlights-only`). Reviewed by a 41-agent adversarial pass; all 10 confirmed findings and 2 split ones fixed. See [ADR-0004](./docs/adr/0004-extraction-and-highlights.md) and TECH_NOTES §8.
- [x] **Phase 4 — Basic retrieval + grounded generation with citations** *(~1.5 wk)*
  Golden-set question → grounded answer with ≥1 correct inline citation; clean refusal when unsupported.
  <br>Done: `POST /api/chat` (Gemini query embedding → hybrid RRF top-8 → grounded `streamText`, typed `data-sources` part with chunk/page/highlight), numbered-citation + `NO_ANSWER` contract ([ADR-0005](./docs/adr/0005-citations-and-grounding.md)), chat UI with citation chips, source cards and a neutral refusal state, `pnpm eval:answers`. Baseline ([docs/evals/phase-4-baseline.json](./docs/evals/phase-4-baseline.json), gemini-3.5-flash-lite): retrieval recall@8 hybrid 73% / dense 73% / keyword 69%; 89% of answerable questions answered, 83% of those with ≥1 correct citation; refusal accuracy 5/5; manual review found no fabrication, and all misses trace to retrieval.
- [ ] **Phase 5 — PDF.js viewer + citation-click-to-highlight** *(~2.5–3 wk, riskiest)*
  Every golden citation highlights the correct passage at multiple zoom levels.
- [ ] **Phase 6 — Hybrid search + RRF hardening** *(~1 wk)*
  Hybrid beats dense-only on golden recall@k (numbers recorded).
- [ ] **Phase 7 — Reranking** *(~1 wk)*
  LLM reranker improves nDCG@5 / citation precision (numbers recorded).
- [ ] **Phase 8 — Query rewriting / advanced retrieval** *(~1 wk)*
  Multi-query improves recall on ambiguous questions without precision collapse.
- [ ] **Phase 9 — Evals harness** *(~1.5 wk)*
  promptfoo produces recall@k, MRR/nDCG, faithfulness, citation precision on the golden set; gates CI.
- [ ] **Phase 10 — Tracing / observability** *(~0.5 wk)*
  Every chat request produces a Langfuse trace with chunk + token metadata.
- [ ] **Phase 11 — Rate limiting, demo mode, anti-abuse** *(~1 wk)*
  Exceeding caps returns clean 429; demo workspace works without login.
- [ ] **Phase 12 — UI polish + accessibility** *(~1.5 wk)*
  Lighthouse a11y/perf captured; keyboard-only citation flow works.
- [ ] **Phase 13 — Testing (Vitest + Playwright)** *(~1.5 wk)*
  CI green incl. the E2E citation-to-highlight assertion.
- [ ] **Phase 14 — Deployment** *(~1 wk)*
  Public URL, upload→ask→highlight works in prod, ≤ 5 EUR/month.
- [ ] **Phase 15 — README whitepaper, ADRs, demo video** *(~1 wk)*
  README with eval numbers, ADRs, metrics, video published.

## Definition of Done

- [ ] Upload → parse-with-positions → chunk → embed (768-dim) → store works for all demo PDFs.
- [ ] Hybrid RRF search beats dense-only on golden recall@k (numbers recorded).
- [ ] LLM reranker improves nDCG@5 / citation precision (numbers recorded).
- [ ] Multi-query expansion improves recall on ambiguous questions without precision collapse.
- [ ] Answers are grounded, cite chunk IDs inline, and refuse when unsupported.
- [ ] Clicking any golden citation scrolls to the right page and highlights the correct passage at multiple zoom levels.
- [ ] promptfoo eval suite runs in CI as a PR gate.
- [ ] Langfuse traces every chat request with chunk + token metadata.
- [ ] Per-IP rate limiting + output caps enforced; public demo works without login.
- [ ] Playwright E2E covers the citation-to-highlight flow; Vitest covers chunking/rects/RRF.
- [ ] TypeScript strict passes everywhere; accessibility pass done; Lighthouse/CWV captured.
- [ ] Live demo deployed under 5 EUR/month with keep-alive; README whitepaper + ADRs + demo video published.

## Stretch goals (deliberately out of core scope)

Contextual retrieval · GraphRAG-lite · Multi-document compare · Agentic query router

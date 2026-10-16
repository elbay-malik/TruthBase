# TruthBase Roadmap

Phase-by-phase progress against the [execution plan](./docs/EXECUTION_PLAN.md). Each phase lists its acceptance criterion; check it off only when the criterion is met.

## Phases

- [x] **Phase 0 — Scoping, golden dataset, mockups** *(~1 wk)*
  Spec, golden Q&A set (30–50 pairs, see [docs/golden/](./docs/golden/README.md)), and wireframes committed.
  <br>Done: [SPEC.md](./docs/SPEC.md) (scope, acceptance metrics, ADR backlog), [WIREFRAMES.md](./docs/WIREFRAMES.md), 4 demo PDFs + 50-record [golden.json](./docs/golden/golden.json), with every quote verified against `unpdf` page text in CI.
- [x] **Phase 1 — Repo and Nuxt 4 setup** *(~0.5 wk)*
  App builds, placeholder page deploys, TypeScript strict passes, secrets load from env. *(This bootstrap.)*
- [ ] **Phase 2 — Database schema + pgvector** — *code authored ([supabase/](./supabase/)), pending a Supabase project*
  RRF hybrid-search RPC returns sensibly fused results for a seeded row set. Keep-alive ping running.
  <br>Done: migrations (schema + GIN/HNSW indexes + `hybrid_search` RRF RPC + keep-alive table), server-only Supabase client + typed `hybridSearch()` helper, `l2Normalize()`, keep-alive workflow. Remaining: create the project, run the migrations, seed rows, verify fused output, wire the two GitHub secrets.
- [ ] **Phase 3 — Ingestion pipeline** *(~2 wk)*
  Upload → parse-with-positions → chunk → embed (768-dim, L2-normalized) → store; spot-checked rects match source passages.
- [ ] **Phase 3.5 — Highlight spike (risk front-load)**
  Throwaway overlay of one hard-coded chunk's rects in PDF.js — validate the rect math before building retrieval.
- [ ] **Phase 4 — Basic retrieval + grounded generation with citations** *(~1.5 wk)*
  Golden-set question → grounded answer with ≥1 correct inline citation; clean refusal when unsupported.
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

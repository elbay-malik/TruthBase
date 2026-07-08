# TruthBase: Zero-to-Deployed Execution Pathway for a Verifiable Advanced RAG Knowledge Base on Nuxt 4

> **Note:** This is the original research brief (mid-2026) that drives this repository. Version numbers and free-tier limits drift; see [TECH_NOTES.md](./TECH_NOTES.md) for verified corrections discovered during implementation (notably: AI SDK is now **v7**, not v6).

## TL;DR
- **Recommended stack:** Nuxt 4 (4.4.x, current supported release 4.4.8) with Nitro server routes for all secret-bearing work; Supabase Postgres free tier with pgvector + native `tsvector` full-text fused by Reciprocal Rank Fusion (RRF) in an SQL RPC; Google `gemini-embedding-001` at 768 dimensions (Matryoshka-truncated) as primary embeddings with Jina as fallback; Groq (`llama-3.3-70b-versatile`) as primary generation model with Gemini 2.5 Flash-Lite as fallback; LLM-as-reranker on Groq as the defensible free reranking approach; `unpdf`/`pdfjs-serverless` for text extraction WITH position metadata; PDF.js text layer + absolutely-positioned overlay divs for citation highlighting; promptfoo for offline evals plus Langfuse Hobby for tracing. Deploy the static frontend + light Nitro routes on Cloudflare Workers, but run the heavy PDF-parse/embed ingestion on a Node-capable free host (or a Vercel Hobby function) because Cloudflare's free-tier 10ms CPU limit cannot parse PDFs.
- **The hard part is the citation-to-highlight mapping**, not the API wiring. Budget the most time for storing per-chunk `{pageNumber, boundingRect, rects[], pageWidth/Height, char offsets, text}` at ingestion and reconstructing overlays with `viewport.convertToViewportRectangle` at view time. This is the single feature that makes the project a senior-level signal.
- **Realistic timeline: about 14-18 weeks part-time (8-10 h/week)** across 16 phases, with hybrid search, reranking, evals, and the highlight flow being the differentiators. Total infra cost stays under 5 EUR/month if you respect free-tier limits and add keep-alive pings.

## Key Findings
- **Nuxt 4 is stable and mature in mid-2026.** Nuxt 4.0 was released 15 July 2025; by mid-2026 it is on the 4.4.x line, and endoflife.date confirms 4.4.8 is the current supported release. It ships the `app/` directory, improved data fetching (shared `useFetch`/`useAsyncData` refs), and per-context TypeScript projects (app/server/shared) with a single root `tsconfig.json`. Per the official Nuxt roadmap and Daniel Roe's v4.3.0 announcement, Nuxt 3 end-of-life was extended from the originally announced 31 January 2026 to **31 July 2026** ("we will continue to provide security updates and critical bug fix releases beyond the previously announced end-of-life date of January 31, 2026, meaning Nuxt v3 will meet its end-of-life on July 31, 2026"). Nuxt 4 is the correct target; Nuxt UI v4 is current.
- **Vercel AI SDK v6 has first-class Vue support.** The `@ai-sdk/vue` package exposes a `Chat` class (v6 moved from a `useChat` composable to a `Chat` class; you can wrap it in your own `useChat`). Core provides `streamText`, `generateObject`, `streamObject`, and tool calling; provider packages `@ai-sdk/groq` and `@ai-sdk/google` exist. Sources/citations for RAG are handled via `source` stream parts (`sourceType: 'url'` or `source-document`) and `sendSources: true` on `toUIMessageStreamResponse`, or via custom `data-*` parts written with `createUIMessageStream`. SSE is the standard streaming transport since v5. *(Superseded — see TECH_NOTES.md: v7 restored `useChat` and changed the server helper pattern.)*
- **Hybrid search on Supabase is officially documented.** Supabase's own guide implements pgvector (dense) + `tsvector`/`websearch_to_tsquery` (keyword) fused by RRF in a Postgres function. `pg_search`/BM25 (ParadeDB) is still NOT available on hosted Supabase in 2026, so native `tsvector` + RRF is the correct free approach; community guidance sets RRF `k` at 50-60 and recommends over-fetching ~20-30 candidates per arm before fusing. pgvector 0.7+ supports HNSW (the 2026 default, no training step) and up to 16,000 dimensions.
- **Free embedding budget favors Gemini.** Per Google's GA announcement, `gemini-embedding-001` "supports over 100 languages and has a 2048 maximum input token length" and "utilizes the Matryoshka Representation Learning (MRL) technique, which allows developers to scale the output dimensions down from the default 3072" (recommended tiers 3072/1536/768); paid price is $0.15 per 1M input tokens, and it is available free in AI Studio with generous embedding throughput. Store at 768 dims to conserve the 500MB Supabase budget. Flag the privacy tradeoff: Gemini free-tier prompts may be used to improve Google's products.
- **PDF extraction with positions works serverlessly via `unpdf`/`pdfjs-serverless`.** `unpdf` (UnJS) ships a serverless PDF.js build tested against Cloudflare Workers and Vercel Edge; both expose the raw `getTextContent()` items with `str`, `transform` (position), `width`, `height`. This is enough to build chunk-to-highlight mappings. (Note: for heavy parsing the CPU limit, not the library, is the constraint — see deployment.)
- **The proven highlight data model** (from `agentcooper/react-pdf-highlighter` and `@react-pdf-viewer/highlight`) is a scale-independent `{ pageNumber, boundingRect, rects[] (one per line), pageWidth/Height, usePdfCoordinates flag, char offsets, text }`, reconstructed at view time with `viewport.convertToViewportRectangle` and drawn as absolutely-positioned overlay divs anchored to the page element (recomputed on zoom/rotation).
- **Deployment split is likely required.** Per Cloudflare Workers official limits docs, the free tier is "100,000 requests/day, 10ms CPU time per invocation" with 128MB per isolate on both plans; "on the Workers Paid plan, you can increase the maximum CPU time from the default 30 seconds to 5 minutes (300,000 ms)." The 10ms free ceiling cannot parse a PDF or run heavy fusion. Vercel Hobby offers a Node runtime but is explicitly non-commercial. Neon's free tier (per neon.com/docs) includes "100 CU-hours of compute per project per month" and "0.5 GB of storage per project," where "Scale to zero is always enabled (computes suspend after 5 minutes of inactivity) and can't be disabled" (resume latency typically a few hundred ms, p99 ~500ms) — a strong DB alternative if Supabase's 7-day pause is the bigger concern.

## Details

### Verdict on the end-to-end stack (opinion, grounded in the findings)
Build the whole app as one Nuxt 4 project. Do all secret-bearing and compute-heavy work (embedding calls, LLM calls, PDF parsing, DB queries) in Nitro server routes, never client-side. Use Supabase Postgres for both vectors (pgvector/HNSW) and keyword search (tsvector), fused with an RRF SQL function. Embed with Gemini at 768 dims (fallback Jina). Generate with Groq `llama-3.3-70b-versatile` (fallback Gemini 2.5 Flash-Lite). Rerank with a listwise LLM-as-reranker call on Groq. Extract PDF text with `unpdf`. Render and highlight with PDF.js via a client-only Vue component. Evaluate offline with promptfoo and trace at runtime with Langfuse Hobby. For hosting, put the app on Cloudflare Workers ($5/mo paid plan to clear the CPU limit, still under 5 EUR) OR keep the free tier and offload only the ingestion route to a Node host. This is the most defensible free/near-free architecture that still demonstrates senior-level retrieval engineering.

---

### Phase 0 — Scoping, golden dataset, mockups
**Goal:** Lock scope, design the golden Q&A set, and wireframe the citation-highlight UX before writing code.
**Steps:**
1. Write a one-page product spec and the list of Architecture Decision Records (ADRs) you will fill in (why hybrid search, why this reranker, why these chunk sizes, rejected alternatives).
2. Pick 3-5 demo PDFs (public, redistributable) and hand-author a golden set of ~30-50 Q&A pairs with known supporting passages (page + text) — this is both your eval ground truth and your highlight test fixtures.
3. Wireframe the split-pane UI: chat/answer on one side, PDF viewer on the other, with citation chips that scroll-and-highlight.
4. Define acceptance metrics up front: retrieval recall@k, MRR/nDCG, answer faithfulness, citation precision.
**Packages/tools:** none (Figma/pen-and-paper).
**Key decision:** Scope to "public demo workspace + optional bring-your-own-docs" rather than full multi-tenant auth. Rejected: full auth from day one (adds cost/complexity without portfolio payoff).
**Acceptance:** Spec, golden set CSV/JSON, and wireframes committed to the repo.
**Estimate:** 1 week.

### Phase 1 — Repo and Nuxt 4 setup
**Goal:** A clean, TypeScript-strict Nuxt 4 skeleton with the right module baseline.
**Steps:**
1. Scaffold a Nuxt 4 app; adopt the `app/` directory structure and a single root `tsconfig.json` (Nuxt 4 creates separate TS projects for app/server/shared automatically).
2. Enable TypeScript strict mode everywhere.
3. Install the UI/utility baseline: Nuxt UI v4 (components), `@vueuse/nuxt` (composables), and a security module for headers/rate-limit helpers.
4. Set up `runtimeConfig` for all secrets (Groq, Gemini, Supabase service key) so they are server-only; never expose them via `public`.
5. Organize `server/` (Nitro) routes into `api/ingest`, `api/chat`, `api/search`, and shared `server/utils`.
**Packages/tools:** `nuxt` (framework), `@nuxt/ui` (UI components), `@vueuse/nuxt` (composition utilities), `nuxt-security` (headers/rate limiting), `zod` (schema validation for structured outputs and request bodies).
**Key decision:** Use Tailwind via Nuxt UI v4 (which bundles Tailwind v4) rather than adding `@nuxtjs/tailwindcss` separately. Rejected: standalone Tailwind module (redundant with Nuxt UI v4). Nuxt layers are NOT needed for a single-app portfolio project; skip them.
**Acceptance:** App builds, deploys a placeholder page, TypeScript strict passes, secrets load from env.
**Estimate:** 0.5 week.

### Phase 2 — Database schema + pgvector
**Goal:** A Postgres schema that supports both dense and keyword search plus highlight metadata.
**Steps:**
1. Create a Supabase project; enable the `vector` extension.
2. Design tables: `documents` (id, filename, storage path, page count), and `chunks` (id, document_id, page_number, content, `fts tsvector generated`, `embedding vector(768)`, and a JSON `highlight` column holding `boundingRect`, `rects[]`, `pageWidth/Height`, char offsets).
3. Add a GIN index on `fts` and an HNSW index on `embedding` (cosine).
4. Write the RRF hybrid-search Postgres function (RPC): two CTEs (full-text via `websearch_to_tsquery`, semantic via `<=>`/`<#>`), each `row_number()`-ranked, fused by `1/(k+rank)` with tunable weights.
5. Add the keep-alive ping now (scheduled GitHub Action or cron) to defeat the 7-day pause.
**Packages/tools:** `@supabase/supabase-js` (DB client, server-side only), pgvector (extension), Supabase SQL editor/migrations.
**Key decision:** Store embeddings at 768 dims to fit the 500MB free budget; use HNSW not IVFFlat (no training step, 2026 default). RRF `k=50-60`. Rejected: `pg_search`/BM25 (unavailable on Supabase free tier in 2026); native `tsvector` is the pragmatic choice.
**Acceptance:** The RPC returns sensibly fused results for a seeded row set.
**Estimate:** 1 week.

### Phase 3 — Ingestion pipeline (upload, parse-with-positions, chunk, embed, store)
**Goal:** Turn an uploaded PDF into stored, embedded, highlight-mapped chunks.
**Steps:**
1. Build a Nitro upload route using multipart form parsing; enforce a size cap. For large files, prefer a signed direct-to-storage upload URL, then process by reference.
2. Extract text server-side with `unpdf`, iterating pages and calling `getTextContent()` to capture each item's `str`, `transform` (x = `transform[4]`, y = `transform[5]`, PDF bottom-left origin), `width`, `height`.
3. Chunk with a recursive character/token splitter targeting ~512 tokens with modest overlap; keep per-chunk text-item index ranges (`startItemIndex`/`endItemIndex`) and character offsets (`startOffset`/`endOffset`) so you can rebuild rects.
4. For each chunk, compute `pageNumber`, a `boundingRect`, and per-line `rects[]` (in normalized or PDF-space coordinates, flagged via `usePdfCoordinates`), plus `pageWidth/Height` from `page.getViewport({scale:1})`.
5. Batch-embed chunk text with `gemini-embedding-001` at 768 dims (respect the 2,048-token input cap; chunks are well under this).
6. Insert chunks with content, embedding, `fts`, and the highlight JSON.
7. Stream ingestion progress to the client via SSE (or `data-*` parts) so the UI shows parse/embed/store stages.
**Packages/tools:** `unpdf` (serverless PDF text+position extraction), a text splitter (LangChain.js splitters or a hand-rolled recursive splitter — hand-rolled keeps deps light in Nitro), `@ai-sdk/google` (embeddings via AI SDK), `zod` (validate the chunk records).
**Key decisions:** Recursive 512-token chunking with small overlap is the 2026 default (best accuracy/effort per multiple 2026 benchmarks placing recursive 512-token splitting at the top). Rejected for v1: semantic chunking (~14x slower), late chunking, and contextual retrieval (an LLM call per chunk — too expensive on free tier); list these as ADR "rejected alternatives" and add contextual retrieval as a stretch goal. Extraction is server-side (not client) so ingestion is reproducible and testable.
**Acceptance:** Uploading a demo PDF yields correctly paginated, embedded chunks; a spot-checked chunk's stored rects visually match the source passage.
**Estimate:** 2 weeks (parsing + position math is fiddly).

### Phase 4 — Basic retrieval + grounded generation with citations
**Goal:** Ask a question, retrieve chunks, get a grounded answer with inline citation markers.
**Steps:**
1. Build the chat Nitro route: embed the query, call the hybrid RRF RPC, take top-k.
2. Construct a strict grounding prompt: answer only from provided chunks, cite chunk IDs inline, refuse if unsupported.
3. Stream the answer with `streamText` and attach retrieved chunks as `source`/`data-*` parts so the client can render citation chips.
4. Wire the Vue chat UI using the `@ai-sdk/vue` `Chat` class; render `message.parts` including source parts. *(v7: `useChat` composable — see TECH_NOTES.md.)*
**Packages/tools:** `ai` (core: `streamText`), `@ai-sdk/vue` (`Chat` class → `useChat` in v7), `@ai-sdk/groq` (generation), `zod` (structured citation payloads if using `generateObject`).
**Key decision:** Groq `llama-3.3-70b-versatile` primary. Per Groq's official rate-limits documentation (as tracked June 2026), it "is listed at 30 RPM, 1K RPD, 12K TPM, and 100K TPD on the Free Plan" — the RPD/TPD are the binding constraints, so design around them. Gemini 2.5 Flash-Lite is the fallback (15 RPM / 1,000 RPD free). Rejected: OpenAI/Anthropic (not free).
**Acceptance:** A golden-set question returns a grounded answer with at least one correct inline citation; refuses cleanly when no chunk supports the answer.
**Estimate:** 1.5 weeks.

### Phase 5 — PDF.js viewer + citation-click-to-highlight (the differentiator)
**Goal:** Clicking a citation scrolls the PDF to the page and highlights the exact passage.
**Steps:**
1. Add a client-only PDF viewer component (wrap so it never runs during SSR — PDF.js needs `window`/`canvas`). Configure the PDF.js worker (`GlobalWorkerOptions.workerSrc`) and match the worker version exactly to `pdfjs-dist`.
2. Render pages with the text layer enabled.
3. On citation click, read the chunk's stored `{pageNumber, rects[]}`, scroll to the page, convert each stored rect with `viewport.convertToViewportRectangle`, and draw absolutely-positioned overlay divs anchored to the page element (recompute on `scalechanging`/`rotationchanging`).
4. Handle the PDF bottom-left vs browser top-left origin flip (`y_screen = viewport.height - transform[5]`); render multi-line highlights as stacked per-line rects; re-verify by text match as a fallback when stored rects drift.
**Packages/tools:** `pdfjs-dist` (rendering + text layer) or a Vue wrapper (`@tato30/vue-pdf` or `vue-pdf-embed` — both need client-only wrapping in Nuxt), the viewer's `viewport.convertToViewportRectangle` API.
**Key decision:** Use a thin Vue wrapper around `pdfjs-dist` for control over the overlay layer rather than a heavyweight all-in-one viewer; the overlay-div approach (anchored to the page, following the `react-pdf-highlighter` `{boundingRect, rects[]}` model) is more robust than mutating text-layer spans. Rejected: server-side rendering of the viewer (impossible; client-only). Store scale-independent coords, never fixed pixels.
**Acceptance:** For every golden citation, clicking it highlights the correct passage within tolerance at multiple zoom levels.
**Estimate:** 2.5-3 weeks (honestly the riskiest phase; the origin flip, wrapped-line rects, unreliable `item.height`, and re-render recomputation each take real time).

### Phase 6 — Hybrid search + RRF hardening
**Goal:** Move from dense-only to tuned hybrid retrieval.
**Steps:**
1. Switch the chat route to the RRF RPC; over-fetch ~20-30 per arm, fuse to top-10.
2. Tune weights and `k` against the golden set; record before/after recall.
3. Add metadata filtering (by document) in the SQL.
**Packages/tools:** the Phase 2 RPC, `@supabase/supabase-js`.
**Key decision:** Weight full-text and semantic arms explicitly; document the tuning in an ADR. Rejected: external vector DB (Pinecone/Weaviate) — unnecessary at this scale and not free.
**Acceptance:** Hybrid beats dense-only on golden recall@k, measured and logged.
**Estimate:** 1 week.

### Phase 7 — Reranking
**Goal:** Add a precision-boosting rerank step over fused candidates.
**Steps:**
1. Take the top ~20 fused candidates and rerank with a listwise LLM-as-reranker prompt on Groq (ask the model to order candidate IDs by relevance to the query).
2. Feed the reranked top ~5 to the generator.
3. Measure nDCG@5 uplift on the golden set.
**Packages/tools:** `@ai-sdk/groq` (reranking call), `zod` (validate the returned ordering).
**Key decision:** LLM-as-reranker on Groq is the most defensible free approach (no separate paid rerank API, no server-side cross-encoder that would break on edge runtimes). Fallback/alternative documented in ADR: Jina Reranker free tier (onboarding includes 1,000,000 free tokens, non-commercial; Free tier ~100 RPM / 2 concurrent) or Cohere Rerank trial (1,000 calls/month at 5-20 calls/min). Rejected for primary: self-hosted cross-encoder (needs Node runtime + memory beyond free edge limits); Cohere/Voyage/Jina as primary (trial caps too tight for a public demo).
**Acceptance:** Reranking improves nDCG@5/citation precision on the golden set; latency stays acceptable.
**Estimate:** 1 week.

### Phase 8 — Query rewriting / advanced retrieval
**Goal:** Add one or two high-signal query-transformation patterns.
**Steps:**
1. Implement multi-query expansion: an LLM rewrites the user query into 2-3 diverse formulations; retrieve for each; fuse with RRF.
2. Optionally add HyDE for underspecified queries (generate a hypothetical answer, embed it, retrieve).
**Packages/tools:** `@ai-sdk/groq` (rewriting), the existing RRF fusion.
**Key decision:** Multi-query expansion gives the best senior-signal-to-effort ratio and composes naturally with RRF. HyDE remains in use in 2026 and is a good documented option for long/narrative docs but can mislead in compliance-heavy contexts (add it as a secondary, documented pattern). GraphRAG is overkill for this project — verdict: reject for the core build, mention as a stretch "GraphRAG-lite" idea only. Self-query/metadata filtering is a light add.
**Acceptance:** Multi-query improves recall on ambiguous golden questions without collapsing precision (guardrails: entity preservation + rerank).
**Estimate:** 1 week.

### Phase 9 — Evals harness
**Goal:** Demonstrate senior-level quality measurement, not just API wiring.
**Steps:**
1. Encode the golden set in promptfoo; evaluate retrieval (recall@k, MRR/nDCG) and generation (faithfulness/groundedness via LLM-as-judge, answer relevance, citation precision — does the cited chunk actually support the claim).
2. Run evals in CI as a PR gate; store before/after diffs.
3. Use a cheap judge model (Groq/Gemini free) to keep judge cost near zero.
**Packages/tools:** `promptfoo` (config-driven, MIT, local/CI; note it is now part of OpenAI but remains MIT-licensed and model-agnostic), Vitest for custom metric scripts if needed.
**Key decision:** promptfoo for offline evals (Node-native, YAML config, CI-friendly, with a documented RAG-evaluation guide covering retrieval + generation separately). Rejected: Ragas (Python — wrong ecosystem for a TS-only project); Braintrust as primary (SaaS, not needed at this scale). Evalite is an option but promptfoo is more mature.
**Acceptance:** `promptfoo eval` produces the four metric families on the golden set and gates the pipeline.
**Estimate:** 1.5 weeks.

### Phase 10 — Tracing / observability
**Goal:** Runtime visibility into retrieval, rerank, and generation.
**Steps:**
1. Instrument the chat/ingest routes to send traces (query, retrieved chunk IDs, rerank order, tokens, latency) to Langfuse.
2. Add dashboards for cost/latency and a way to sample production traces back into the golden set.
**Packages/tools:** Langfuse SDK (OpenTelemetry-based), Langfuse Hobby cloud tier.
**Key decision:** Langfuse Hobby for runtime tracing. Per Langfuse's official pricing pages, the Hobby plan is "completely free and does not require a credit card," providing "50,000 units per month, 30-day data retention, support for 2 users" as a hard cap with no overage billing; it is framework-agnostic and integrates with the AI SDK. Rejected: LangSmith (smaller 5,000-trace free tier, LangChain-centric); self-hosted Langfuse (requires ClickHouse/Postgres/Redis — too much ops for a portfolio demo).
**Acceptance:** Every chat request produces a trace with retrieved-chunk and token metadata.
**Estimate:** 0.5 week.

### Phase 11 — Rate limiting, demo mode, anti-abuse
**Goal:** Protect the free LLM endpoints on a public demo.
**Steps:**
1. Add IP-based rate limiting in Nitro middleware (or via the security module / Cloudflare rules).
2. Cap max output tokens and add a per-IP daily request cap; short-circuit before calling the LLM.
3. Ship a public "demo workspace" with preloaded documents; gate "bring your own documents" behind optional Supabase Auth.
**Packages/tools:** `nuxt-security` (rate limit + headers), Supabase Auth (optional BYO-docs mode), Nitro middleware.
**Key decision:** No mandatory auth for the demo; public read-only workspace + rate limits is the minimal defensible pattern. This directly mitigates Groq's 1,000 RPD free cap being exhausted by a demo going viral.
**Acceptance:** Exceeding the cap returns a clean 429; demo workspace works without login.
**Estimate:** 1 week.

### Phase 12 — UI polish + accessibility
**Goal:** A portfolio-grade, accessible interface.
**Steps:**
1. Polish the split-pane chat/viewer, loading/streaming states, empty/error states, and citation chip interactions.
2. Run an accessibility pass (keyboard nav, focus management on citation jump, ARIA on the viewer controls, color contrast).
3. Capture Lighthouse/Core Web Vitals numbers.
**Packages/tools:** Nuxt UI v4, `@vueuse/nuxt`, Lighthouse.
**Key decision:** Prioritize keyboard access to the citation-highlight flow (it is the showcase feature).
**Acceptance:** Lighthouse accessibility and performance scores captured for the README; keyboard-only citation flow works.
**Estimate:** 1.5 weeks.

### Phase 13 — Testing (Vitest + Playwright)
**Goal:** Automated coverage of the pipeline and the citation flow.
**Steps:**
1. Unit-test chunking, rect computation, and RRF fusion with Vitest.
2. E2E-test the critical path with Playwright: upload → ask → click citation → assert the correct highlight overlay renders on the correct page.
**Packages/tools:** `vitest` (unit), `@playwright/test` (E2E), Nuxt test utils.
**Key decision:** The Playwright test of the citation-to-highlight flow is the highest-value test — it guards the differentiator.
**Acceptance:** CI runs unit + E2E green, including the highlight assertion.
**Estimate:** 1.5 weeks.

### Phase 14 — Deployment
**Goal:** Live demo under 5 EUR/month.
**Steps:**
1. Choose the deployment topology (see decision).
2. Configure the Nitro preset, environment secrets, and confirm the Supabase keep-alive ping is running.
3. Preload demo documents; verify the full pipeline in production.
**Packages/tools:** Cloudflare Workers (Nitro cloudflare preset) or Vercel Hobby; GitHub Actions (keep-alive).
**Key decision (deployment verdict):** The heavy ingestion route (PDF parse + embed) cannot run within Cloudflare's free 10ms CPU limit. Two viable topologies: (A) **Cloudflare Workers Paid ($5/mo, up to 5-min CPU) hosting the whole app** — simplest, still within budget, unlimited bandwidth; or (B) **Cloudflare Workers free for the frontend + light routes, with ingestion offloaded to a Node-capable free host** (or a Vercel Hobby function, noting its non-commercial terms). Recommended: (A) for simplicity if 5 EUR is acceptable, otherwise (B). Neon (0.5GB free, 100 CU-hours/month, no 7-day pause but mandatory scale-to-zero with ~500ms p99 cold starts) is the DB fallback if Supabase pausing is unacceptable.
**Acceptance:** Public URL serves the demo; upload→ask→highlight works end-to-end in prod; monthly cost ≤ 5 EUR.
**Estimate:** 1 week.

### Phase 15 — README whitepaper, ADRs, demo video
**Goal:** Package it as a senior/tech-lead portfolio artifact.
**Steps:**
1. Write the README as a technical whitepaper: architecture diagram, data flow, the ADRs (hybrid search, reranker choice, chunk params, rejected alternatives), and the eval results (recall@k, MRR/nDCG, faithfulness, citation precision) with numbers.
2. Add Lighthouse/CWV numbers and the accessibility summary.
3. Record a short demo video showing the citation-click-to-highlight flow.
**Packages/tools:** none.
**Key decision:** Lead the README with the eval numbers and the highlight differentiator; recruiters skim.
**Acceptance:** README, ADRs, metrics, and video published; repo links to the live demo.
**Estimate:** 1 week.

---

## Recommendations
1. **Build in the order above but front-load the two risk spikes early:** after Phase 3, do a throwaway spike of the Phase 5 highlight overlay on one hard-coded chunk before building the full retrieval stack. If the rect math is going to hurt, you want to know in week 4, not week 10.
2. **Respect the free-tier binding constraints from day one:** Groq's `llama-3.3-70b-versatile` at 1,000 RPD / 100K TPD, Supabase's 7-day pause + 500MB, Gemini embedding's 2,048-token input cap. Add the keep-alive ping in Phase 2, not Phase 14.
3. **Keep embeddings at 768 dimensions** to protect the 500MB budget; document the Matryoshka tradeoff in an ADR. Re-embedding later is cheap enough to defer.
4. **Ship the deployment decision as a budget threshold:** if you will pay 5 EUR, use Cloudflare Workers Paid and host everything together. If you must be truly free, split ingestion onto a Node host and keep the edge frontend free. Switch to Neon if Supabase pausing bites during interviews.
5. **Make the evals and ADRs loud.** For a Senior/Tech-Lead target, the retrieval metrics table and the "rejected alternatives" reasoning are worth more than another feature. Add contextual retrieval, GraphRAG-lite, multi-doc compare, and an agentic query router only as clearly-labeled stretch goals.

**Benchmarks that would change the plan:** if hybrid+rerank does not beat dense-only on your golden set, revisit chunking (try structure-aware/Markdown splitting) before adding more retrieval tricks; if live-demo rate limits are hit repeatedly, add response caching and a stricter per-IP daily cap or move generation to Gemini 2.5 Flash-Lite.

## Risk Register (top 5 technical risks + mitigations)
1. **Highlight mapping complexity (highest risk).** PDF bottom-left vs browser top-left origin, unreliable `item.height`, fragmented/out-of-order text items, and wrapped multi-line rects all threaten accuracy. *Mitigation:* store per-line `rects[]` + char offsets + chunk text; reconstruct with `viewport.convertToViewportRectangle`; add a text-match verification fallback; spike it in week 4.
2. **Free-tier LLM rate limits during demos.** Groq free plan is 30 RPM / 1,000 RPD / 100K TPD; a viral demo exhausts this. *Mitigation:* per-IP daily caps, output-token caps, response caching, and a Gemini Flash-Lite fallback provider.
3. **Supabase 7-day pausing + 500MB cap.** A paused project kills a live interview demo; 500MB fills with vectors. *Mitigation:* scheduled keep-alive ping from day one; 768-dim embeddings; Neon as documented fallback.
4. **Cloudflare Workers runtime incompatibility.** 10ms free CPU cannot parse PDFs; some Node APIs/native modules do not run in workerd. *Mitigation:* use `unpdf`/`pdfjs-serverless` (edge-built); offload heavy ingestion to a Node host or the $5/mo paid plan (up to 5-min CPU).
5. **Embedding dimension / storage budget mismatch.** Default 3072-dim Gemini vectors would blow the 500MB budget fast. *Mitigation:* Matryoshka-truncate to 768 dims; monitor DB size weekly; document the quality/size tradeoff.

## Definition of Done checklist
- [ ] Upload → parse-with-positions → chunk → embed (768-dim) → store works for all demo PDFs.
- [ ] Hybrid RRF search beats dense-only on golden recall@k (numbers recorded).
- [ ] LLM reranker improves nDCG@5 / citation precision (numbers recorded).
- [ ] Multi-query expansion improves recall on ambiguous questions without precision collapse.
- [ ] Answers are grounded, cite chunk IDs inline, and refuse when unsupported.
- [ ] Clicking any golden citation scrolls to the right page and highlights the correct passage at multiple zoom levels.
- [ ] promptfoo eval suite (recall@k, MRR/nDCG, faithfulness, citation precision) runs in CI as a PR gate.
- [ ] Langfuse traces every chat request with chunk + token metadata.
- [ ] Per-IP rate limiting + output caps enforced; public demo works without login.
- [ ] Playwright E2E covers the citation-to-highlight flow; Vitest covers chunking/rects/RRF.
- [ ] TypeScript strict passes everywhere; accessibility pass done; Lighthouse/CWV captured.
- [ ] Live demo deployed under 5 EUR/month with keep-alive; README whitepaper + ADRs + demo video published.

## Stretch goals
- **Contextual retrieval** (Anthropic-style per-chunk context prepended before embedding) — highest-quality upgrade, but an LLM call per chunk; only if free-tier ingestion budget allows.
- **GraphRAG-lite** — entity/relationship extraction over the corpus for multi-hop questions (documented as deliberately out of scope for the core build).
- **Multi-document compare** — answer questions that synthesize across two documents with per-source citations.
- **Agentic query router** — a small LLM classifier that chooses the retrieval strategy (direct / multi-query / HyDE) per query.

## Caveats
- **Free-tier numbers drift.** All quoted limits (Groq 30 RPM/1,000 RPD/100K TPD, Gemini embedding 2,048-token cap and $0.15/1M paid rate, Supabase 500MB/7-day pause, Neon 100 CU-hours/0.5GB, Cloudflare 10ms free CPU / 300,000ms paid, Langfuse 50k units) are mid-2026 figures and should be re-verified on official pricing pages before you rely on them.
- **Gemini free-tier privacy:** free-tier prompts/embeddings may be used to improve Google's products; do not send sensitive documents through the free tier, and state this in the demo.
- **AI SDK v6 API churn:** v6 replaced the `useChat` composable with a `Chat` class in `@ai-sdk/vue`; confirm the exact import and reactivity pattern against current docs, and pin versions. *(Resolved: v7 is current and restored `useChat` — see TECH_NOTES.md.)*
- **Cloudflare runtime incompatibilities:** some Node APIs and native modules do not run in workerd; `unpdf`/`pdfjs-serverless` are specifically built for this, but validate any other server dependency against the edge runtime, and remember the free CPU limit blocks heavy parsing regardless of the library.
- **Highlight accuracy is inherently imperfect:** `item.height` from PDF.js can be unreliable, text items can fragment or arrive out of reading order, and wrapped lines need per-line rects — budget for a text-match verification fallback and expect edge-case misses on complex layouts.
- **Vercel Hobby is non-commercial**, so if this project ever earns money, its Vercel-hosted parts would need a paid plan.

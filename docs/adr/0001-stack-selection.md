# ADR-0001: Overall stack selection

- **Status:** Accepted. Amended: generation by [ADR-0005](./0005-citations-and-grounding.md) and [TECH_NOTES §9](../TECH_NOTES.md) (Groq `openai/gpt-oss-120b`, Gemini 3.5 Flash-Lite fallback); the viewer uses the `pdfjs-dist` legacy build directly, without a Vue wrapper ([ADR-0004](./0004-extraction-and-highlights.md)).
- **Date:** 2026-07-08

## Context

TruthBase is a portfolio-grade verifiable RAG knowledge base targeting a Senior/Tech-Lead signal, with a hard budget of ≤ 5 EUR/month infra. The full analysis (free-tier limits, benchmarks, sources) lives in [EXECUTION_PLAN.md](../EXECUTION_PLAN.md); this ADR records the resulting decisions.

## Decision

One Nuxt 4 (4.4.x) project; all secret-bearing and compute-heavy work in Nitro server routes:

| Concern | Choice |
|---|---|
| Framework / UI | Nuxt 4, Nuxt UI v4 (Tailwind v4 as peer dep), `@vueuse/nuxt`, `nuxt-security`, `zod` |
| Database + retrieval | Supabase Postgres free tier: pgvector (HNSW, cosine) + native `tsvector` FTS, fused via RRF (`k≈50–60`) in an SQL RPC |
| Embeddings | Google `gemini-embedding-001`, Matryoshka-truncated to **768 dims**, manually L2-normalized (fallback: Jina) |
| Generation | ~~Groq `llama-3.3-70b-versatile` primary; Gemini 2.5 Flash-Lite fallback~~ → Groq `openai/gpt-oss-120b` primary; Gemini `gemini-3.5-flash-lite` fallback on 429 / 5xx (llama-3.3 left Groq's free tier; 2.5 Flash-Lite is closed to new keys) |
| Reranking | Listwise LLM-as-reranker on Groq |
| PDF extraction | `unpdf` (serverless PDF.js) with position metadata (`getTextContent()` items) |
| Viewer / highlight | `pdfjs-dist` (legacy build, client-only component, no wrapper library); overlay-div model `{pageNumber, boundingRect, rects[], pageWidth/Height, char offsets}` |
| AI SDK | Vercel AI SDK **v7** (`ai@7.x`, `@ai-sdk/vue@4.x` `useChat`, `@ai-sdk/groq@4.x`, `@ai-sdk/google@4.x`) — amended from the brief's v6; see [TECH_NOTES.md](../TECH_NOTES.md) |
| Evals / tracing | promptfoo (offline, CI gate) + Langfuse Hobby (runtime traces) |
| Deployment | Cloudflare Workers Paid ($5/mo) whole-app, OR CF free + ingestion offloaded to a Node host (decided in Phase 14). **Decided: Vercel Hobby, one Node 24 function, ingestion via CLI ([ADR-0011](./0011-deployment-topology.md)).** |

## Rationale

The most defensible free/near-free architecture that still demonstrates senior-level retrieval engineering: hybrid retrieval with measured RRF fusion, reranking, evals as a CI gate, and the citation-to-highlight mapping as the differentiator. Every component has a documented free tier whose binding constraints (Groq 1,000 RPD / 100K TPD; Supabase 500MB + 7-day pause; Cloudflare free 10ms CPU) are designed around rather than discovered late.

## Rejected alternatives

- **`pg_search`/BM25 (ParadeDB)** — not available on hosted Supabase (2026); native `tsvector` + RRF is the pragmatic free choice.
- **External vector DB (Pinecone/Weaviate)** — unnecessary at this scale, not free.
- **OpenAI/Anthropic generation** — not free.
- **Cohere/Voyage/Jina as primary reranker** — trial caps too tight for a public demo; self-hosted cross-encoder exceeds free edge limits.
- **Semantic/late/contextual chunking for v1** — cost/latency (contextual = LLM call per chunk) outweighs benefit at this scale; recursive ~512-token splitting wins on accuracy/effort. Contextual retrieval kept as a stretch goal.
- **Full multi-tenant auth from day one** — cost/complexity without portfolio payoff; public demo workspace + rate limits instead.
- **Ragas for evals** — Python, wrong ecosystem for a TS-only project.
- **LangSmith / self-hosted Langfuse** — smaller free tier / too much ops respectively.
- **GraphRAG** — overkill for the core build; documented as stretch only.

## Consequences

- Free-tier limits are architectural inputs: per-IP caps and provider fallbacks are mandatory features (Phase 11), not hardening.
- 768-dim embeddings trade some retrieval quality for fitting the 500MB budget; re-embedding later is cheap, so this is reversible.
- The highlight data model must be captured **at ingestion** (Phase 3) — retrofitting positions later would mean re-parsing everything.
- Deployment topology stays open until Phase 14, hinging on whether 5 EUR/month is acceptable vs. a free split deployment. *(Resolved in [ADR-0011](./0011-deployment-topology.md): Vercel Hobby, free.)*

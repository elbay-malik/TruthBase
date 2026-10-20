# TruthBase

> 🚧 **Status: Phases 0–11 built**: grounded chat with citations, and clicking a citation scrolls the PDF to the exact highlighted passage (placement verified on all 60 golden spans at 3 zoom levels; one TeX math glyph is a known gap, see ADR-0004), on top of tuned hybrid search, LLM reranking, multi-query expansion, evals, tracing and daily quotas. Some final numbers are still pending (reranking, query rewriting, the first full LLM eval; see ADR-0007/0008/0009). Next: Phase 12, UI polish and accessibility. See [ROADMAP.md](./ROADMAP.md) for progress.

**TruthBase** is a verifiable, advanced-RAG knowledge base built on Nuxt 4. Ingest PDFs (operator-only until Phase 11b adds uploads), ask questions, and get grounded answers with inline citations — where **clicking a citation scrolls the PDF viewer to the exact page and highlights the exact supporting passage**.

What is built today (Phases 0–11):

- **Hybrid search**: pgvector (dense) and Postgres full-text search (`tsvector`), fused with weighted Reciprocal Rank Fusion in SQL on Supabase, tuned on the golden set ([ADR-0006](./docs/adr/0006-hybrid-search.md)).
- **Reranking and query rewriting**: a listwise LLM reranker on Groq `openai/gpt-oss-20b` ([ADR-0007](./docs/adr/0007-reranking.md)) and self-gated multi-query expansion for ambiguous or multi-part questions ([ADR-0009](./docs/adr/0009-query-rewriting.md)). Both are optional at run time and fall back to the fused order.
- **Grounded generation with citations**: Groq `openai/gpt-oss-120b`, falling back to Gemini 3.5 Flash-Lite when Groq rate-limits or fails, streamed with the Vercel AI SDK. Sources are delimited and treated as quoted material, never as instructions. When nothing retrieved supports an answer, the app refuses instead of guessing.
- **Citation-to-highlight mapping**: per-line PDF rects are computed at ingestion from PDF.js glyph advances and checked against MuPDF to 0.05 pt. The viewer draws them as overlays. If the page text no longer matches, it falls back to an "approximate" highlight.
- **Measured**: a 50-question golden set ([docs/golden](./docs/golden)), an offline retrieval gate in CI (`pnpm eval:retrieval`: recall@k, MRR, nDCG@5), a manual and weekly promptfoo LLM eval with a judge (`pnpm eval:llm`: faithfulness, citation precision, refusals) and a headless-browser highlight check (`pnpm check:viewer`). See [docs/evals](./docs/evals). Each chat request is traced to Langfuse when its keys are set (retrieval steps, model calls, tokens, time to first token).
- **Abuse protection**: daily per-client and whole-demo caps in Postgres on top of the per-minute limiter, with a clean 429 ([ADR-0010](./docs/adr/0010-abuse-protection.md)). The demo workspace needs no login.

Planned (see [ROADMAP.md](./ROADMAP.md)): bring-your-own-docs uploads behind Supabase Auth (Phase 11b), UI polish and accessibility (Phase 12), end-to-end tests (Phase 13) and deployment (Phase 14).

📋 Full architecture and phase-by-phase plan: [docs/EXECUTION_PLAN.md](./docs/EXECUTION_PLAN.md)
🔧 Version corrections & API deltas vs. the original brief: [docs/TECH_NOTES.md](./docs/TECH_NOTES.md)
🧠 Architecture decisions: [docs/adr/](./docs/adr/)

## Development

Requires Node 24 (`.nvmrc`, fnm-compatible) and pnpm 11 (`packageManager` field).

```bash
pnpm install        # also runs `nuxt prepare`
pnpm dev            # dev server at http://localhost:3000
pnpm typecheck      # `nuxt typecheck` + the CLI scripts (tsconfig.scripts.json)
pnpm lint           # eslint flat config
pnpm test           # vitest (unit + nuxt projects)
```

Operator scripts (need `.env`): `pnpm ingest:golden` seeds the golden PDFs, the evals are listed in [docs/evals](./docs/evals/README.md), and `pnpm check:viewer` runs the highlight acceptance check against `NUXT_DISABLE_RATE_LIMIT=1 pnpm dev`. Install its browser once first with `pnpm exec playwright-core install chromium`.

Secrets are server-only via Nuxt `runtimeConfig` — copy [.env.example](./.env.example) to `.env` for local development. Nothing secret ever ships to the client.

## License

[MIT](./LICENSE)

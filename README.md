# TruthBase

> 🚧 **Status: Phases 0–5 complete**: grounded chat with citations, and clicking a citation scrolls the PDF to the exact highlighted passage (placement verified on all 60 golden spans at 3 zoom levels; one TeX math glyph is a known gap, see ADR-0004). Next: Phase 6, hybrid search tuning. See [ROADMAP.md](./ROADMAP.md) for progress.

**TruthBase** is a verifiable, advanced-RAG knowledge base built on Nuxt 4. Ingest PDFs (operator-only until Phase 11 adds uploads), ask questions, and get grounded answers with inline citations — where **clicking a citation scrolls the PDF viewer to the exact page and highlights the exact supporting passage**.

What is built today (Phases 0–5):

- **Hybrid search**: pgvector (dense, HNSW) and Postgres full-text search (`tsvector`), fused with Reciprocal Rank Fusion in SQL on Supabase.
- **Grounded generation with citations**: Groq `openai/gpt-oss-120b`, falling back to Gemini 3.5 Flash-Lite when Groq rate-limits or fails, streamed with the Vercel AI SDK. Sources are delimited and treated as quoted material, never as instructions. When nothing retrieved supports an answer, the app refuses instead of guessing.
- **Citation-to-highlight mapping**: per-line PDF rects are computed at ingestion from PDF.js glyph advances and checked against MuPDF to 0.05 pt. The viewer draws them as overlays. If the page text no longer matches, it falls back to an "approximate" highlight.
- **Measured**: a 50-question golden set ([docs/golden](./docs/golden)), a retrieval + answer eval (`pnpm eval:answers`: recall@k, citation precision, refusal accuracy) and a headless-browser highlight check (`pnpm check:viewer`).

Planned (see [ROADMAP.md](./ROADMAP.md)): hybrid tuning (Phase 6), an LLM reranker (Phase 7), promptfoo evals as a CI gate (Phase 9), Langfuse tracing (Phase 10) and bring-your-own-docs uploads (Phase 11).

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

Operator scripts (need `.env`): `pnpm ingest:golden` seeds the golden PDFs, `pnpm eval:answers --label <name> [--model groq|gemini]` runs the golden-set eval, and `pnpm check:viewer` runs the highlight acceptance check against `NUXT_DISABLE_RATE_LIMIT=1 pnpm dev`. Install its browser once first with `pnpm exec playwright-core install chromium`.

Secrets are server-only via Nuxt `runtimeConfig` — copy [.env.example](./.env.example) to `.env` for local development. Nothing secret ever ships to the client.

## License

[MIT](./LICENSE)

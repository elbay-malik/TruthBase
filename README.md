# TruthBase

> 🚧 **Status: Phases 0–5 complete**: grounded chat with citations, and clicking a citation scrolls the PDF to the exact highlighted passage (verified on all 60 golden spans at 3 zoom levels). Next: Phase 6, hybrid search tuning. See [ROADMAP.md](./ROADMAP.md) for progress.

**TruthBase** is a verifiable, advanced-RAG knowledge base built on Nuxt 4. Upload PDFs, ask questions, and get grounded answers with inline citations — where **clicking a citation scrolls the PDF viewer to the exact page and highlights the exact supporting passage**.

Key retrieval engineering under the hood:

- **Hybrid search** — pgvector (dense, HNSW) + Postgres full-text (`tsvector`), fused with Reciprocal Rank Fusion in SQL on Supabase.
- **LLM reranking** — listwise reranker over fused candidates before generation.
- **Grounded generation with citations** — Groq (`llama-3.3-70b-versatile`) primary, Gemini fallback, streaming via the Vercel AI SDK.
- **Citation-to-highlight mapping** — per-chunk position metadata (`pageNumber`, `boundingRect`, per-line `rects[]`, char offsets) captured at ingestion and reconstructed as PDF.js overlays at view time.
- **Measured, not vibed** — golden Q&A dataset, promptfoo evals (recall@k, MRR/nDCG, faithfulness, citation precision) as a CI gate, Langfuse tracing.

📋 Full architecture and phase-by-phase plan: [docs/EXECUTION_PLAN.md](./docs/EXECUTION_PLAN.md)
🔧 Version corrections & API deltas vs. the original brief: [docs/TECH_NOTES.md](./docs/TECH_NOTES.md)
🧠 Architecture decisions: [docs/adr/](./docs/adr/)

## Development

Requires Node 24 (`.nvmrc`, fnm-compatible) and pnpm 11 (`packageManager` field).

```bash
pnpm install        # also runs `nuxt prepare`
pnpm dev            # dev server at http://localhost:3000
pnpm typecheck      # vue-tsc via `nuxt typecheck`
pnpm lint           # eslint flat config
pnpm test           # vitest (unit + nuxt projects)
```

Secrets are server-only via Nuxt `runtimeConfig` — copy [.env.example](./.env.example) to `.env` for local development. Nothing secret ever ships to the client.

## License

[MIT](./LICENSE)

# TruthBase

> 🚧 **Status: Phases 0–13 built**: grounded chat with citations, and clicking a citation scrolls the PDF to the exact highlighted passage (placement verified on all 60 golden spans at 3 zoom levels; one TeX math glyph is a known gap, see ADR-0004), on top of tuned hybrid search, LLM reranking, multi-query expansion, evals, tracing and daily quotas, in an accessible, keyboard-operable UI (Lighthouse accessibility 100, see [Quality](#quality)). Some final numbers are still pending (reranking, query rewriting, the first full LLM eval; see ADR-0007/0008/0009). Vitest covers chunking, highlight rects and RRF fusion, and a Playwright E2E checks citation → highlight on every golden span in CI. Next: Phase 14, deployment. See [ROADMAP.md](./ROADMAP.md) for progress.

**TruthBase** is a verifiable, advanced-RAG knowledge base built on Nuxt 4. Ingest PDFs (operator-only until Phase 11b adds uploads), ask questions, and get grounded answers with inline citations — where **clicking a citation scrolls the PDF viewer to the exact page and highlights the exact supporting passage**.

What is built today (Phases 0–12):

- **Hybrid search**: pgvector (dense) and Postgres full-text search (`tsvector`), fused with weighted Reciprocal Rank Fusion in SQL on Supabase, tuned on the golden set ([ADR-0006](./docs/adr/0006-hybrid-search.md)).
- **Reranking and query rewriting**: a listwise LLM reranker on Groq `openai/gpt-oss-20b` ([ADR-0007](./docs/adr/0007-reranking.md)) and self-gated multi-query expansion for ambiguous or multi-part questions ([ADR-0009](./docs/adr/0009-query-rewriting.md)). Both are optional at run time and fall back to the fused order.
- **Grounded generation with citations**: Groq `openai/gpt-oss-120b`, falling back to Gemini 3.5 Flash-Lite when Groq rate-limits or fails, streamed with the Vercel AI SDK. Sources are delimited and treated as quoted material, never as instructions. When nothing retrieved supports an answer, the app refuses instead of guessing.
- **Citation-to-highlight mapping**: per-line PDF rects are computed at ingestion from PDF.js glyph advances and checked against MuPDF to 0.05 pt. The viewer draws them as overlays. If the page text no longer matches, it falls back to an "approximate" highlight.
- **Measured**: a 50-question golden set ([docs/golden](./docs/golden)), an offline retrieval gate in CI (`pnpm eval:retrieval`: recall@k, MRR, nDCG@5), a manual and weekly promptfoo LLM eval with a judge (`pnpm eval:llm`: faithfulness, citation precision, refusals) and a headless-browser highlight check (`pnpm check:viewer`). See [docs/evals](./docs/evals). Each chat request is traced to Langfuse when its keys are set (retrieval steps, model calls, tokens, time to first token).
- **Accessible UI**: WCAG AA contrast in light and dark, a visible focus ring on every control, and a keyboard-only citation flow (`/`, Tab, Enter, `[` `]`, Esc) with live announcements. Brotli/gzip for HTML, JSON and static assets; the landing page loads no PDF.js or PDF until a citation or document is opened.
- **Abuse protection**: daily per-client and whole-demo caps in Postgres on top of the per-minute limiter, with a clean 429 ([ADR-0010](./docs/adr/0010-abuse-protection.md)). The demo workspace needs no login.

Planned (see [ROADMAP.md](./ROADMAP.md)): bring-your-own-docs uploads behind Supabase Auth (Phase 11b) and deployment (Phase 14).

📋 Full architecture and phase-by-phase plan: [docs/EXECUTION_PLAN.md](./docs/EXECUTION_PLAN.md)
🔧 Version corrections & API deltas vs. the original brief: [docs/TECH_NOTES.md](./docs/TECH_NOTES.md)
🧠 Architecture decisions: [docs/adr/](./docs/adr/)

## Quality

Phase 12 numbers, measured 2026-10-20 on a production build (`node .output/server/index.mjs` on localhost, MacBook Air M5) with Lighthouse 13.5.0, chrome-headless-shell 149, default simulated throttling, median of 3 runs. `/?chunk=…` is a citation deep link that opens the PDF (nist-csf-2.0.pdf, p. 28) with its highlight. Before = the same audit at the start of Phase 12.

| Page | Preset | Accessibility | Performance | Best practices | SEO | FCP | LCP | TBT | CLS | Transfer |
|---|---|---|---|---|---|---|---|---|---|---|
| `/` | mobile | 94–95 → **100** | 59 → **98** | 96 → **100** | 100 | 6.6 → **1.05 s** | 9.4 → **2.40 s** | 97 → **32 ms** | 0 | 1508 → **300 KiB** |
| `/` | desktop | 89–91 → **100** | 90 → **100** | 96 → **100** | 100 | 1.16 → **0.28 s** | 1.67 → **0.53 s** | 0 | 0 | 3413 → **301 KiB** |
| `/?chunk=…` | mobile | 91 → **100** | 59 → **98** | **100** | 100 | **1.05 s** | 9.4 → **2.41 s** | **34 ms** | **< 0.001** | **1909 KiB** |
| `/?chunk=…` | desktop | 89 → **100** | 90 → **100** | **100** | 100 | **0.28 s** | **0.50 s** | 0 | 0.012 → **< 0.001** | **1910 KiB** |

All 12 runs scored 100 for accessibility, best practices and SEO; mobile performance ranged 96–98 (Speed Index variance on one deep-link run), desktop was 100 every time. The deep link's transfer is mostly the PDF and the PDF.js worker, which the landing page no longer loads.

- **axe-core: 0 violations** in 44 runs (11 UI states, from landing to streaming, refusal, errors, daily cap and the open viewer, × desktop/phone × light/dark).
- **Contrast**: every text and control state is at least 4.5:1 in both themes (Ask and chips including hover, the error, PDF-error and refusal alerts, the "approximate" badge). The highlight outline is 4.9:1 against the page and the focus ring at least 5.5:1 against what surrounds it.
- **Interaction (lab, INP proxy)**: TBT above; no long tasks while an answer streams or citations are clicked. A citation in the open document scrolls its highlight into view in 13–22 ms, a zoom step takes 45–126 ms, and streaming an answer shifts the layout by CLS ≤ 0.002.
- **Keyboard-only citation flow**: `/` focuses the question from anywhere, Enter sends, Tab walks the citation chips in reading order, Enter on a chip highlights the passage, moves focus to the viewer and announces "Page 28, Citation 1 of 3", `[` / `]` step through the citations, and Esc returns focus to the chip of the citation shown (on phones it closes the sheet). Focus never drops to the page body after Ask, Retry or a zoom limit, and Tab stays inside the phone viewer sheet.

Re-run with `pnpm lighthouse --base http://localhost:3100` against a production build (`pnpm build`, then `PORT=3100 NUXT_TRUSTED_IP_HEADER=x-audit-ip node --env-file=.env .output/server/index.mjs`). It prints the median table and keeps the reports in `.cache/lighthouse/`; the browser is chrome-headless-shell (`pnpm exec playwright-core install --only-shell chromium`). Neither page spends LLM quota.

## Development

Requires Node 24 (`.nvmrc`, fnm-compatible) and pnpm 11 (`packageManager` field).

```bash
pnpm install        # also runs `nuxt prepare`
pnpm dev            # dev server at http://localhost:3000
pnpm typecheck      # `nuxt typecheck` + the CLI scripts (tsconfig.scripts.json)
pnpm lint           # eslint flat config
pnpm test           # vitest (unit + nuxt projects)
pnpm test:e2e:build # production build + Playwright E2E (no secrets, no network)
```

The E2E suite runs the production build with the backend replaced by repo fixtures and a local Supabase stub ([ADR-0012](./docs/adr/0012-hermetic-e2e.md)): ask → click a citation → the overlay sits on the cited lines, on the right page, at 50/100/200% zoom, desktop and phone. Install its browser once with `pnpm exec playwright install chromium`; more in [TECH_NOTES §19](./docs/TECH_NOTES.md#19-testing-phase-13).

Operator scripts (need `.env`): `pnpm ingest:golden` seeds the golden PDFs, the evals are listed in [docs/evals](./docs/evals/README.md), and `pnpm check:viewer` runs the highlight acceptance check against `NUXT_DISABLE_RATE_LIMIT=1 pnpm dev`. It uses the same browser as the E2E suite.

Secrets are server-only via Nuxt `runtimeConfig` — copy [.env.example](./.env.example) to `.env` for local development. Nothing secret ever ships to the client.

## License

[MIT](./LICENSE)

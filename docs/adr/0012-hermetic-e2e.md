# ADR-0012: Hermetic E2E tests for the citation-to-highlight flow

- **Status:** Accepted
- **Date:** 2026-10-20

## Context

Phase 13's acceptance is "CI runs unit + E2E green, including the highlight assertion". The flow it guards: ask → the answer streams in with citation chips → click a chip → the viewer opens the right document at the right page with the overlay on the cited passage.

Running the real flow needs a Supabase project with the corpus ingested, a Gemini key for the query embedding and a Groq key for the answer. Pull-request CI has no secrets, and both model APIs are on free tiers shared with the demo (ADR-0008). Answers vary between runs, and the hosted database changes whenever something is re-ingested. `pnpm check:viewer` already checks every golden span against the live backend through the deep-link path, but it needs `.env`, so it can't run in CI.

## Decision

**Playwright E2E against the production build, with the backend replaced at its boundaries by repo fixtures** (`test/e2e/`, CI job `e2e`).

1. **The browser's `/api/*` requests are answered by `page.route`** (`test/e2e/fixtures.ts`): documents, chat, chunk deep links and signed file URLs. Chat answers are built in the AI SDK's UI-message stream format from `test/fixtures/highlight-spans.json`, the stored chunk rects that `pnpm fixtures:highlights` computes from the golden PDFs with the production ingestion code. One answer per golden question cites the chunk of every evidence span. One real `/api/chat` response (g-020, Groq) is replayed byte for byte with its headers, so the UI is also checked against the real wire format. Any `/api/*` call that no fixture handles fails the test.
2. **The server side gets a local Supabase stub** (`test/e2e/supabase-stub.ts`) on its own origin: PostgREST for the documents listing the page's SSR fetches, and Storage for the signed PDF URLs, with Range, 206/416 and CORS as Supabase serves them. Any request it doesn't answer fails the test.
3. **The server is `node .output/server/index.mjs`** with empty model keys and ports from `test/e2e/ports.ts` (3100/3101), never reusing an already running server.
4. **The highlight assertion** at zoom 50/100/200% checks that the right document and page are open, that the passage is scrolled into view, and that every overlay box is within 0.5 px of an independent PDF → CSS conversion of the stored rects. On desktop (DPR 2, as in `check:viewer`) it also checks `check:viewer`'s vertical ink coverage on the rendered canvas: every line has ink, and at least 90% of lines reach SPEC's threshold (0.99 at zoom ≥ 100%, 0.9 at 50%). Desktop runs all 45 answerable golden questions; the phone project (bottom sheet) runs 8 core questions (all, with `E2E_FULL=1`).
5. **Around it:** deep links, a PDF that loads only by Range requests, the keyboard-only flow, `NO_ANSWER`, the daily cap's 429, the stream's `error` part, PDF load failure and Retry, and an interrupted stream.

## Rationale

- **The geometry is deterministic, and that's what the test should pin down.** The fixtures carry exactly the rects ingestion stores, so a failure means the viewer moved, scaled or dropped a box, not that the model answered differently today. Runs are reproducible: 77 passed, 0 flaky, in three consecutive CI-mode runs (about 74 s each with 2 workers).
- **The ink check stops the test from just restating the rects.** A geometry check alone only proves that the app converts rects to CSS px. Drawing the canvas 10% smaller left the overlay geometry correct and passed every test until ink coverage was added; now that mutation fails all 52 desktop highlight tests, and a 2 px overlay offset fails all 67 tests that check geometry.
- **Production build, real cross-origin PDF loading.** CSP, compression, the bundled PDF.js data files and the worker only behave as in production on a build (TECH_NOTES §11). The stub's Storage origin exercises CORS and Range loading, which a same-origin file route would skip.
- **No secrets, no quota, no network.** The job runs on every PR, including from forks, and doesn't spend the demo's free tier.

## Rejected alternatives

- **Live backend in CI** (hosted Supabase with Groq and Gemini): needs secrets in PR runs, spends quota on every push, answers and citations change from run to run, and the result depends on what is currently ingested.
- **Local Supabase plus recorded model responses:** the CI `db` job already brings up Postgres, but the full stack (Storage, PostgREST, Auth) adds minutes per run, and model calls would still need recording. The SQL it would exercise is tested directly (below).
- **Mocking at the server (Nitro) instead of in the browser:** needs test-only code paths in the production bundle. `page.route` leaves the build untouched.
- **Component tests of `PdfViewer` only:** they miss streaming, the chips, the phone sheet, the CSP and the real PDF.js worker.

## Consequences

**What the E2E suite does not cover, and where that is tested instead:**

- **Server routes** (`/api/chat`, `/api/search`, `/api/chunks/:id`, `/api/documents/:id/file`, `/api/ingest`): Vitest (`test/unit`, `test/nuxt`) for the logic and the CI `build` job's smoke test for the built server's behaviour without secrets.
- **Retrieval and RRF:** `fuseRankings` in Vitest; `hybrid_search` by `supabase/tests/hybrid_search.sql` and the retrieval gate on the real corpus (ADR-0008), both in the CI `db` job.
- **Chunking and rects:** Vitest (`ingest-chunk`, `ingest-highlight`, `ingest-glyphs`, `ingest-glyph-replay`, `pdf-highlight`, including a test that the viewer and the server group lines the same way). Edges against MuPDF are pinned in `ingest-glyphs`.
- **Answer quality** (grounding, citation choice, refusals): the LLM eval (ADR-0008), manual and weekly.
- **The live backend path** (signed URLs from real Storage, the ingested corpus, deep links): `pnpm check:viewer`, run by hand with `.env` before a release.
- **Upload → ask**, the first step in EXECUTION_PLAN Phase 13: ingestion is operator-only behind a token until bring-your-own-docs uploads (Phase 11b), which will need their own E2E.

**Costs:**

- **Fixtures follow the corpus.** After re-ingesting or changing chunking or rects: `pnpm fixtures:highlights`, then `pnpm fixtures:e2e`. The recorded g-020 stream must be re-recorded if the stream format changes (an AI SDK upgrade).
- **The ink check runs only on desktop.** At the Pixel 7's DPR 2.625, anti-aliasing alone keeps correct lines at about 0.96. The phone project keeps every geometry, page and scroll check.
- **Ink coverage is vertical only**, as in `check:viewer`: a canvas shifted only horizontally under a correct overlay would pass.
- **Known app bug tracked as `test.fixme`:** on phones, closing the sheet opens the chip's tooltip (`test/e2e/states.spec.ts`).

**Revisit** when Phase 11b adds uploads (an upload → highlight E2E against a local stack), or if a deploy-time smoke test against the live demo becomes worthwhile (Phase 14).

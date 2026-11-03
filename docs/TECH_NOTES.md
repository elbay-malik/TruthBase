# Tech Notes — verified corrections to the execution plan

Verified 2026-07-08 against npm and official docs (Nuxt, Nuxt UI, AI SDK, pnpm, Node). The [execution plan](./EXECUTION_PLAN.md) was researched against mid-2026 sources; these are the deltas discovered when bootstrapping the repo. Re-verify before each phase — versions drift.

## 1. Vercel AI SDK is v7, not v6 (affects Phases 3, 4, 7, 8)

`ai@7.0.17` went GA 2026-06-25. The brief was written against v6. Start all AI SDK code on v7.

**Pinned versions** (companion packages keep independent majors — there is no `@ai-sdk/vue@7`):

| Package | Version |
|---|---|
| `ai` | 7.0.17 |
| `@ai-sdk/vue` | 4.0.17 |
| `@ai-sdk/google` | 4.0.9 |
| `@ai-sdk/groq` | 4.0.5 |

**v6 → v7 deltas relevant to this project:**

- The `@ai-sdk/vue` **`Chat` class is deprecated** (removal in v8). v7 is back to a **`useChat` composable**: `const { messages, sendMessage } = useChat()`.
- Renames (old names are deprecated aliases in v7, gone in v8): `system` → `instructions`, `onFinish` → `onEnd`, `result.fullStream` → `result.stream`.
- Server streaming pattern: `result.toUIMessageStreamResponse({ sendSources: true })` is deprecated. Use:
  ```ts
  return createUIMessageStreamResponse({
    stream: toUIMessageStream({ stream: result.stream, sendSources: true }),
  })
  ```
- Unchanged and still current: `streamText` / `generateObject` / `streamObject` / `embed` / `embedMany`; UI part types `source-url` and `source-document`; `createUIMessageStream` + `writer.write({ type: 'data-*', ... })` for custom RAG citation parts; SSE `DefaultChatTransport`.
- Multi-step results restructured: top-level `usage`/`content`/`toolCalls`/`sources` accumulate across steps; final-step-only data moved under `finalStep` (matters if we add tool calls).
- OpenTelemetry moved out of core into `@ai-sdk/otel` (`experimental_telemetry` → `telemetry`) — relevant to Phase 10 Langfuse wiring.
- v7 is **ESM-only** and requires **Node ≥ 22** — non-issue for Nuxt, matters for standalone ingest/eval scripts.

## 2. Gemini embeddings: truncated vectors are NOT normalized (affects Phases 2, 3, 6)

*Historical since 2026-11-04: embeddings are bge-m3 (§21). The app still L2-normalizes every vector.*

Per Google's model docs, only the full 3072-dim `gemini-embedding-001` output is L2-normalized. When truncating via `providerOptions.google.outputDimensionality: 768`, **normalize the vectors ourselves before storing/cosine-comparing** — the SDK does not do it. Also set `taskType`: `RETRIEVAL_DOCUMENT` for chunks, `RETRIEVAL_QUERY` for queries.

```ts
const { embeddings } = await embedMany({
  model: google.textEmbedding('gemini-embedding-001'),
  values: chunks,
  providerOptions: { google: { outputDimensionality: 768, taskType: 'RETRIEVAL_DOCUMENT' } },
})
// then: v.map(x => x / l2norm(v)) before insert
```

Note: the AI SDK docs now showcase `gemini-embedding-2`; `gemini-embedding-001` remains available. Pin the model ID explicitly and record the dimension in the schema (ADR when we get to Phase 2).

## 3. @nuxt/ui v4 does not bundle Tailwind (corrects Phase 1 wording)

`tailwindcss@^4` is a **peerDependency** of `@nuxt/ui`, not bundled — install it explicitly (`pnpm add @nuxt/ui tailwindcss`; required under pnpm's strict `node_modules`). The brief's decision stands (no `@nuxtjs/tailwindcss` module — that's Tailwind v3-era and conflicts). `@nuxt/ui` auto-registers `@nuxt/icon`, `@nuxt/fonts`, `@nuxtjs/color-mode` — do not add them to `modules`. `<UApp>` must wrap the app for toasts/tooltips/overlays.

## 4. Corepack is going away (affects CI)

Node TSC removed Corepack from Node 25+; it is experimental-but-bundled in Node 24. CI uses `pnpm/action-setup@v6` (reads the `packageManager` field from `package.json` — do **not** also pass a `version` input) followed by `actions/setup-node@v6` with `cache: pnpm` — order matters. Locally on Node 24 corepack still works.

## 5. nuxt-security 2.6 defaults worth knowing (affects Phases 5, 11, 14)

- Rate limiter is **on by default**: 150 tokens / 5 min per IP, in-memory `lruCache` driver, which does not share state across serverless instances. For production (Phase 11/14) switch to an unstorage driver or platform-level limiting.
- Default CSP (per-request nonces in SSR, meta-tag hashes for static), COEP `credentialless`, and `X-Frame-Options: SAMEORIGIN` can break embeds/third-party scripts — and the PDF.js worker may need CSP tuning in Phase 5. Test headers in the real deployment target, not just `nuxt dev`. **COEP is now off** (§11): it stopped the PDF.js worker in production builds.
- Request size limiter caps uploads at 8MB by default — will need a per-route override for the Phase 3 ingest route.

## 6. Misc Nuxt 4 facts baked into this repo

- `typescript.strict` is **true by default** in Nuxt 4 (we set it explicitly anyway). `nuxt typecheck` runs `vue-tsc`, which must be a devDependency (`nuxi` is the legacy CLI alias).
- Root `tsconfig.json` is generated project-references into `.nuxt/` — never hand-edit; customize via `typescript.tsConfig` / `nitro.typescript.tsConfig`.
- `runtimeConfig` env override only works for keys **declared** in `nuxt.config.ts` (mapping: `supabaseServiceKey` → `NUXT_SUPABASE_SERVICE_KEY`). `.env` is read only at dev/build time; deployed servers need real env vars.
- `@nuxt/test-utils` v4 requires Vitest 4; the Nuxt test environment initializes in `beforeAll`, so composables must not be called at the top level of `describe` blocks.
- pnpm 11 blocks dependency postinstall scripts by default — approve via `pnpm approve-builds` when a dep (esbuild etc.) needs it. The project's own `postinstall: nuxt prepare` runs normally.

## 7. PDF.js / unpdf / AI SDK API deltas found in Phase 3 (affects Phases 3, 5)

Verified against `unpdf@1.9.0` (bundled serverless PDF.js) and `@ai-sdk/google@4.0.9`, 2026-10-16:

- **`viewport.convertToViewportRectangle` is gone.** The bundled PDF.js `PageViewport` only has `convertToViewportPoint` / `convertToPdfPoint`. Convert a rect's two corners and take min/max (see `scripts/render-highlights.ts`). The execution plan, `shared/types` and earlier notes still name the old method; the Phase 5 viewer must use the point form.
- **No `PDFDocumentProxy#destroy`** in the serverless build. Release documents with `pdf.loadingTask.destroy()`, as unpdf does internally.
- **unpdf may detach the input buffer** (it hands it to PDF.js). Pass `bytes.slice()` when the same bytes are needed afterwards (e.g. upload to Storage).
- **`extractTextItems`** returns positioned items in the same order and filter as `extractText`, so text rebuilt from items matches the golden contract exactly (`test/unit/ingest-extract.test.ts`).
- **`google.textEmbedding()` is deprecated** in `@ai-sdk/google` 4.x. Use `google.embedding('gemini-embedding-001')` (§2's snippet predates this).
- The `/api/ingest` size override from §5 is in `nuxt.config.ts` `routeRules` (20 MB, matching the `documents` bucket limit).

## 8. Phase 3.5 spike findings: PDF.js in the browser (affects Phase 5)

Verified in headless Chromium 149 with `pdfjs-dist@6.4.299`, the same version unpdf bundles server-side. Keep the two pinned together.

- **Setup:**
  - Import `pdfjs-dist` lazily on the client only; in Node it warns and needs canvas. Since the audit (§11) it's the legacy build, `import('pdfjs-dist/legacy/build/pdf.mjs')`.
  - Worker: a *dynamic* `import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')` → `GlobalWorkerOptions.workerSrc`. Same-origin, so no blob: wrapper. A static `?url` import put the 1.3 MB worker in every page's preload/prefetch hints; the `build:manifest` hook in `nuxt.config.ts` drops it.
  - Release documents with `loadingTask.destroy()`; there's no `PDFDocumentProxy#destroy`.
  - `getDocument({ data })` detaches the caller's buffer.
- **CSP:** nuxt-security's default `script-src` has `'strict-dynamic'` and no `worker-src`. Add `worker-src 'self' blob:` per route. Route-rule arrays *replace* a directive's defaults, so never override `script-src`. A blocked worker silently falls back to a main-thread "fake worker" that is sticky for the page, so check for it.
- **Text layer:**
  - Needs the `.textLayer` CSS (copied in `app/assets/css/pdf-text-layer.css`) and the `--scale-factor` / `--total-scale-factor` / `--scale-round-x/y` variables on the page wrapper. Without them it lays out at the wrong size with no error.
  - It is **not** glyph truth: spans use a substitute font (sans-serif or monospace) scaled to each item's width, and its vertical box is that font's em box rounded to whole CSS px.
- **The public corpus PDFs are static files** at `/pdfs` (`server/utils/static-pdfs.ts`): same-origin, cached by the CDN, and no Storage egress (ADR-0010). Signed URLs remain for any other document.
- **Supabase Storage signed URLs** answer `Access-Control-Allow-Origin: *`, allow the `Range` header in preflight and serve `206`. `Accept-Ranges` isn't readable cross-origin, so PDF.js downloads the whole file instead of using ranges (fine at 1–2.5 MB). An invalid or expired token returns `400`, which PDF.js reports as `ResponseException`; re-fetch `/api/documents/:id/file` and reload.
- **Exact glyph positions** come from replaying `page.getOperatorList()` (`server/ingest/glyphs.ts`). It needs `getDocumentProxy(data, { fontExtraProperties: true })` for `fontMatrix`/`vertical`.
- **Modern-build requirement:** `pdfjs-dist`'s modern build uses `Map.prototype.getOrInsertComputed`, `Math.sumPrecise` and `URL.parse` unpolyfilled. They're fine in Chromium 149 but break current iOS Safari and Firefox ESR, so the viewer now uses `pdfjs-dist/legacy/build/` (§11).

## 9. Generation models (Phase 4)

- **Groq no longer serves `llama-3.3-70b-versatile`** (the plan's primary). As of 2026-10-17 its text models are `openai/gpt-oss-120b`, `openai/gpt-oss-20b` and `qwen/qwen3.8-27b`. We use `openai/gpt-oss-120b` with `providerOptions.groq = { reasoningEffort: 'low', reasoningFormat: 'hidden' }`. Free tier, per model: **8,000 tokens/min, 1,000 requests/day** (from the `x-ratelimit-*` headers) **and 200,000 tokens/day**, which the headers don't show (found with a 429 in Phase 7; Groq's rate-limits page lists the same). That caps gpt-oss-120b at roughly 100 answers/day. A grounded answer is ~1.7–2.5k tokens, so about 3 answers/min across all users; throttle evals (~25 s/question) and add a Gemini fallback on 429 in Phase 11.
- **gpt-oss cites as `【n】`** (also `【n†L3-L5】`), its native format, and likes Markdown bold. The citation parser accepts both bracket styles (`shared/utils/citations.ts`), and the prompt asks for ASCII brackets and plain text.
- **`gemini-2.5-flash-lite` is closed to new API users** (the API answers "no longer available to new users … use models/gemini-3.5-flash-lite"), even though it still shows in `models.list`. The Gemini fallback is therefore `gemini-3.5-flash-lite` (`server/rag/model.ts`). Verify a model with a real call, not just the listing.
- AI SDK v7 server pattern as used in `server/api/chat.post.ts`: `createUIMessageStream({ execute: ({ writer }) => { writer.write({ type: 'data-sources', data }); writer.merge(toUIMessageStream({ stream: streamText(...).stream })) } })` → `createUIMessageStreamResponse({ stream })`. `streamText` takes `instructions` (not `system`) and `maxOutputTokens`.
- Custom data parts need the message type's data map to be a **type alias**, not an interface, so it satisfies `UIMessage`'s `Record<string, unknown>` constraint (`shared/types/chat.ts`). Narrow parts with a type guard; `Array.find` doesn't narrow unions.
- nuxt-security's `xssValidator` rejects bodies containing `<`/`>`; it's disabled on `/api/chat`, because questions are treated as data and never rendered as HTML. It also checks a page's query string, so it's off on `/` too: a shared passage link carries its claim as `&claim=`, which the page reads on the client and renders as text.

## 10. Viewer (Phase 5)

- **Nuxt UI v4 has no `UButtonGroup`; it's `UFieldGroup`.** An unknown component compiles as a custom element without a typecheck error, so watch the browser console for "Failed to resolve component".
- **Don't branch on `useMediaQuery` outside `<ClientOnly>`.** It's `false` during SSR, so `v-if="isDesktop"` hydrates differently. The pane-vs-sheet decision lives inside `<ClientOnly>`, which is fine because the viewer is browser-only anyway.
- **Guard async document loads with a token.** Opening the default document and then a deep-linked one let the slower first load win, rendering the wrong PDF under the right highlights. Every `await` in `PdfViewer.open()` re-checks the token, and unmounting bumps it. Loaded documents live in a one-entry cache outside the component (`app/utils/pdf-documents.ts`): the phone sheet unmounts the viewer on close and must not download the PDF again. The cache destroys the previous document's loading task as soon as another document opens, even mid-load. A failed `pdfjs-dist` import isn't cached, so the next open retries it.
- **Scripts that pass functions to `page.evaluate`** under `tsx` need `globalThis.__name = (fn) => fn` in the page (esbuild `keepNames` wraps functions in a `__name()` helper that doesn't exist in the browser).
- **Local verification vs. the rate limiter:** `scripts/check-viewer.ts` makes ~200 page loads, so start the dev server with `NUXT_DISABLE_RATE_LIMIT=1` (read in `nuxt.config.ts`). It only works with `nuxt dev`: the config ignores it when `NODE_ENV=production`, so a production build always keeps the limiter.
- **Playwright browser:** the scripts use `playwright-core`, which never downloads browsers. Run `pnpm exec playwright install chromium` once per machine (the build matching the pinned `@playwright/test`, which the E2E suite uses too).

## 11. Post-Phase-5 audit (2026-10-18)

A multi-agent adversarial review of Phases 0–5 confirmed 72 findings (several reported by more than one reviewer) and split on 3. All are fixed except the deferred items at the end of this section. The lessons worth keeping:

- **Production builds differ from `nuxt dev` in ways only a built server shows.** CI now builds and smoke-tests the bundle (`build` job).
  - **COEP blocked the PDF.js worker.** nuxt-security's `credentialless` COEP made the document cross-origin isolated. Chromium then refused the worker script, which has no COEP header, and PDF.js silently fell back to the main-thread "fake worker". Nothing needs isolation (no `SharedArrayBuffer`), so COEP is off. `check:viewer` fails on PDF.js's "Setting up fake worker" warning.
  - **`import.meta.resolve` doesn't survive Nitro bundling**, and `pdfjs-dist` isn't traced into `.output`. Server extraction now reads CMaps and standard fonts through an injected reader (`server/ingest/pdf-assets.ts`): from Nitro server assets in the bundle, from `node_modules` elsewhere. Verified on the built server: a CJK PDF with predefined CMaps passes the `parse` stage.
  - **`NUXT_DISABLE_RATE_LIMIT` is read when the config is evaluated**, so a build made with it set would ship without a limiter. It is now ignored when `NODE_ENV=production`.
- **The browser viewer needs the same PDF.js data files as ingestion.** `/pdfjs/{cmaps,standard_fonts,wasm,iccs}/` are served as Nitro public assets and passed to `getDocument`. Otherwise CID-font pages render blank, or their text layer differs from what ingestion indexed.
- **unpdf and pdfjs-dist are pinned exactly together** (`unpdf@1.9.0` bundles PDF.js 6.4.299). `test/unit/ingest-assets.test.ts` fails if they drift.
- **nuxt-security's XSS validator buffers and stringifies the body before the route runs.** On `/api/ingest` that meant reading an unauthenticated upload of any size, and chunked bodies bypass the Content-Length size limiter. The validator is off for the binary route. The route checks the token, then requires a `Content-Length` (411 without one), before reading anything.
- **Runtime config from env goes through `destr`**, so `NUXT_INGEST_TOKEN=12345` arrives as a number. Coerce with `String()` before hashing.
- **Client disconnects:** the chat route aborts retrieval and generation when the response closes early (Stop button, closed tab). Ingestion checks the same signal between embedding batches and between the store's steps (upload, document row, each chunk batch), and an abort mid-store rolls back like any failure. An abandoned upload stops spending quota and leaves no document behind.
- **Prompt injection:** sources are wrapped in `<source id="n">` tags, look-alike tags inside document text are neutralised, and the instructions say source text is never an instruction. That reduces the risk but doesn't remove it ([ADR-0005](./adr/0005-citations-and-grounding.md)).
- **Eval hygiene:** `hybrid_search` v1 returned a zero-weight arm's rows with score 0, so single-arm recall must drop them (v2 drops them in SQL). v1's candidate pools scaled with `match_count`, so the eval retrieves generation sources with the chat route's `matchCount` instead of truncating a top-10 list. Since Phase 6 it also sends no weights, so the RPC's tuned defaults apply exactly as for the chat.
- **Accepted advisories** (`pnpm audit`, none critical) are listed in `pnpm-workspace.yaml`. They're dev-only or unreachable from the app, and CI fails only on critical ones.

**Deferred (tracked):**
- ~~RRF score ties have no tie-breaker~~ and ~~the keyword arm ANDs every term (keyword-only recall@10 27%)~~: both fixed by `hybrid_search` v2 in Phase 6 ([ADR-0006](./adr/0006-hybrid-search.md)).
- ~~The rate limiter trusts `X-Forwarded-For`~~: since Phase 11 it keys on the trusted client IP that `server/plugins/client-ip.ts` sets, and `NUXT_TRUSTED_IP_HEADER` configures both layers (set it to the host's trusted header at deploy, Phase 14). `/api/chat` (10/min) and `/api/search` (30/min) have tighter per-route limits, which since Phase 14 are also enforced in Postgres across instances (ADR-0010 note). ~~Shared storage~~: the daily caps that bound quota live in Postgres since Phase 11 ([ADR-0010](./adr/0010-abuse-protection.md)); the in-memory limiter is only the burst limit.
- A document row is listed while its chunks are still being inserted (a `status` column comes with Phase 11b uploads). `storeDocument` retries its rollback 3 times and logs `[ingest] rollback: PARTIAL document …` if it still fails; a process killed mid-store can also leave a partial document.
- `check:viewer` drives the deep-link path. Clicking chips in a live answer is covered by the Phase 13 Playwright E2E.

## 12. Reranking (Phase 7)

- **Groq's daily token cap is the binding limit**, not tokens/min: 200K/day per model, refilled gradually (a spent quota lets a call through again after a while, not at midnight). One 45-question rerank eval at 15 candidates costs ~122K tokens, so evals and the demo share one budget ([ADR-0007](./adr/0007-reranking.md)). `scripts/lib/ranking-cache.ts` caches every ranking by (model, prompt) and stops a run on a long Retry-After instead of crashing.
- **`generateText` doesn't enforce `abortSignal` itself**; it hands it to the provider's `fetch`. A model that ignores it (a test mock, a misbehaving provider) hangs past the timeout, so `rerank()` races the call against the signal.
- **gpt-oss-20b returns a partial ranking** (often just its top pick) unless the prompt states the count: "Return all 15 passage numbers … each exactly once".
- **qwen/qwen3.8-27b fails Groq's JSON validation** often with `Output.object` (`json_validate_failed`, echoing the prompt's `[source`); don't use it for structured output.
- **AI SDK v7 structured output:** `generateText({ output: Output.object({ schema }) })` → `result.output`; a schema mismatch throws (`NoObjectGeneratedError`). Mock models for tests: `MockLanguageModelV4` from `ai/test`, with V4 results shaped `{ content, finishReason: { unified, raw }, usage: { inputTokens: {…}, outputTokens: {…} }, warnings }`.

## 13. Query rewriting (Phase 8)

- **Expanding every question hurts.** Rewrites of clear questions pull in near-misses: recall@8 fell from 87% to 84%. The rewriter now returns an empty list unless the question is ambiguous or multi-part ([ADR-0009](./adr/0009-query-rewriting.md)).
- **Filenames aren't enough context.** Given only `nist-csf-2.0.pdf`, `raptor.pdf` …, gpt-oss wrote "which function" queries for the RAG papers. A catalog line with the start of each document's first page fixed it (`server/rag/catalog.ts`). The topmost page-1 chunk is the one with the largest `highlight.rects` y (PDF space has a bottom-left origin).
- **Cache instructions, not just prompts.** The eval caches (`scripts/lib/task-cache.ts`) first keyed on the user prompt only, so changing the system instructions silently reused stale results. Entries now store an instructions hash (mandatory: rerank entries from before it count as `LEGACY_RERANK_HASH`) and a `RESULT_VERSIONS` version for the post-processing, and a mismatch in either is a miss.
- **Gemini Flash-Lite's free quota runs out** within a day of eval runs ("You exceeded your current quota"). It was the answer fallback until 2026-11 (ADR-0005 note).

## 14. Evals harness (Phase 9)

- **promptfoo passes the provider's `metadata` to assertions and to `contextTransform`** (`context.metadata`, checked in 0.124.1's source), so retrieved sources can flow from a custom provider to graders without changing `output`. JS assertions get it as `context.metadata` (shortcut for `providerResponse.metadata`).
- **promptfoo loads `.env` from the working directory itself** and loads `file://*.ts` providers and assertions directly; imports resolve from the project's `node_modules` even when promptfoo itself runs via `pnpm dlx`.
- **Disable promptfoo's own cache** (`--no-cache`) for a custom pipeline provider: it keys on the prompt (the question), so it would hide retrieval changes. `scripts/lib/cached-model.ts` caches model calls instead (`wrapLanguageModel` middleware), keyed on the full request.
- **`actions/cache` saves only on success**; use `actions/cache/restore` + `actions/cache/save` with `if: always()` to keep a partial cache from a run that stopped on a spent quota. And `run: a | tee b` hides `a`'s exit code unless the step sets `shell: bash` (which adds `-o pipefail`).
- **`node --env-file` fails when the file is missing**; scripts that also run in CI use `--env-file-if-exists`.
- **qwen3.8-27b produced valid structured output as a judge** in the smoke test, unlike as a reranker (§12); confirm over a full run.

## 15. Tracing (Phase 10)

- **Setup:** `server/plugins/tracing.ts` registers a `NodeTracerProvider` with Langfuse's `LangfuseSpanProcessor` and `registerTelemetry(new LangfuseVercelAiSdkIntegration())`. AI SDK 7 then traces every call by default (telemetry is opt-out; v6's `experimental_telemetry: { isEnabled: true }` is gone). Off unless `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` are set; without a provider, `@langfuse/tracing` calls are no-ops, so tests and evals run untraced.
- **One trace per chat request:** an `agent` root (`chat`) opened with `startActiveObservation(..., { endOnExit: false })` and ended once by whichever comes first of `streamText`'s `onFinish`/`onAbort`, the stream's `onError`, or the no-sources refusal. Nested: a `retriever` (`retrieve`) with `chain` steps `rewrite` and `rerank`, and the AI SDK's own embedding and generation observations (tokens per call). Root metadata: `ttftMs`, `retrievalMs`, `totalMs`, rewrites, reranked, models.
- **Fallbacks are visible:** a failed rewrite or rerank marks its step `WARNING` with the error; the failing generation shows as `ERROR` with the provider's message (e.g. Groq's tokens-per-minute 429).
- **First measured TTFT (dev server, 5 requests):** 1.35–1.6 s for specific questions (no rewrites), 2.2–2.9 s when the question is rewritten (the rewrites are embedded and searched after the rewrite call returns). SPEC's < 2 s p50 depends on how many real questions get rewritten; measure on production traffic with `pnpm sample:traces`. The rewriter on gpt-oss-20b rewrote "What does PR.DS-11 require?", which names an identifier and should be skipped.
- **Langfuse's v1 read API (`GET /api/public/traces`) is deprecated on Cloud and removed on 2026-11-16**; read data with `GET /api/public/v2/observations` (filters `name`, `type`, `fromStartTime`; `fields=core,basic,io,metadata`; cursor pagination). The SDK stores observation input/output as JSON strings.
- **Hobby's 30-day window hides records without deleting them.** Reads return nothing older, so traces must be deleted before then: `server/utils/trace-retention.ts` does it daily at 26 days, within Hobby's 50 delete requests a day. It uses `DELETE /api/public/traces`, which answered on 2026-11-04 on an organization already refused the v1 reads; Langfuse's migration notes don't say it is exempt from the 2026-11-16 removal, so recheck it after that date.
- **Serverless (Phase 14, ADR-0011):** on node-server, spans export in batches and flush on Nitro's `close` hook. On Vercel that hook never runs and an instance can be frozen once its response ends. With `VERCEL=1` the processor uses `exportMode: 'immediate'`, and a `request` hook hands Vercel's `waitUntil` a promise. The promise waits for the response to close, then one event-loop turn, so ingest's root observation, which ends just after its stream, is included, and then `forceFlush()`. Nitro 2's vercel runtime leaves `event.context.waitUntil` unset, so `event.waitUntil` alone would do nothing there. `server/plugins/platform.ts` wires it up for Nitro's own users, such as the SWR cache. Checked locally by booting the built function with a fake request context and a local OTLP sink: the ingest span arrived inside the `waitUntil` promise, after the response.
- **Privacy:** questions and answers are sent to Langfuse (EU region here). Fine for the public demo's documents; Phase 11 uploads should reconsider `mask` or `recordInputs/recordOutputs: false`.
- **Dashboards:** Langfuse's built-in dashboard covers latency and cost per model and trace volume. For TTFT, filter `chat` observations on metadata `ttftMs`; for fallback rates, count `rerank`/`rewrite` observations at level `WARNING`.

## 16. Abuse protection (Phase 11)

- **Daily caps live in Postgres** (`consume_quotas`, [ADR-0010](./adr/0010-abuse-protection.md)): all counters for a request are locked in a fixed order and incremented together or not at all. A `plpgsql` loop with `select … for update` per row, after an `insert … on conflict do nothing` that makes sure the rows exist; a single `insert … on conflict do update … where count < limit` can't express "all or none" across rows.
- **h3 isn't resolvable from the unit test project** (pnpm doesn't hoist it), so tests of server utils that use Nitro's auto-imported helpers stub them with `vi.stubGlobal` (`test/unit/quota.test.ts`).
- **h3's typed `setResponseHeader` wants a number for `Retry-After`**, not a string.
- **The chat UI reads a 429 body**: `DefaultChatTransport` puts the response text in `error.message`, so the page parses it as JSON and shows `message` when `data.quota` is set.

## 17. Post-Phase-11 review (2026-10-20)

- **Interactive calls have deadlines.** Chat generation uses `streamText`'s `timeout: { totalMs: 45000, chunkMs: 15000 }`. A timeout fires `onAbort`, not `onError`, so the route checks its client abort signal to tell a disconnect from a timeout. Truncation (`finishReason: 'length'` at the 700-token cap) and timeouts reach the UI as a final `error` part, written in a `TransformStream` `flush`. `geminiEmbedder` takes optional `{ maxRetries, timeoutMs }`: the chat and search routes use `INTERACTIVE_EMBED_LIMITS` (1 retry, 8 s), ingestion and scripts keep 5 retries. `/api/search` answers 504 when the embed or database call times out. The server Supabase client caps PostgREST/RPC requests at 15 s (`server/utils/supabase.ts`); Storage uploads aren't capped.
- **Prompt changes miss the answer cache.** Grounding rule 2 and `buildPrompt`'s source text (`⟦n⟧` for a document's own reference numbers, [ADR-0005](./adr/0005-citations-and-grounding.md)) changed, so the next `eval:answers` or `eval:llm` run re-generates every answer.
- **Rate limiting keys on the trusted IP.** `server/plugins/client-ip.ts` sets the internal `x-truthbase-client-ip` header on every request from `NUXT_TRUSTED_IP_HEADER` (last hop for `x-forwarded-for`), and nuxt-security's limiter keys on it with an `lruCache` store of 10,000 entries. A client-sent `X-Forwarded-For` no longer affects it. Both layers normalise the IP: IPv4-mapped IPv6 counts as IPv4, IPv6 is grouped per /64. `clientIp` logs once when the configured header is missing, or in production when no header is set and the socket address is private (CGNAT 100.64.0.0/10 included).
- **A bad `NUXT_QUOTA_*` closes the route.** A value that isn't a whole int32 gives that route limit 0 with a one-time startup warning, instead of becoming unlimited.
- **Signed PDF URLs last 12 min** (was 15). The TTL must stay above the viewer's `MAX_AGE_MS` (10 min).
- **Upstream error text stays in the server log.** The chunk and document routes return generic 502 messages. Ingest SSE `error` events always carry a `stage` and a per-stage message ("The PDF could not be read.", "Embedding the document failed.", "Saving the document failed.", "Password-protected PDFs are not supported."); the raw error goes to the trace's `statusMessage` and the console.
- **Page text drops control characters** (e.g. U+0000 from fonts without a usable ToUnicode map), since Postgres `text` rejects NUL. The sentence splitter also ends sentences at CJK `。！？` with no space after them; chunks of the Latin golden corpus are byte-identical.
- **`ingest:golden --replace` ingests the new copy before deleting the old ones**, and Ctrl+C cancels and rolls back the current PDF.
- **Viewer:** `PdfPage` cancels in-flight renders on zoom or scroll-away and calls `PDFPageProxy.cleanup()` on release; `renderPage` takes an `AbortSignal`. The text layer is rotated for `/Rotate` pages with pdf_viewer.css's `data-main-rotation` rules, and the fallback line grouping (`textLayerLines`) runs in PDF space.
- **Evals:**
  - `eval:llm` sets `PROMPTFOO_PASS_RATE_THRESHOLD=0`: promptfoo exits 0 whether assertions fail or rows error, and `eval:llm:summary` is the one gate (it fails errored rows). Only a crash or a spent quota (exit 2) stops `&&` before the summary.
  - `eval:llm:summary --update-baseline` ignores the existing `llm-baseline.json`, so the 0.05 tolerance doesn't apply; it writes only an error-free run of the full golden set that meets the SPEC targets.
  - The retrieval gate's nDCG@5 ideal is every relevant chunk in the database searched (under `--install`, the fixture corpus): all-documents nDCG@5 0.638 → 0.633, filtered unchanged at 0.627; recall and MRR unchanged. The gate also fails on a changed record count, baseline records missing from the run, or a NaN or empty scope, so removing golden records needs `--update-baseline` in the same PR.
  - Query embeddings were cached in `.cache/query-embeddings/<model>-RETRIEVAL_QUERY-<dims>.json`, with `.cache/golden-query-embeddings.json` as a read-only fallback for `gemini-embedding-001` at 768 dims. Since 2026-11-04 the file is `.cache/query-embeddings/bge-m3-1024.json`, with no fallback (§21).
  - Pacing is per model id across all caches in a process. promptfoo's answer cache stores answers under their model ids, and promptfoo runs on Groq alone.
  - `GOLDEN_ONLY` ignores empty ids and fails on unknown ones.
- **Keep-alive** is a daily Vercel cron since 2026-10-25 (ADR-0011 §7), so GitHub's 60-day inactivity rule for scheduled workflows no longer applies to it.

## 18. UI polish and accessibility (Phase 12)

- **Compression:** *(Phase 14: on Vercel the build skips `compressPublicAssets` and the plugin compresses only HTML, because the CDN compresses JSON, JS, CSS and WASM itself but not `text/html`; ADR-0011.)* The node-server preset sends SSR HTML and API JSON uncompressed. `nitro.compressPublicAssets` prebuilds `.br`/`.gz` for `/_nuxt` and `/pdfjs`, and `server/plugins/compression.ts` compresses finished HTML and JSON bodies in Nitro's `beforeResponse` hook (after nuxt-security's headers and CSP): brotli quality 5, else gzip 6, `Vary: Accept-Encoding`, nothing under 1 KiB. Streams (the chat SSE), binary bodies and anything already encoded pass through. This was most of the mobile gain (FCP 6.6 → 1.05 s); `pnpm build && node .output/...` is the only way to measure it, `pnpm dev` doesn't compress.
- **Less JavaScript on first paint:** `ai` (and the zod it validates the stream with, about a third of the page JS) loads once the page is idle through `useLazyChat`, and PDF.js loads when the viewer first opens a document or a chip is hovered or focused. `build:manifest` keeps both out of preloads, and `server/plugins/preload-priority.ts` marks the remaining module preloads `fetchpriority="low"` so they don't compete with the CSS. The client imports `MAX_QUESTION_LENGTH` from `shared/limits.ts`, not the zod schemas. `ui.experimental.componentDetection` halves the entry CSS.
- **zod's JIT probe broke Best practices:** zod 4 runs `new Function("")` once to see if it may compile validators, which the CSP reports as an eval violation. `app/plugins/zod-jitless.client.ts` sets `config({ jitless: true })` at import time, because the router plugin loads the page chunk (and `ai`) before plugins run.
- **Colour tokens:** Nuxt UI maps `primary`/`info`/`error`/`warning` to shade 500 in light mode, and white on blue-500 is 3.8:1. `main.css` overrides `--ui-primary` etc. unlayered (700, or 800 for warning, in light; 400, or 300 for error, in dark), so `.dark` has to restate them. `app.config.ts` changes two hover states that dropped below 4.5:1: solid primary hovers to `primary/90` instead of `/75`, and the outline error button (Retry inside a subtle error alert) hovers to `error/5`. The highlight outline is a solid `#a16207` 2 px `outline` (4.9:1 on the white page) and only the tint on `::before` uses `multiply`, so the outline is not blended.
- **Focus ring:** Nuxt UI's default is a 25% primary outline (about 1.4:1). One unlayered `:focus-visible` rule in `main.css` gives every focusable element a solid 2 px primary outline at 2 px offset, at least 5.5:1 against the page and the chip fill; on solid primary fills the offset gap carries the contrast. `--focus-ring-offset: -2px` pulls it inside where it would be clipped, the default for `[role="region"][tabindex]` (the PDF scroller). Focus moved there from code doesn't match `:focus-visible`, so the viewer sets `data-focus-ring` to show the ring after a chip opens a citation.
- **Viewer API:** `PdfViewer` exposes `focus()` (the scroller, with the ring), `scale`, `status` and `documentId`, and emits `select-document`, `prev`, `next`, `close` and `update:zoom`. Its live region is cleared before each message so a repeated "Page 28, Citation 1 of 3" is announced again, and it announces the target only once the page is ready, never over a load error ("Couldn't load <file>. Retry available."). Zoom buttons at a limit stay enabled with `aria-disabled`, so they keep focus.
- **Keyboard flow:** `/` is a window `keydown` listener that skips text fields, listboxes, comboboxes and menus. Ask turns into Stop rather than unmounting, and sending (Ask, an example, Retry) moves focus to the question box, so focus never drops to `<body>` when a button disappears. `[` / `]` move `returnFocusTo` to the chip of the citation now shown, so Esc returns there. On phones the viewer is a `USlideover` (Reka UI focus trap); its `onCloseAutoFocus` is overridden when focus should go somewhere other than the opener (`/`, or a chip removed meanwhile).
- **Server latency for the viewer:** `GET /api/documents` is a `defineCachedEventHandler` (5 min, SWR, one fixed key) because SSR awaits it, and the file route memoises each document's `storage_path` per process, so signing a URL is one Supabase round trip. Signed URLs themselves are never shared across clients.
- **Running headers in highlights:** chunks include the page's running header and footer lines (ingestion keeps them). `dropRunningMargins` drops overlay boxes whose centre is in the top or bottom 7.5% of the page, unless that would drop all of them. The chunk text and tooltips still contain them; stripping them at ingestion is deferred (WIREFRAMES implementation status).
- **Measuring:** `pnpm lighthouse` (scripts/lighthouse.mjs) pins Lighthouse 13.5.0 and needs chrome-headless-shell: Chrome for Testing in headless mode gives `NO_FCP`. Results are in the README's Quality section. Against a local server, send a different `x-audit-ip` per run and start the server with `NUXT_TRUSTED_IP_HEADER=x-audit-ip`, or repeated runs hit the per-minute limiter.

## 19. Testing (Phase 13)

- **Running:** `pnpm test` runs Vitest (the `unit` project in Node, the `nuxt` project in the Nuxt environment). `pnpm test:e2e:build` builds and runs Playwright; `pnpm test:e2e` alone tests whatever `.output` holds, so rebuild after changing app code. `CI=1` gives CI's settings (2 workers, 1 retry, HTML report in `playwright-report/`). `E2E_FULL=1` runs every golden question on the phone project too. Install the browser once per machine with `pnpm exec playwright install chromium` (CI adds `--with-deps`).
- **Hermetic by design** ([ADR-0012](./adr/0012-hermetic-e2e.md)): the browser's `/api/*` is answered from fixtures by `page.route` (`test/e2e/fixtures.ts`), and the server's Supabase calls go to `test/e2e/supabase-stub.ts`. The stub's Storage path serves the golden PDFs with Range, 206/416 and CORS. Its `stall` option sends 64 KB of the full download and then stops, which forces PDF.js to load by range. A request that neither handles fails the test (the stub lists them at `GET /__unexpected`). No keys, no network.
- **Ports:** 3100 (app) and 3101 (stub), overridable with `E2E_PORT` / `E2E_STUB_PORT`. Neither server is reused: if a port is taken, Playwright refuses to start instead of testing an old build.
- **Highlight assertion** (`test/e2e/app.ts`): boxes within 0.5 px of an independent PDF → CSS conversion of the stored rects, plus `check:viewer`'s vertical ink coverage. That runs only at an integer DPR (desktop, DPR 2), because at the Pixel 7's 2.625 anti-aliasing keeps correct lines near 0.96. It requires ink under every line and at least 90% of lines at the threshold, not every line: Self-RAG's vector-framed "Critique" (0.95 at 200%) and sub-pixel subscripts at 50% fall short on lines that are placed correctly.
- **Fixtures:** `test/fixtures/highlight-spans.json` (`pnpm fixtures:highlights`) holds the stored rects; `test/fixtures/e2e/chunks.json` (`pnpm fixtures:e2e`) the chunk texts the viewer checks against the page before trusting the rects. Regenerate both after re-ingesting or changing chunking. `chat-g020.sse` is a real `/api/chat` response replayed byte for byte; re-record it if the AI SDK's stream format changes.
- **Vitest:** the unit project resolves `#shared` like Nuxt (`vitest.config.ts`). Running `tsc -p tsconfig.scripts.json` typechecks test/unit and test/e2e. `vite/client` isn't resolvable from the root under pnpm, so `test/unit/vite-url.d.ts` declares `?url` imports.
- **Fixed in PR #10 (was `test.fixme`):** on phones, closing the sheet returned focus to the chip and its tooltip opened over the next chip. Chip tooltips are now off on touch screens; `closeSheet` (`test/e2e/app.ts`) asserts no tooltip is open after closing, and the `fixme` and the Escape workaround are gone.

## 20. Deployment on Vercel (Phase 14)

- **Preset:** Nitro picks `vercel` when `VERCEL=1` at build time; `pnpm build:vercel` (`NITRO_PRESET=vercel`) does the same locally. `.vercel/output` is git-ignored, and `vercel link` state also lives in `.vercel/`. `nitro.vercel.functions` is spread into `functions/__fallback.func/.vc-config.json`, and every route is a symlink to that one function, so per-route `maxDuration` isn't possible in nitropack 2: `functionRules` is Nitro 3 only.
- **Node version:** nitropack 2.13.4's vercel preset hard-codes `SUPPORTED_NODE_VERSIONS = [18, 20, 22]`, so a Node 24 build writes `nodejs22.x` unless `vercel.functions.runtime` is set. It is set to `nodejs24.x`, and `pnpm check:vercel` asserts it.
- **Supabase region:** the project URL doesn't encode a region. `db.<ref>.supabase.co` resolves to an IPv6 address inside AWS's published eu-west-1 ranges (ip-ranges.json), which is why the function runs in `dub1`.
- **`waitUntil` without `@vercel/functions`:** the package's `waitUntil` is `globalThis[Symbol.for('@vercel/request-context')].get().waitUntil`. Adding the package pulled in `@vercel/oidc` → `@vercel/cli-exec` (execa) and `jose`, and changed the peer resolution of nitropack and unstorage across the lockfile, so `server/utils/platform.ts` does the same lookup itself (unit-tested).
- **Client IP:** Vercel overwrites `X-Forwarded-For`. `x-vercel-forwarded-for` is the same address and survives a proxy in front. `trustedIpHeader()` defaults to it on Vercel. Nitro's local fetches during SSR (the documents listing) have no socket address. They forward the visitor's headers, so on Vercel the listing counts for the visitor through `x-vercel-forwarded-for`. Without a trusted header to read, `clientIp()` names them `internal` without warning, and the in-memory limiter skips that key (`whiteList`). Before this, every SSR page shared one bucket with key `''` and logged a misleading "header missing" warning.
- **Body limit:** Vercel rejects request bodies over 4.5 MB with `413 FUNCTION_PAYLOAD_TOO_LARGE` before the function runs. `/api/ingest` returns its own 413 for a declared length over 4,500,000 bytes on Vercel (`uploadLimit()`). Ingestion is meant to stay off there anyway.
- **Cancellation:** `supportsCancellation: true` goes into `.vc-config.json`. `@vercel/build-utils`' `Lambda` accepts the key, but Vercel documents it only in `vercel.json`, which a Build Output API deployment can't use for `functions`. Check on the first preview whether Stop reaches `res.on('close')`.
- **Local function smoke:** `pnpm check:vercel` imports `__fallback.func/index.mjs` (a plain `(req, res)` listener) behind `node:http`, injects `x-vercel-forwarded-for`, and runs the CI smoke assertions. It can't reproduce the CDN (compression, static header routes) or the platform's `waitUntil` and cancellation; DEPLOYMENT.md §3 checks those on a real deployment.

## 21. bge-m3 on Cloudflare (2026-11-04)

Why, the measurements and the alternatives are in [ADR-0013](./adr/0013-leaving-gemini.md). What changes for anyone reading the code:

- **Model:** `@cf/baai/bge-m3`, 1024 dims, through `@ai-sdk/openai-compatible` at `https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1` (`server/ingest/embed.ts`). Vectors are still L2-normalized before they are stored or searched.
- **No task types.** bge-m3 has no document and query modes, so `RETRIEVAL_DOCUMENT` and `RETRIEVAL_QUERY` are gone. The difference is in the text: documents are embedded as `title\n\ncontent` (`server/ingest/title.ts`), and questions are embedded bare. The title is not stored in `chunks.content`.
- **Column and function:** `chunks.embedding_bge_m3` and `hybrid_search_bge_m3`, which is `hybrid_search` v2 with only the column and vector size changed. `chunks.embedding` and `hybrid_search` stay for a 7-day soak, then go with `NUXT_GEMINI_API_KEY` and `@ai-sdk/google`.
- **Cloudflare is required:** chat, search and ingest answer 503 without `NUXT_CLOUDFLARE_ACCOUNT_ID` and `NUXT_CLOUDFLARE_API_TOKEN`. On the free plan a request over the 10,000 Neurons a day fails rather than bills.
- **`RERANK_CANDIDATES` is 20,** was 15: about 4.2K reranker tokens per chat against 3.1K.
- **`/api/search` errors:** 503 "busy" on provider limits (`isFallbackError`), 502 otherwise. The cause goes to the log only.
- **Eval cache:** query embeddings are in `.cache/query-embeddings/bge-m3-1024.json`. `pnpm eval:retrieval` compares against the new baseline; Gemini's is kept in `docs/evals/retrieval-baseline-gemini.json`.
- **Older sections:** §2, the `google.embedding` line in §7 and the Gemini numbers elsewhere in these notes describe the project before this date.

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
- Default CSP (per-request nonces in SSR, meta-tag hashes for static), COEP `credentialless`, and `X-Frame-Options: SAMEORIGIN` can break embeds/third-party scripts — and the PDF.js worker may need CSP tuning in Phase 5. Test headers in the real deployment target, not just `nuxt dev`.
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
  - Import `pdfjs-dist` lazily on the client only (`import('pdfjs-dist')`); in Node it warns and needs canvas.
  - Worker: `import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'` → `GlobalWorkerOptions.workerSrc`. Same-origin, so no blob: wrapper.
  - Release documents with `loadingTask.destroy()`; there's no `PDFDocumentProxy#destroy`.
  - `getDocument({ data })` detaches the caller's buffer.
- **CSP:** nuxt-security's default `script-src` has `'strict-dynamic'` and no `worker-src`. Add `worker-src 'self' blob:` per route. Route-rule arrays *replace* a directive's defaults, so never override `script-src`. A blocked worker silently falls back to a main-thread "fake worker" that is sticky for the page, so check for it.
- **Text layer:**
  - Needs the `.textLayer` CSS (copied in `app/assets/css/pdf-text-layer.css`) and the `--scale-factor` / `--total-scale-factor` / `--scale-round-x/y` variables on the page wrapper. Without them it lays out at the wrong size with no error.
  - It is **not** glyph truth: spans use a substitute font (sans-serif or monospace) scaled to each item's width, and its vertical box is that font's em box rounded to whole CSS px.
- **Supabase Storage signed URLs** answer `Access-Control-Allow-Origin: *`, allow the `Range` header in preflight and serve `206`. `Accept-Ranges` isn't readable cross-origin, so PDF.js downloads the whole file instead of using ranges (fine at 1–2.5 MB). An invalid or expired token returns `400`, which PDF.js reports as `ResponseException`; re-fetch `/api/documents/:id/file` and reload.
- **Exact glyph positions** come from replaying `page.getOperatorList()` (`server/ingest/glyphs.ts`). It needs `getDocumentProxy(data, { fontExtraProperties: true })` for `fontMatrix`/`vertical`.
- **Modern-build requirement:** `pdfjs-dist`'s modern build uses `Map.prototype.getOrInsertComputed`, `Math.sumPrecise` and `URL.parse` unpolyfilled. They're fine in Chromium 149; if older browsers matter, switch both imports to `pdfjs-dist/legacy/build/`.

## 9. Generation models (Phase 4)

- **`gemini-2.5-flash-lite` is closed to new API users** (the API answers "no longer available to new users … use models/gemini-3.5-flash-lite"), even though it still shows in `models.list`. The Gemini fallback is therefore `gemini-3.5-flash-lite` (`server/rag/model.ts`). Verify a model with a real call, not just the listing.
- AI SDK v7 server pattern as used in `server/api/chat.post.ts`: `createUIMessageStream({ execute: ({ writer }) => { writer.write({ type: 'data-sources', data }); writer.merge(toUIMessageStream({ stream: streamText(...).stream })) } })` → `createUIMessageStreamResponse({ stream })`. `streamText` takes `instructions` (not `system`) and `maxOutputTokens`.
- Custom data parts need the message type's data map to be a **type alias**, not an interface, so it satisfies `UIMessage`'s `Record<string, unknown>` constraint (`shared/types/chat.ts`). Narrow parts with a type guard; `Array.find` doesn't narrow unions.
- nuxt-security's `xssValidator` rejects bodies containing `<`/`>`; it's disabled on `/api/chat`, because questions are treated as data and never rendered as HTML.

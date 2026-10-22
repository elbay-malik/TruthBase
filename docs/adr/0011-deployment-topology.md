# ADR-0011: Deployment topology

- **Status:** Accepted. Live since 2026-10-21 at https://truthbase-brown.vercel.app (ROADMAP Phase 14).
- **Date:** 2026-10-20

## Context

Phase 14 puts the demo on a public URL. SPEC's budget was "under 5 EUR/month". ADR-0001 left two Cloudflare options open: Workers Paid ($5/month) for the whole app, or free Workers plus a Node host for ingestion.

What the app needs from a host:

- **Node.js APIs, a real runtime.** The server uses `node:crypto`, `node:zlib`, `node:net`, PDF.js for server-side extraction (with its CMaps bundled as Nitro server assets), the Supabase client and AI SDK 7 with Langfuse's OpenTelemetry exporter.
- **Long streaming responses.** A chat answer streams for up to 45 s of generation after retrieval (`server/api/chat.post.ts`).
- **Little CPU per request but real wall time.** Most of a request is waiting on Groq, Gemini and Supabase. The binding cost is the free model quotas, which ADR-0010 already caps in Postgres.
- **Zero or near-zero cost, no card on file** for a personal, non-commercial portfolio project.
- **A low-latency path to the database.** The Supabase project runs in AWS eu-west-1 (Ireland), and each chat makes several round trips: `consume_quotas`, `hybrid_search` (once per rewrite), and the catalog and title lookups.

Ingestion (PDF parse, chunk, embed and store) is operator-only (ADR-0010). The corpus is the four golden PDFs, seeded once with `pnpm ingest:golden`.

## Decision

**Vercel Hobby. The whole Nuxt app runs as one Vercel Function (Fluid compute, Node.js 24) in `dub1` (Dublin, next to Supabase eu-west-1), with static assets on Vercel's CDN. Ingestion stays off the deployment.**

1. **Build.** Nitro selects its `vercel` preset when it builds on Vercel (`VERCEL=1`), or with `NITRO_PRESET=vercel` (`pnpm build:vercel`). The output is `.vercel/output` (Build Output API v3): `static/` for `/_nuxt`, `/pdfjs`, the corpus PDFs at `/pdfs` (added 2026-10-22, ADR-0010) and `favicon.ico`, plus one function, `__fallback.func`, that every route maps to. `nitro.vercel.functions` in `nuxt.config.ts` writes its `.vc-config.json`:
   - `runtime: nodejs24.x`. Nitro 2 would write `nodejs22.x`, because its list stops at 22, and CI tests on 24.
   - `regions: ['dub1']`.
   - `maxDuration: 150`, above the chat route's worst case so that its own timeouts fire first and the stream ends with a message rather than being cut off: the quota RPC (15 s cap), the question's embedding (8 s) and search (15 s), with the catalog lookup and 3 s rewrite alongside, the rewrites' embeddings (8 s) and searches (15 s), the title lookup (15 s), the rerank (4 s) and 45 s of generation, 125 s in all.
   - `supportsCancellation: true`.
   - Nitro adds `supportsResponseStreaming: true` itself.

   `vercel.json` only sets the install command (`corepack pnpm install --frozen-lockfile`), so Vercel installs with pnpm 11.28.5 from `packageManager` rather than the pnpm 9/10 it infers from `lockfileVersion: 9.0`. The node-server build (`pnpm build`) is unchanged and remains what CI's smoke test, E2E and local runs use.
2. **Burst limits move into Postgres.** On serverless, the in-memory limiter only counts within one instance and resets on every cold start. Migration `20261021120000_burst_quota.sql` extends `consume_quotas` with per-counter windows. Each chat or search request now consumes its client's per-minute counter (10 chats, 30 searches), its client's daily counter and the demo's global daily counter in one call, all or nothing. A per-minute 429 keeps ADR-0010's wording ("wait a minute", `Retry-After` up to the next clock minute, no `data.quota`), so the UI keeps its Retry button. nuxt-security's in-memory limiter stays in front as a cheap per-instance first line, at twice these limits (20 and 60): at the same count it answered first in production with a bare 429 without `Retry-After`.
3. **Client IP.** `NUXT_TRUSTED_IP_HEADER=x-vercel-forwarded-for`. On Vercel it is also the default when the variable is unset (`server/utils/platform.ts`), so a forgotten setting can't put every visitor into one bucket. Vercel overwrites `X-Forwarded-For` and does not forward client-supplied values, to prevent spoofing. `x-vercel-forwarded-for` carries the same address and is kept even if another proxy is ever put in front ([request headers](https://vercel.com/docs/headers/request-headers)). The function's socket address is Vercel's proxy, never the client. A trusted-header value that isn't an IP address is ignored (`clientIp()` falls back to the socket and warns once), so no header can produce the `internal` key that the in-memory limiter exempts for the server's own SSR fetches.
4. **Tracing survives the freeze.** Nitro's `close` hook never runs on Vercel, and an instance can be frozen as soon as its response ends. With `VERCEL=1`, `server/plugins/tracing.ts` exports each span as soon as it ends (`exportMode: 'immediate'`, which Langfuse recommends for serverless). For every request it also registers a promise with Vercel's `waitUntil`. The promise resolves when the response has closed and `forceFlush()` has finished, so the stream itself isn't delayed. Nitro 2's vercel runtime doesn't wire `event.waitUntil` to the platform. `server/plugins/platform.ts` does, which also covers the SWR refresh of `/api/documents`. `waitUntil` is read through Vercel's request-context symbol, the same lookup `@vercel/functions` does, without adding that package's dependency tree.
5. **Ingestion runs from the operator's machine.** `NUXT_INGEST_TOKEN` is not set on Vercel, so `/api/ingest` answers 503 (smoke-tested in CI). The corpus is ingested with `pnpm ingest:golden` against the hosted Supabase project, using the same pipeline as the route. If ingestion is ever enabled on Vercel, the route answers declared uploads over 4.5 MB with its own 413 that names the limit and points to the CLI. The platform would reject them anyway with `FUNCTION_PAYLOAD_TOO_LARGE`. Phase 11b's uploads will have to go straight to Supabase Storage with a signed upload URL, not through the function body.
6. **Compression.** Vercel's CDN compresses JSON, JS, CSS, WASM, SVG and fonts itself but not `text/html` ([CDN compression](https://vercel.com/docs/how-vercel-cdn-works/compression)), and it serves `static/` as is. On Vercel the build therefore skips `compressPublicAssets`, since the `.br`/`.gz` sidecars would be unused, and `server/plugins/compression.ts` compresses only SSR HTML. node-server keeps both.
7. **Keep-alive stays on GitHub Actions** (`.github/workflows/keep-alive.yml`). It pings Supabase directly and doesn't depend on the host. Setting the optional repo variable `DEPLOY_URL` adds a `/api/health` check of the deployment.
8. **The deploy runbook is [docs/DEPLOYMENT.md](../DEPLOYMENT.md).** CI job `build-vercel` builds the vercel preset and runs `pnpm check:vercel` without secrets or a Vercel account. It checks the function config, the static PDF.js files, the bundled server assets, and the function booted the way Vercel's Node launcher calls it.

## Rationale

- **Free, and enough for the workload.** Hobby costs nothing and needs no card. Its function limits fit a chat demo bounded to 80 answers a day (ADR-0010): 300 s maximum duration, 2 GB / 1 vCPU, and streaming by default. Monthly allotments are 1M invocations, 4 Active CPU-hours, 360 GB-hours of provisioned memory and 100 GB of Fast Data Transfer. Active CPU only counts while code runs, not while it awaits Groq. Sources: [function limits](https://vercel.com/docs/functions/limitations), [Hobby plan](https://vercel.com/docs/plans/hobby).
- **A real Node runtime.** The same server code, PDF.js server assets included, runs unchanged. Workers' `workerd` runtime would need the server audited for Node compatibility and limits (ADR-0004 had flagged `getOperatorList` cost "in the Workers runtime").
- **One region next to the database.** Hobby allows one function region ([regions](https://vercel.com/docs/functions/configuring-functions/region)). `dub1` maps to AWS eu-west-1 ([region list](https://vercel.com/docs/regions)), where the Supabase project's database resolves. The default `iad1` would add a transatlantic round trip to every RPC.
- **Postgres for burst limits, not the Vercel WAF.** Hobby's single WAF rate-limit rule ([rate limiting](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting)) keeps counters per region and lives in the dashboard, outside review and CI. The `consume_quotas` call already happens on every chat and search, so adding the minute window costs no extra round trip, and the limit is exact across instances. A fixed window still lets a client send up to twice the limit across a minute boundary, which is fine for a burst guard.
- **Non-commercial use only.** Hobby is for personal, non-commercial projects. "Commercial" means financial gain for anyone involved: payments, ads, promoting a product or service, or being paid to build or host it. Asking for donations doesn't count ([fair use](https://vercel.com/docs/limits/fair-use-guidelines#commercial-usage)). A portfolio demo with no ads, payments or client work qualifies. The repo is owned by a personal GitHub account, which Hobby requires for Git imports.

## Rejected alternatives

- **Cloudflare Workers Paid ($5/month, whole app):** the most robust edge option, with up to 5 min of CPU and no bandwidth bill. But it needs a card and a recurring charge for a demo that spends almost no CPU, and it means running PDF.js and the OpenTelemetry exporter in `workerd` instead of Node.
- **Cloudflare Workers free plus a Node ingestion host:** 10 ms of CPU per invocation is tight even without ingestion (SSR render, brotli, JSON parsing of rerank output), and the topology needs two deploy targets and two sets of secrets.
- **Google Cloud Run:** a real container with a generous free tier, but it needs a billing account (card), a container build and an image registry: more moving parts and a card on file for no gain over a function.
- **Render free web service:** spins down after 15 minutes idle, and the cold start takes about a minute: a reviewer clicking the link would wait or time out.
- **Hugging Face Spaces:** a Docker Space works, but it sleeps when idle, is aimed at ML demos rather than web apps, and offers no region choice or custom-domain story.
- **Oracle Cloud Always Free VM:** always on and free, but a VM to patch, TLS and a reverse proxy to run, and a card for sign-up. Too much operations work for a portfolio demo.
- **Vercel WAF rate-limit rule as the only burst limit:** dashboard-only, one rule on Hobby, counters per region. It remains an optional extra layer (DEPLOYMENT.md).

## Consequences

- **Hobby limits to watch** ([Hobby plan](https://vercel.com/docs/plans/hobby), [limits](https://vercel.com/docs/functions/limitations)):
  - Monthly allotments: 1,000,000 invocations, 4 Active CPU-hours, 360 GB-hours of provisioned memory (2 GB per instance), 100 GB Fast Data Transfer, 10 GB Fast Origin Transfer and 1,000,000 CDN requests. Going over a limit generally means waiting until the 30-day window resets, not paying.
  - 100 deployments a day.
  - Runtime logs are kept for 1 hour. Langfuse is the durable record.
  - Request and response bodies are limited to 4.5 MB.
  - At most 300 s per invocation, including streaming time. Ours is capped at 150 s.
- **Per-instance state is a cache, nothing more.** These are kept per instance and refilled after a cold start or a scale-out: the catalog cache (10 min TTL), the file route's map of document filenames and storage paths, the `/api/documents` SWR cache and nuxt-security's limiter. After a re-ingest, other instances can show the old document list for up to their TTL (at most 10 min). Expect more Supabase queries on cold paths.
- **Client disconnects:** `supportsCancellation` is accepted by Vercel's function config (`@vercel/build-utils` reads it), but Vercel documents it only through `vercel.json` and `Request.signal`. Whether a Stop reaches the routes' `res.on('close')` abort has to be checked on the first preview (DEPLOYMENT.md). If it doesn't, generation runs to completion, which is still bounded by the 700-token cap and the 45 s timeout, and the quota unit is already spent.
- **Static assets and headers:** Nitro writes the cache-control routes and nuxt-security's static header route into `config.json`. SSR responses come from the function with the full header set: nonce CSP, `worker-src 'self' blob:`, no COEP. Whether Vercel applies `X-Content-Type-Options: nosniff` to `/_nuxt` files is a preview check. If it doesn't, add a `headers` entry to `vercel.json`.
- **Migrations before code.** The new code calls `consume_quotas` with four arguments. Against a database without the migration that call fails. The routes then answer 503 (ADR-0010 item 5; before its 2026-10-22 amendment they let the requests through unmetered), so apply the migration first. The migration keeps the 3-argument call working, so the old code runs against the new database.
- **Node 24 everywhere:** the function runtime is pinned in `.vc-config.json`. `engines.node` is `24.x`, not `>=24`: Vercel builds with the newest major a `>=` range allows, and Node 25+ no longer bundles the corepack that the install command uses.
- **Revisit** if the project becomes commercial (Pro, $20/month per member), if Active CPU approaches 4 h a month, if Phase 11b needs uploads larger than 4.5 MB through the app, or if Vercel ships cross-region rate limiting worth moving the burst layer to.

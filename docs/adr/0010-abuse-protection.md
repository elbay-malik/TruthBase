# ADR-0010: Abuse protection and demo mode

- **Status:** Accepted
- **Date:** 2026-10-20
- **Amended:** 2026-10-20 (Phase 14, [ADR-0011](./0011-deployment-topology.md)): the per-minute limits on chat and search also moved into Postgres; see the Phase 14 note.
- **Amended:** 2026-10-22 (security audit): the quota check fails closed on configuration errors, and the corpus PDFs are served from the CDN; see the last note.
- **Note (2026-11-04):** Embeddings moved to Cloudflare ([ADR-0013](./0013-leaving-gemini.md)), so "Gemini's free embeddings" below is now Cloudflare's 10,000 Neurons a day. At 20 rerank candidates gpt-oss-20b covers about 40 enhanced chats a day, not ~60.

## Context

TruthBase is a public portfolio demo running on free tiers (ADR-0001). Every question spends quota that can't be bought back that day. Groq allows each model 8K tokens/min, 1K requests/day and 200K tokens/day: gpt-oss-120b, the answer model, covers about 100 answers a day, and gpt-oss-20b, used for rewriting and reranking (ADR-0007, ADR-0009), covers about 60 enhanced chats. Gemini's free embeddings and Langfuse's Hobby plan (50K units/month) have their own limits. One script, or a link going viral, can spend a day's quota in minutes, and then the demo is broken for everyone until midnight.

Before this phase there was only nuxt-security's in-memory per-IP limiter: 150 requests / 5 min overall, 10/min on `/api/chat` and 30/min on `/api/search`. It stops bursts, but it allows 14,400 chats a day per IP, resets on every restart, isn't shared between instances, and trusted `X-Forwarded-For` from any client (TECH_NOTES §11).

Phase 11's acceptance criterion (EXECUTION_PLAN): exceeding the cap returns a clean 429, and the demo workspace works without login. Bring-your-own documents behind Supabase Auth is split into its own phase (11b), with the prompt-injection review SPEC requires before uploads open.

## Decision

1. **Two layers.** nuxt-security's per-minute limiter stays as the burst limit, keyed on the same client IP as the daily caps (item 4; `server/plugins/client-ip.ts` sets it as `rateLimiter.ipHeader`), in an LRU store of 10,000 entries. On top, **daily caps per client and for the whole demo**, enforced before any model call in `/api/chat` and `/api/search` (`server/utils/quota.ts`):

   | Route | Per client / day | Whole demo / day | Why |
   |---|---|---|---|
   | `/api/chat` | 10 | 80 | gpt-oss-120b's 200K tokens/day ≈ 100 answers; 20 left for evals and retries |
   | `/api/search` | 30 | 300 | embeddings only: no rewrite, rerank or answer |

   All four are `NUXT_QUOTA_*` settings; a limit below 1, or a value that isn't a whole number, closes the route (with a warning at startup). The day is UTC.

   Search runs plain hybrid retrieval: gpt-oss-20b's ~60 enhanced requests a day are kept for chat, which a single client's search allowance could otherwise spend for everyone.
2. **Counters in Postgres** (`usage_counters`, migration `20261020120000_usage_quota.sql`). One function, `consume_quotas(scopes[], keys[], limits[])`, locks the counter rows in a fixed order and increments all of them or none, so concurrent requests can't overshoot and a request blocked by the global budget doesn't use up its client's allowance. Rows older than two days are pruned on the way. Server-only: RLS with no policies, execute for `service_role` only.
3. **Over a cap: 429** with `Retry-After` (seconds to midnight UTC) and a message saying which limit was hit, before the response stream opens. The body's `data.quota` (`client` or `global`) lets the UI show that message and drop its Retry button; the per-minute limiter's 429 keeps "wait a minute".
4. **The client is the IP, stored as an HMAC** keyed with the service key (22 characters of base64url), never in clear. The IP is the socket address unless `NUXT_TRUSTED_IP_HEADER` names the header the deployment's proxy sets (`cf-connecting-ip`, `fly-client-ip`, `x-real-ip`, or `x-forwarded-for`, whose last entry is used); otherwise client-sent headers are ignored. IPv6 counts per /64 (one host usually holds a whole /64) and IPv4-mapped addresses as IPv4. The origin must be reachable only through that proxy, or a client can send the header itself; with chained proxies (a CDN in front of the host), use the outermost one's header, since the last `x-forwarded-for` entry is only the nearest proxy. A configured header missing from a request, or no header in production while the socket address is private, is logged once: it means every visitor may be sharing one allowance.
5. **Fail open on an outage only.** If the counter store is unreachable (a network error or timeout) or answers with a 5xx, the request proceeds and the error is logged. A Supabase outage breaks retrieval anyway, and the per-minute limiter still applies. Any other failure (a missing or changed `consume_quotas`, a revoked grant, a rejected key) closes the route with a 503 until it is fixed (amended 2026-10-22).
6. **Demo mode is the default and only mode for now:** the four golden documents, public and read-only, no login. Ingestion stays operator-only (`NUXT_INGEST_TOKEN`). Output length was already capped (700 tokens per answer, 1,000 characters per question).

## Rationale

- **Daily caps match the resource.** Groq's binding limit is per day. A per-minute limit tight enough to protect the daily budget (80 / 1440 min) would make the demo unusable for a normal visitor asking five questions in a row.
- **A global budget, not only per-client.** Per-IP caps don't stop many IPs. The global budget is what guarantees the quota can't run out for the answer model; once it's spent, visitors get a clear message instead of failing generations.
- **Postgres instead of Redis or KV:** it's already there, survives restarts and is shared across instances on any deploy target (a Vercel Function since Phase 14, ADR-0011). One RPC adds about one round trip (~50–150 ms) before retrieval starts, which runs in parallel with nothing else; acceptable against ~1.4 s to first token.
- **All-or-nothing in one call:** two separate counters would let a blocked request use up the other allowance, and two round trips would double the latency.
- **HMAC, not a plain hash:** IPv4 has only 2³² values, so an unkeyed hash is reversible by enumeration.

## Rejected alternatives

- **Mandatory sign-in for the demo:** kills the portfolio use case (a reviewer clicking a link). Auth comes with bring-your-own documents (11b), where it protects data, not quota.
- **CAPTCHA (Turnstile):** adds friction for every visitor to stop a threat the caps already bound. Revisit if the global budget is routinely spent by bots.
- **nuxt-security's rate limiter with a shared storage driver:** still a sliding window, not a calendar-day budget, and it needs a KV store we don't have.
- **Platform rate-limiting rules** (Cloudflare, or Vercel's WAF on the chosen host): depend on the deploy target (ADR-0011), can't see the global budget, and on Vercel Hobby are one dashboard rule with per-region counters.
- **Counting tokens instead of requests:** closer to Groq's metering, but needs the counter after generation (streams can't be refused retroactively). Requests are a good proxy: answers are capped at 700 output tokens and prompts at 8 sources.

## Consequences

- **Deploy:** apply the migration, and set `NUXT_TRUSTED_IP_HEADER` for the host (Phase 14: `x-vercel-forwarded-for`, also the default on Vercel); it keys both layers. Until the migration exists, chat and search answer 503.
- **Shared IPs** (offices, carrier NAT) share one allowance of 10 chats a day. Acceptable for a demo.
- **gpt-oss-20b runs out before the chat budget:** 80 chats a day exceed its ~60 enhanced chats, so late in a busy day chat skips rewriting and reranking and answers from the fused order (ADR-0007, ADR-0009). Answers still work.
- **PDF egress:** the corpus PDFs are static files on the CDN (amended 2026-10-22, see the last note). Any other document gets a 12-minute signed Storage URL that can be fetched again until it expires. Only the per-minute limiter bounds signing, so egress for those documents has no daily cap.
- **The global budget is spent by evals too** only if they go through the routes; they don't (they call the pipeline directly), so the 20 left over is headroom for their direct use of the same Groq quota.
- **Langfuse Hobby (50K units/month)** is bounded too: at ~17–20 observations per traced chat, 80 chats a day is ~45K a month, close to the cap. Sample traces or lower the cap if the demo is busy every day.
- **Revisit** on a paid tier, when 11b adds per-user quotas for signed-in users, or if the shared-IP limit hurts real visitors.

## Phase 14 note: per-minute limits in Postgres

On Vercel (ADR-0011) the app runs as serverless function instances, and each one has its own memory. nuxt-security's in-memory limiter therefore counts per instance and resets on every cold start, so item 1's burst layer no longer held across the deployment. Migration `20261021120000_burst_quota.sql` gives `consume_quotas` an optional `p_windows` array: 86400 is the UTC day, as before, and 1..3600 seconds is a clock-aligned window, counted in `burst_counters`. `/api/chat` and `/api/search` now consume three counters in the same single call: `<route>:minute` (10 and 30 per client and clock minute, `NUXT_QUOTA_*_PER_MINUTE`), `<route>:client` and `<route>:global`, all or nothing. A request blocked by the minute limit uses up no daily allowance, and the reverse holds too.

The semantics above are unchanged. A per-minute block is a 429 with `Retry-After` set to the seconds until the next minute and a "Too many … in a short time. Wait a minute" message. Its `data` has `limit: 'minute'` and no `quota` key, so the UI shows its "wait a minute" alert with Retry, exactly as for nuxt-security's 429. Daily caps keep `data.quota` and the countdown. nuxt-security's limiter stays as a cheap per-instance first line, with the same per-route numbers and the 150 requests / 5 min global limit. The fixed window lets a client send up to twice the per-minute limit across a minute boundary, which is acceptable for a burst guard. A 3-argument call still counts per day, so code from before the migration keeps working against it.

## Security audit note (2026-10-22): failing closed, and PDFs from the CDN

**Failing closed on configuration errors.** On 2026-10-21 the first production deploy went live about ten minutes before `20261021120000_burst_quota.sql` was applied. `consume_quotas` answered 404 (`PGRST202`), so every chat and search was let through. The only record was a warning in runtime logs, which Hobby keeps for an hour. None of item 5's mitigations held: retrieval kept working, the per-instance limiter resets on every cold start, and nobody was reading the logs. Now only an outage fails open: no response at all, or a 5xx. A 4xx or an empty result means the deployment is wrong, and the routes answer 503 until it is fixed. Both cases log at error level. `NUXT_QUOTA_*_GLOBAL=0` is still the quick off-switch. Revoking or dropping `consume_quotas` used to lift every cap; now it closes the routes too.

**The corpus PDFs come from the CDN.** Supabase Free includes 5 GB of uncached egress per organization and billing cycle. Past that, Supabase can answer 402 to every request. By 2026-10-22, local verification runs had downloaded about 4 GB of it: viewer checks, Lighthouse and audit sweeps, all against a local server that signed URLs on the hosted bucket. The four public PDFs are now published from `docs/golden/pdfs` at `/pdfs` (`nitro.publicAssets`, cached for a day), and the file route returns that same-origin URL for them (`server/utils/static-pdfs.ts`). They are byte-identical to the bucket objects the highlights were computed from, so changing one means a new filename. Vercel Hobby includes 100 GB of transfer a month, and the CDN caches the files. Signed URLs remain for documents outside the corpus (Phase 11b uploads).

## Security audit note (2026-11-03): one client, the CDN and `/pdfs`

**Lower per-client caps.** At 30 chats a client, three addresses could spend the whole day's 80, and every visitor then saw the budget message until midnight UTC. The per-client caps are now 10 chats and 30 searches, so it takes eight and ten addresses. This raises the bar without closing the gap: someone with enough addresses can still spend the budget. An office behind one address shares the 10 chats. Keying IPv6 per /48 was rejected, because carriers can place unrelated phones in one /48 and they would share that smaller allowance.

**`/api/chunks/:id` is cached.** It was the one route that queried Postgres on every call with only the per-instance limiter in front, and every call counts as Supabase egress. It is now cached for a day in the function and on Vercel's CDN, keyed by id. Only successful answers are cached. After `pnpm ingest:golden --replace`, an old chunk or highlight can be served for up to a day, or until the next deploy clears the CDN.

**A Vercel Firewall rule limits `/pdfs/`.** The PDFs are on the CDN with no function in the path, so no code here can limit them. Hobby allows one rate-limit rule per project, fixed window, keyed by IP. It lives in the Vercel project, not in this repository (DEPLOYMENT.md §5). It slows a single host; it can't stop many hosts from using up the 100 GB of monthly transfer.

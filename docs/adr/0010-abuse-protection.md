# ADR-0010: Abuse protection and demo mode

- **Status:** Accepted
- **Date:** 2026-10-20

## Context

TruthBase is a public portfolio demo running on free tiers (ADR-0001). Every question spends quota that can't be bought back that day. Groq allows each model 8K tokens/min, 1K requests/day and 200K tokens/day: gpt-oss-120b, the answer model, covers about 100 answers a day, and gpt-oss-20b, used for rewriting and reranking (ADR-0007, ADR-0009), covers about 60 enhanced chats. Gemini's free embeddings and Langfuse's Hobby plan (50K units/month) have their own limits. One script, or a link going viral, can spend a day's quota in minutes, and then the demo is broken for everyone until midnight.

Before this phase there was only nuxt-security's in-memory per-IP limiter: 150 requests / 5 min overall, 10/min on `/api/chat` and 30/min on `/api/search`. It stops bursts, but it allows 14,400 chats a day per IP, resets on every restart, isn't shared between instances, and trusted `X-Forwarded-For` from any client (TECH_NOTES §11).

Phase 11's acceptance criterion (EXECUTION_PLAN): exceeding the cap returns a clean 429, and the demo workspace works without login. Bring-your-own documents behind Supabase Auth is split into its own phase (11b), with the prompt-injection review SPEC requires before uploads open.

## Decision

1. **Two layers.** nuxt-security's per-minute limiter stays as the burst limit, keyed on the same client IP as the daily caps (item 4; `server/plugins/client-ip.ts` sets it as `rateLimiter.ipHeader`), in an LRU store of 10,000 entries. On top, **daily caps per client and for the whole demo**, enforced before any model call in `/api/chat` and `/api/search` (`server/utils/quota.ts`):

   | Route | Per client / day | Whole demo / day | Why |
   |---|---|---|---|
   | `/api/chat` | 30 | 80 | gpt-oss-120b's 200K tokens/day ≈ 100 answers; 20 left for evals and retries |
   | `/api/search` | 100 | 300 | embeddings only: no rewrite, rerank or answer |

   All four are `NUXT_QUOTA_*` settings; a limit below 1, or a value that isn't a whole number, closes the route (with a warning at startup). The day is UTC.

   Search runs plain hybrid retrieval: gpt-oss-20b's ~60 enhanced requests a day are kept for chat, which a single client's search allowance could otherwise spend for everyone.
2. **Counters in Postgres** (`usage_counters`, migration `20261020120000_usage_quota.sql`). One function, `consume_quotas(scopes[], keys[], limits[])`, locks the counter rows in a fixed order and increments all of them or none, so concurrent requests can't overshoot and a request blocked by the global budget doesn't use up its client's allowance. Rows older than two days are pruned on the way. Server-only: RLS with no policies, execute for `service_role` only.
3. **Over a cap: 429** with `Retry-After` (seconds to midnight UTC) and a message saying which limit was hit, before the response stream opens. The body's `data.quota` (`client` or `global`) lets the UI show that message and drop its Retry button; the per-minute limiter's 429 keeps "wait a minute".
4. **The client is the IP, stored as an HMAC** keyed with the service key (22 characters of base64url), never in clear. The IP is the socket address unless `NUXT_TRUSTED_IP_HEADER` names the header the deployment's proxy sets (`cf-connecting-ip`, `fly-client-ip`, `x-real-ip`, or `x-forwarded-for`, whose last entry is used); otherwise client-sent headers are ignored. IPv6 counts per /64 (one host usually holds a whole /64) and IPv4-mapped addresses as IPv4. The origin must be reachable only through that proxy, or a client can send the header itself; with chained proxies (a CDN in front of the host), use the outermost one's header, since the last `x-forwarded-for` entry is only the nearest proxy. A configured header missing from a request, or no header in production while the socket address is private, is logged once: it means every visitor may be sharing one allowance.
5. **Fail open.** If the counter store errors, the request proceeds with a logged warning. A Supabase outage breaks retrieval anyway, and the per-minute limiter still applies.
6. **Demo mode is the default and only mode for now:** the four golden documents, public and read-only, no login. Ingestion stays operator-only (`NUXT_INGEST_TOKEN`). Output length was already capped (700 tokens per answer, 1,000 characters per question).

## Rationale

- **Daily caps match the resource.** Groq's binding limit is per day. A per-minute limit tight enough to protect the daily budget (80 / 1440 min) would make the demo unusable for a normal visitor asking five questions in a row.
- **A global budget, not only per-client.** Per-IP caps don't stop many IPs. The global budget is what guarantees the quota can't run out for the answer model; once it's spent, visitors get a clear message instead of failing generations.
- **Postgres instead of Redis or KV:** it's already there, survives restarts and is shared across instances on any deploy target (Node host or Workers, ADR-0011 pending). One RPC adds about one round trip (~50–150 ms) before retrieval starts, which runs in parallel with nothing else; acceptable against ~1.4 s to first token.
- **All-or-nothing in one call:** two separate counters would let a blocked request use up the other allowance, and two round trips would double the latency.
- **HMAC, not a plain hash:** IPv4 has only 2³² values, so an unkeyed hash is reversible by enumeration.

## Rejected alternatives

- **Mandatory sign-in for the demo:** kills the portfolio use case (a reviewer clicking a link). Auth comes with bring-your-own documents (11b), where it protects data, not quota.
- **CAPTCHA (Turnstile):** adds friction for every visitor to stop a threat the caps already bound. Revisit if the global budget is routinely spent by bots.
- **nuxt-security's rate limiter with a shared storage driver:** still a sliding window, not a calendar-day budget, and it needs a KV store we don't have.
- **Cloudflare rate-limiting rules:** depend on the deploy target (ADR-0011) and can't see the global budget.
- **Counting tokens instead of requests:** closer to Groq's metering, but needs the counter after generation (streams can't be refused retroactively). Requests are a good proxy: answers are capped at 700 output tokens and prompts at 8 sources.

## Consequences

- **Deploy:** apply the migration, and set `NUXT_TRUSTED_IP_HEADER` for the host (Phase 14); it keys both layers. Until the migration exists, the app fails open with a warning per request.
- **Shared IPs** (offices, carrier NAT) share one allowance of 30 chats a day. Acceptable for a demo.
- **gpt-oss-20b runs out before the chat budget:** 80 chats a day exceed its ~60 enhanced chats, so late in a busy day chat skips rewriting and reranking and answers from the fused order (ADR-0007, ADR-0009). Answers still work.
- **PDF egress is not capped per day.** `/api/documents/:id/file` signs a 12-minute URL that Storage serves directly and that can be fetched again until it expires; only the per-minute limiter bounds signing. The golden PDFs are 1–2.5 MB, so draining the free egress takes thousands of downloads. Serve them from a CDN at deploy if that happens.
- **The global budget is spent by evals too** only if they go through the routes; they don't (they call the pipeline directly), so the 20 left over is headroom for their direct use of the same Groq quota.
- **Langfuse Hobby (50K units/month)** is bounded too: at ~17–20 observations per traced chat, 80 chats a day is ~45K a month, close to the cap. Sample traces or lower the cap if the demo is busy every day.
- **Revisit** on a paid tier, when 11b adds per-user quotas for signed-in users, or if the shared-IP limit hurts real visitors.

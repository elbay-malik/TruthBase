# Deployment runbook (Vercel Hobby)

How TruthBase goes live, and how to check and roll back a deploy. The reasons behind each choice are in [ADR-0011](./adr/0011-deployment-topology.md).

**Topology:** one Vercel Function (Node.js 24, Fluid compute, region `dub1`) serves SSR and `/api/*`. Vercel's CDN serves `/_nuxt`, `/pdfjs`, the corpus PDFs at `/pdfs` and `favicon.ico`. Supabase (AWS eu-west-1) holds the corpus index, the original PDFs and the quota counters. Groq answers. Cloudflare Workers AI embeds every question with bge-m3 and is the answer fallback. Langfuse traces. Ingestion runs from the operator's machine.

## 0. Before the first deploy

1. **Check locally:**

   ```bash
   pnpm build:vercel && pnpm check:vercel
   ```

   This builds `.vercel/output` and checks the function config, the static files and the server assets. It then boots the function with `VERCEL=1` and no secrets. CI job `build-vercel` runs the same checks.

2. **Apply the database migrations** to the hosted project, in filename order, before the new code goes live. First check which ones it already has (`supabase migration list` after `supabase link`, or the dashboard's Database → Migrations); the first four are in its history, the Phase 6 and Phase 11 ones (`20261019120000_hybrid_search_v2.sql`, `20261020120000_usage_quota.sql`) may or may not be. Apply only the missing ones. `20261021120000_burst_quota.sql` must exist before the Phase 14 code serves traffic. Without it, chat and search answer 503 (ADR-0010 item 5). Use the SQL Editor, or `supabase db push` after `supabase link` ([supabase/README.md](../supabase/README.md#how-to-apply)). Then run `supabase/tests/usage_quota.sql` and `supabase/tests/burst_quota.sql` in the SQL Editor. Each prints `NOTICE … passed` and rolls back.

   `20261104120000_bge_m3_column.sql` adds `chunks.embedding_bge_m3` and `hybrid_search_bge_m3` ([ADR-0013](./adr/0013-leaving-gemini.md)). The current code searches and writes only these. It is live on the hosted project, but it was pasted into the SQL Editor, so the hosted migration list doesn't show it. `supabase migration list` reports it as missing, and `supabase db push` would run it again and fail, because the column exists. Its check, `supabase/tests/hybrid_search_bge_m3.sql`, needs an empty `chunks` table, so it runs in CI and on a fresh local database, not on the hosted project.

3. **Ingest the corpus** with the local CLI. It uses the same pipeline as `/api/ingest`, embeds through Cloudflare (the `NUXT_CLOUDFLARE_*` values), and talks directly to the hosted Supabase project in `.env`:

   ```bash
   pnpm ingest:golden            # skips PDFs already there
   pnpm ingest:golden --replace  # re-ingests, then deletes the old copies
   ```

   Ingestion never runs on Vercel. Request bodies are capped at 4.5 MB, and `NUXT_INGEST_TOKEN` stays unset there, so the route answers 503.

   **After a change to the highlight math** (`server/ingest/{extract,glyphs,highlight}.ts`), the operator refreshes the stored rects in place:

   ```bash
   pnpm ingest:golden --highlights-only  # rewrites chunks.highlight only
   ```

   It recomputes each stored chunk's highlight from the repo PDFs and its stored offsets. There is no re-embedding and no Storage read, and chunk ids (citation deep links) stay the same. It runs in two passes: first it recomputes and checks every chunk of every document, then it writes. If any chunk's page text changed, it stops with "re-ingest with --replace" before writing anything. The writes are one update per chunk, not a transaction, so a network or database error during the write pass can leave a partial refresh. Re-running the command is idempotent and finishes it. Until it runs, `pnpm check:viewer` against the hosted corpus fails the spans whose rects changed, because it compares against `test/fixtures/highlight-spans.json`. The 2026-10-25 big-operator change (ADR-0004) was refreshed this way the same day: 564 chunks in 4 documents, then `check:viewer` 180/180.

## 1. Create the Vercel project

1. On vercel.com (Hobby), choose **Add New → Project** and import the GitHub repo. The repo is owned by a personal account, which Hobby requires.
2. **Framework preset:** Nuxt.js (auto-detected). Leave the build command, output directory and root directory at their defaults. `vercel.json` sets the install command to `corepack pnpm install --frozen-lockfile`, so pnpm 11.28.5 from `packageManager` installs the lockfile. Nitro sees `VERCEL=1` and builds its vercel preset into `.vercel/output`.
3. **Region:** nothing to set. The function config (`nitro.vercel.functions` in `nuxt.config.ts`) pins `dub1` next to Supabase eu-west-1. Project → Settings → Functions may still show the account default region. The build output takes precedence; check the deployment's function region (section 3).
4. **Node.js version:** 24.x. `engines.node` and the function config both select it.
5. **Environment variables** (Project → Settings → Environment Variables), for Production and Preview. Names only; the values come from your `.env` and the provider dashboards. [.env.example](../.env.example) documents each one.

   | Name | Required | Notes |
   |---|---|---|
   | `NUXT_GROQ_API_KEY` | yes | answers, rewrites, reranking |
   | `NUXT_CLOUDFLARE_ACCOUNT_ID`, `NUXT_CLOUDFLARE_API_TOKEN` | yes | bge-m3 embeddings and the answer fallback; a token with Workers AI scope only. Without them, chat, search and ingest answer 503. Free plan: 10,000 Neurons a day, and requests fail over quota rather than bill |
      | `NUXT_SUPABASE_URL` | yes | |
   | `NUXT_SUPABASE_SERVICE_KEY` | yes | server-only; also keys the IP HMAC |
   | `NUXT_TRUSTED_IP_HEADER` | recommended | `x-vercel-forwarded-for` (also the default on Vercel) |
   | `NUXT_TURNSTILE_SECRET_KEY`, `NUXT_PUBLIC_TURNSTILE_SITE_KEY` | yes, Production | Cloudflare Turnstile on `/api/chat`, from a widget whose hostnames cover the production domains. Set both or neither. On any Vercel deployment chat answers 503 without the secret, so on Preview chat is off unless you set Cloudflare's test keys with `NUXT_TURNSTILE_HOSTNAMES=example.com` (`.env.example`). The test keys always pass, so use them only on previews behind Vercel Authentication |
   | `NUXT_TURNSTILE_HOSTNAMES` | optional | default `truthbase.elbaymalik.com,truthbase-brown.vercel.app`, the page hostnames a token may come from |
   | `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` | optional | tracing off without them |
   | `LANGFUSE_BASE_URL` | optional | EU `https://cloud.langfuse.com` |
   | `LANGFUSE_TRACING_ENVIRONMENT` | optional | e.g. `preview` for the Preview environment |
   | `NUXT_RERANK_MODEL`, `NUXT_EXPAND_MODEL` | optional | default `groq-20b` |
   | `NUXT_GEMINI_API_KEY` | no | only serves the explicit `gemini` model choices. It goes after a 7-day soak, with the old column, the old function and `@ai-sdk/google` (ADR-0013) |
   | `NUXT_QUOTA_CHAT_PER_MINUTE`, `NUXT_QUOTA_CHAT_PER_CLIENT`, `NUXT_QUOTA_CHAT_GLOBAL` | optional | default 10 / 10 / 80 |
   | `NUXT_QUOTA_SEARCH_PER_MINUTE`, `NUXT_QUOTA_SEARCH_PER_CLIENT`, `NUXT_QUOTA_SEARCH_GLOBAL` | optional | default 30 / 30 / 300 |
   | `CRON_SECRET` | yes, Production only | any random 64-hex string. Vercel sends it to the daily crons (`/api/cron/keep-alive`, `/api/cron/prune-traces`), which are 503 without it. Crons run on Production only, so Preview doesn't need it |
   | `NUXT_INGEST_TOKEN` | **do not set** | ingestion stays on the CLI |
   | `ENABLE_EXPERIMENTAL_COREPACK` | only if needed | `1`, if the build log shows a pnpm other than 11.28.5 |

   Preview deployments share the hosted Supabase project and the free model quotas with Production, and the global daily budget counts both. Set lower `NUXT_QUOTA_*` values on Preview, or keep previews private (the default Vercel Authentication for previews).

6. **Deploy.** The first build log should show `pnpm 11.28.5`, `nitro … vercel`, and `You can deploy this build using npx vercel deploy --prebuilt`.

   Deploy only through git (a push to `main`) or `vercel deploy --prebuilt`, which uploads just `.vercel/output`. A plain `vercel deploy` uploads the working directory as the deployment's source, readable later by anyone with access to the Vercel team. `.vercelignore` keeps `.env` and local state out of it. One CLI deploy on 2026-10-21 happened before that file existed and stored `.env`. On 2026-10-22 that deployment was deleted and every key in it rotated (section 6).

## 2. Optional extras

- **Keep-alive runs:** the daily cron is listed under the project's Settings → Cron Jobs, with its logs and a **Run** button. Vercel doesn't retry a failed run. A failed ping (401 without the right `CRON_SECRET`, 503 when it is unset, 502 when the read fails) shows in the logs, so check them after any deploy that touched env vars. Env vars reach new deployments only: after setting or rotating `CRON_SECRET`, redeploy, then press **Run** once.
- **Trace clean-up runs:** `/api/cron/prune-traces` deletes Langfuse traces older than 26 days (`server/utils/trace-retention.ts`), a promise on the privacy page. Nothing announces a failed run: Vercel doesn't retry and Hobby's runtime logs last an hour. So now and then look in Langfuse for traces older than about 27 days; there should be none. It matters because Hobby hides anything past 30 days from its API, so after three failed runs in a row the oldest traces can't be found, and only Langfuse support could remove them. The route returns how many ids it sent; Langfuse removes them within about 15 minutes.
- **Vercel WAF rate limit:** Hobby has one rate-limit rule per project. Burst limits are already enforced in Postgres for every instance. If bots hammer the site, a rule such as "path starts with `/api/` → 60 requests / 60 s per IP → 429" stops them before they cost a function invocation. The corpus PDFs at `/pdfs/` count against Fast Data Transfer instead; a rule for that path bounds repeated downloads.

## 3. Smoke checks (every production deploy, and the first preview)

Replace `$URL` with the deployment URL. Previews are behind Vercel Authentication by default: run these against production, or add a Protection Bypass token.

```bash
# Page renders, with the nonce CSP and no COEP header (TECH_NOTES §11).
curl -sI -H 'accept-encoding: br' "$URL/" | grep -iE '^(content-security-policy|cross-origin-embedder-policy|content-encoding|x-vercel-id):'
#   expect: CSP with worker-src 'self' blob:, NO cross-origin-embedder-policy, content-encoding: br
# The x-vercel-id header names the function region: …::dub1::…

# Health, and JSON compressed by the CDN.
curl -s "$URL/api/health"                                         # {"status":"ok",…}
# The keep-alive cron refuses callers without its secret: 401 on Production,
# 503 on a Preview (CRON_SECRET is Production only).
curl -s -o /dev/null -w '%{http_code}\n' "$URL/api/cron/keep-alive"  # 401 (Production)
curl -sI -H 'accept-encoding: br' "$URL/api/documents" | grep -i content-encoding

# PDF.js data files and the client bundle from the CDN, with headers.
curl -sI "$URL/pdfjs/cmaps/UniJIS-UTF16-H.bcmap" | grep -iE '^(HTTP|cache-control)'
curl -sI "$URL/pdfjs/wasm/openjpeg.wasm" | grep -iE '^(HTTP|content-type)'
curl -sI "$URL$(curl -s "$URL/" | grep -oE '/_nuxt/[^"]+\.js' | head -1)" | grep -iE '^(cache-control|x-content-type-options):'
#   expect immutable cache-control and x-content-type-options: nosniff (on every static file,
#   /pdfs and /pdfjs too: nitro.vercel.config's first route, ADR-0011 Consequences).

# The corpus PDFs from the CDN: no Storage egress (ADR-0010).
curl -sI "$URL/pdfs/nist-csf-2.0.pdf" | grep -iE '^(HTTP|content-type|cache-control)'
#   expect: 200, application/pdf, max-age=86400

# Error pages decode (curl exits 0), and other sites can't post to the quota routes.
curl -s --compressed -H 'accept: text/html' -o /dev/null -w '%{http_code}\n' "$URL/no-such-page"   # 404, TruthBase's error page
curl -s -o /dev/null -w '%{http_code}\n' -X POST -d 'question=hi' "$URL/api/chat"                  # 415

# Ingestion is off: 503 before reading the body.
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'content-length: 10' --data 0123456789 "$URL/api/ingest"   # 503
```

Then in a browser:

1. **Ask → cite → highlight:** ask a golden question (e.g. "What does RC.RP-03 require?"). The answer streams with chips. Clicking a chip opens the PDF at the cited page with the highlight. Try it on a phone too.
2. **Client IP and quota store:** in the Vercel runtime logs (kept 1 hour), there must be no `[quota] … NUXT_TRUSTED_IP_HEADER is unset` or `… is missing on a request` warning, and no `[quota] … counter store unavailable` or `… refusing the request` error. A forged header must not change the client. Send 11 quick chats with `-H 'x-vercel-forwarded-for: 1.2.3.4'`; the 11th must still get the per-minute 429.
3. **Per-minute limit across instances:** the 11th chat within a clock minute returns 429 with `Retry-After` ≤ 60 and the message "Too many questions in a short time …". The UI shows "Slow down a moment" with Retry.
4. **Tracing:** with Langfuse keys set, the chat appears as one trace within a minute, including the `answer` output and `ttftMs`. If traces are missing, check the logs for `[tracing] flush failed`.
5. **Stop / closed tab:** press Stop mid-answer. The Langfuse trace should end with `WARNING: client disconnected` and a short `totalMs`. If it runs to completion instead, Vercel isn't passing the disconnect through (`supportsCancellation`). That is acceptable (ADR-0011), but note it in TECH_NOTES.

## 4. Rollback

- **App:** Vercel → Deployments → pick the last good production deployment → **Instant Rollback** (or `vercel rollback <url>`). It switches the alias without a rebuild. Hobby keeps previous deployments, so this takes seconds. Cron jobs follow the deployment: rolling back to one from before 2026-10-25 removes the daily keep-alive, so roll forward soon or ping the database by hand.
- **Quick off-switch for spend:** set `NUXT_QUOTA_CHAT_GLOBAL=0` (and/or `NUXT_QUOTA_SEARCH_GLOBAL=0`) and redeploy. The routes answer with the daily-cap 429 and spend no model quota.
- **Database:** migrations are forward-only. `20261021120000_burst_quota.sql` keeps the 3-argument `consume_quotas` call working, so a rolled-back app (Phase 11–13 code) runs against the migrated database unchanged. Don't drop `burst_counters` while the Phase 14 code is live.
- **Embeddings:** until the 7-day soak ends, `chunks.embedding` and `hybrid_search` stay in place, so a deployment from before the switch still runs, given `NUXT_GEMINI_API_KEY`. Anything ingested since then has no Gemini vector, because ingestion writes `embedding_bge_m3` only.
- **Corpus:** `pnpm ingest:golden --replace` re-ingests from the repo PDFs. Instances may show the old document list for up to 10 minutes (per-instance catalog and list caches).

## 5. Limits to keep in mind (Hobby)

These are the Vercel Hobby plan limits ([Hobby plan](https://vercel.com/docs/plans/hobby), [function limits](https://vercel.com/docs/functions/limitations)):

- **Use:** non-commercial only. No ads, payments, or paid client work on this deployment.
- **Monthly allotments:** 1,000,000 invocations, 4 Active CPU-hours, 360 GB-hours of provisioned memory, 100 GB Fast Data Transfer, 10 GB Fast Origin Transfer and 1,000,000 CDN requests. Past a limit, the project waits for the 30-day window instead of being billed.
- **Per function:** 2 GB of memory and 1 vCPU, 300 s maximum duration (ours is 150 s), 4.5 MB request and response bodies, and one region.
- **Logs and deployments:** runtime logs are kept for 1 hour, and the plan allows 100 deployments a day.
- **Firewall:** one rate-limit rule per project, set in the dashboard (Firewall → Configure → New Rule), not in this repository. This project's rule: `Limit corpus PDF downloads`, if Request Path starts with `/pdfs/`, fixed window, 600 s, 60 requests, keyed by IP, Default (429) action. A visitor who opens a PDF on a slow connection makes about 5 requests, so 60 covers normal reading (ADR-0010).

## 6. Rotating a secret

1. Create the new key at the provider, and keep the old one working for now: the Supabase secret key (Project Settings → API Keys), Groq, the Cloudflare API token (Workers AI scope only) or the Langfuse key pair. For `NUXT_INGEST_TOKEN`, any new random 64-hex string.
2. Put it in `.env`, in the Vercel project's Production and Preview environment variables (Sensitive), and in the GitHub Actions secrets that copy it: `NUXT_SUPABASE_SERVICE_KEY`, `NUXT_GROQ_API_KEY`, `NUXT_CLOUDFLARE_ACCOUNT_ID`, `NUXT_CLOUDFLARE_API_TOKEN`. `NUXT_INGEST_TOKEN` goes into `.env` only; on Vercel it stays unset (section 1).
3. Redeploy production, since environment changes reach new deployments only. Run the smoke checks (section 3), with one real chat.
4. Revoke the old key.

The service key also keys the IP HMAC (ADR-0010 item 4), so after a new one every client's daily count starts again. Older deployments keep the values they were built with, so after step 4 an Instant Rollback to one of them fails until it is redeployed.

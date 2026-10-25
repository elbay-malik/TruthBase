// Checks a `NITRO_PRESET=vercel pnpm build` (.vercel/output, Build Output API
// v3) without a Vercel account (Phase 14, ADR-0011), in CI and locally:
//
//   NITRO_PRESET=vercel pnpm build && pnpm check:vercel
//
// 1. The function config Nitro writes (.vc-config.json): Node 24, the Dublin
//    region, maxDuration, streaming and cancellation.
// 2. The static output: the PDF.js data files for the viewer, the corpus PDFs,
//    no prebuilt .br/.gz sidecars (Vercel's CDN compresses itself), and the
//    headers config.json gives them (nosniff as well as cache-control).
// 3. The server assets bundled into the function (PDF.js CMaps and fonts).
// 4. The function itself, booted as a Node listener the way Vercel's Node
//    launcher calls it, with VERCEL=1 and no secrets: the page with its
//    security headers, /api/health, the keep-alive cron refusing without its
//    secret, an error page that decodes, no icon
//    endpoint, and the routes refusing politely.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const OUTPUT = resolve(import.meta.dirname, '../.vercel/output')
const FUNC = join(OUTPUT, 'functions/__fallback.func')
const failures: string[] = []
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures.push(what)
}
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'))

if (!existsSync(join(OUTPUT, 'config.json'))) {
  console.error(`${OUTPUT}/config.json is missing: run \`NITRO_PRESET=vercel pnpm build\` first`)
  process.exit(1)
}

// 1. Build Output config and the function's config.
const config = json(join(OUTPUT, 'config.json'))
check(config.version === 3, 'config.json is Build Output API v3')
check(config.routes?.some((r: { handle?: string }) => r.handle === 'filesystem'), 'config.json serves static files before the function')
check(config.routes?.some((r: { dest?: string }) => r.dest === '/__fallback'), 'config.json routes everything else to the function')
// The daily Supabase keep-alive (Hobby allows daily schedules only).
check(JSON.stringify(config.crons) === '[{"path":"/api/cron/keep-alive","schedule":"0 6 * * *"}]', `config.json has the daily keep-alive cron (got ${JSON.stringify(config.crons)})`)

// The headers Vercel's CDN gives a static file: header routes in order, up to
// the filesystem phase; a match without `continue: true` ends the walk.
interface HeaderRoute { src?: string, headers?: Record<string, string>, continue?: boolean, handle?: string }
const staticHeaders = (path: string) => {
  const headers: Record<string, string> = {}
  for (const route of config.routes as HeaderRoute[]) {
    if (route.handle) break
    if (!route.src || !new RegExp(`^(?:${route.src})$`).test(path)) continue
    for (const [name, value] of Object.entries(route.headers ?? {})) headers[name.toLowerCase()] = value
    if (!route.continue) break
  }
  return headers
}
for (const path of ['/_nuxt/entry.js', '/_nuxt/builds/meta/x.json', '/pdfs/nist-csf-2.0.pdf', '/pdfjs/cmaps/UniJIS-UTF16-H.bcmap', '/favicon.ico']) {
  const headers = staticHeaders(path)
  check(headers['x-content-type-options'] === 'nosniff' && /max-age/.test(headers['cache-control'] ?? ''), `static ${path}: nosniff and cache-control`)
}

const vc = json(join(FUNC, '.vc-config.json'))
check(vc.runtime === 'nodejs24.x', `function runtime nodejs24.x (got ${vc.runtime})`)
check(JSON.stringify(vc.regions) === '["dub1"]', `function region dub1, next to Supabase eu-west-1 (got ${JSON.stringify(vc.regions)})`)
check(vc.maxDuration === 150, `function maxDuration 150 s (got ${vc.maxDuration})`)
check(vc.supportsResponseStreaming === true, 'function streams responses')
check(vc.supportsCancellation === true, 'function receives client disconnects')
check(vc.handler === 'index.mjs' && vc.launcherType === 'Nodejs', 'function is a Node.js handler')
for (const route of ['api/chat', 'api/search', 'api/health']) {
  check(existsSync(join(OUTPUT, 'functions', `${route}.func`)), `functions/${route}.func exists`)
}

// 2. Static files.
const STATIC = join(OUTPUT, 'static')
for (const file of ['pdfjs/cmaps/UniJIS-UTF16-H.bcmap', 'pdfjs/standard_fonts/FoxitSerif.pfb', 'pdfjs/wasm/openjpeg.wasm', 'favicon.ico']) {
  check(existsSync(join(STATIC, file)), `static/${file}`)
}
check(readdirSync(join(STATIC, '_nuxt')).some(f => f.endsWith('.js')), 'static/_nuxt has the client bundle')
// The corpus PDFs the viewer opens from the CDN (server/utils/static-pdfs.ts), as in the repo.
const PDFS = resolve(import.meta.dirname, '../docs/golden/pdfs')
for (const name of readdirSync(PDFS).filter(f => f.endsWith('.pdf'))) {
  const file = join(STATIC, 'pdfs', name)
  check(existsSync(file) && readFileSync(file).equals(readFileSync(join(PDFS, name))), `static/pdfs/${name}`)
}
const sidecars: string[] = []
const walk = (dir: string) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path)
    else if (/\.(br|gz)$/.test(entry)) sidecars.push(path)
  }
}
walk(STATIC)
check(sidecars.length === 0, `no prebuilt .br/.gz in static/ (found ${sidecars.length})`)

// 3. Server assets: PDF.js data for server-side extraction, inside the bundle.
const nitroChunk = readFileSync(join(FUNC, 'chunks/nitro/nitro.mjs'), 'utf8')
check(nitroChunk.includes('pdfjs-cmaps:UniJIS-UTF16-H.bcmap'), 'PDF.js CMaps are bundled as server assets')
check(nitroChunk.includes('pdfjs-standard-fonts:FoxitSerif.pfb'), 'PDF.js standard fonts are bundled as server assets')

// 4. Boot the function as Vercel's Node launcher would: a (req, res) listener.
// No secrets, so the routes that need them must say so.
process.env.VERCEL = '1'
process.env.NODE_ENV = 'production'
for (const name of ['NUXT_GROQ_API_KEY', 'NUXT_GEMINI_API_KEY', 'NUXT_SUPABASE_URL', 'NUXT_SUPABASE_SERVICE_KEY', 'NUXT_INGEST_TOKEN', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY']) {
  Reflect.deleteProperty(process.env, name)
}
const { default: listener } = await import(pathToFileURL(join(FUNC, 'index.mjs')).href) as { default: (req: IncomingMessage, res: ServerResponse) => void }
const server = createServer((req, res) => {
  // Vercel's proxy sets the client IP; client-sent values never reach the function.
  req.headers['x-vercel-forwarded-for'] = '203.0.113.7'
  listener(req, res)
})
await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const warnings: string[] = []
const warn = console.warn
console.warn = (...args: unknown[]) => {
  warnings.push(args.map(String).join(' '))
  warn(...args)
}

try {
  const page = await fetch(`${base}/`, { headers: { 'accept-encoding': 'br' } })
  check(page.status === 200, `GET / is 200 (got ${page.status})`)
  check(!page.headers.has('cross-origin-embedder-policy'), 'GET / has no COEP header (PDF.js worker, TECH_NOTES §11)')
  check(/worker-src 'self' blob:/.test(page.headers.get('content-security-policy') ?? ''), 'GET / CSP allows the PDF.js worker')
  check(/nonce-/.test(page.headers.get('content-security-policy') ?? ''), 'GET / CSP has a per-request nonce')
  check(page.headers.get('content-encoding') === 'br', 'GET / HTML is brotli-encoded by the function (the CDN does not compress text/html)')
  check((await page.text()).includes('<title>TruthBase</title>'), 'GET / renders the app')

  const health = await fetch(`${base}/api/health`, { headers: { 'accept-encoding': 'br' } })
  check(health.status === 200 && (await health.json()).status === 'ok', '/api/health is ok')
  check(!health.headers.has('content-encoding'), '/api/health JSON is left to the CDN to compress')

  const keepAlive = await fetch(`${base}/api/cron/keep-alive`, { headers: { authorization: 'Bearer guess' } })
  check(keepAlive.status === 503, `GET /api/cron/keep-alive is 503 without CRON_SECRET (got ${keepAlive.status})`)

  const ingest = await fetch(`${base}/api/ingest`, { method: 'POST', body: '0123456789' })
  check(ingest.status === 503, `POST /api/ingest is 503 without NUXT_INGEST_TOKEN (got ${ingest.status})`)

  const chat = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'What is the CSF?' }) })
  check(chat.status === 503, `POST /api/chat is 503 without secrets (got ${chat.status})`)

  // Other sites can't spend the quota: no simple (preflight-free) bodies, no cross-site requests.
  const form = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'question=What+is+the+CSF%3F' })
  check(form.status === 415, `POST /api/chat with a form body is 415 (got ${form.status})`)
  const crossSite = await fetch(`${base}/api/search`, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: JSON.stringify({ query: 'CSF' }) })
  check(crossSite.status === 403, `a cross-site POST /api/search is 403 (got ${crossSite.status})`)

  // The error page is rendered by an internal request; it must not arrive double-handled.
  const missing = await fetch(`${base}/no-such-page`, { headers: { 'accept': 'text/html', 'accept-encoding': 'br, gzip' } })
  const missingHtml = await missing.text().catch((error: Error) => `undecodable: ${error.message}`)
  check(missing.status === 404 && missingHtml.includes('<title>Page not found · TruthBase</title>'), `GET /no-such-page is TruthBase's 404 page and decodes (got ${missing.status}, ${missingHtml.match(/<title>[^<]*<\/title>/)?.[0] ?? missingHtml.slice(0, 60)})`)

  // Icons ship in the client bundle; nothing proxies or caches icon lookups.
  const icon = await fetch(`${base}/api/_nuxt_icon/lucide?icons=x`)
  check(icon.status === 404, `no /api/_nuxt_icon endpoint (got ${icon.status})`)

  check(!warnings.some(w => w.includes('NUXT_TRUSTED_IP_HEADER is unset') || w.includes('is missing on a request')), 'client IP comes from x-vercel-forwarded-for without NUXT_TRUSTED_IP_HEADER')
}
finally {
  console.warn = warn
  server.close()
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nVercel output OK')
process.exit(0)

// Stands in for Supabase during the E2E run, on its own origin like the real
// project: REST for the one call the page's SSR makes on the server (GET
// /api/documents → documents listing), which page.route cannot see, and
// Storage for the "signed" PDF URLs, with Range and CORS as Supabase serves
// them, so the browser's cross-origin, ranged PDF.js loading is exercised.
// The browser's /api/* requests are answered in ./fixtures.ts.
// Runs on Node's type stripping: `node test/e2e/supabase-stub.ts`.

import { readFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'

const PORT = Number(process.env.E2E_SUPABASE_PORT ?? 3101)
const root = new URL('../../', import.meta.url)
const documents: { id: string, filename: string, pageCount: number }[] = JSON.parse(
  readFileSync(new URL('test/fixtures/e2e/documents.json', root), 'utf8'),
)
const SIGNED_PDF = '/storage/v1/object/sign/pdfs/'
/** Requests nothing here answers; the api fixture fails the test on any (GET /__unexpected). */
const unexpected: string[] = []

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'range, authorization, apikey, x-client-info',
  'access-control-expose-headers': 'accept-ranges, content-length, content-range, content-encoding',
}

/** `stall`: the full download sends its first 64 KB and then nothing, so PDF.js must load by range. */
function servePdf(range: string | undefined, filename: string, stall: boolean, res: ServerResponse) {
  const pdf = readFileSync(new URL(`docs/golden/pdfs/${filename}`, root))
  const headers = { ...CORS, 'content-type': 'application/pdf', 'accept-ranges': 'bytes', 'cache-control': 'no-store' }
  const m = /^bytes=(\d+)-(\d*)$/.exec(range ?? '')
  if (!m) {
    res.writeHead(200, { ...headers, 'content-length': pdf.length })
    if (stall) res.write(pdf.subarray(0, 65_536))
    else res.end(pdf)
    return
  }
  const start = Number(m[1])
  const end = Math.min(m[2] ? Number(m[2]) : pdf.length - 1, pdf.length - 1)
  if (start > end) {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${pdf.length}` })
    res.end()
    return
  }
  res.writeHead(206, { ...headers, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${pdf.length}` })
  res.end(pdf.subarray(start, end + 1))
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://stub')
  if (req.method === 'GET' && url.pathname === '/rest/v1/documents') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(documents.map(d => ({ id: d.id, filename: d.filename, page_count: d.pageCount }))))
    return
  }
  if (url.pathname.startsWith(SIGNED_PDF)) {
    const filename = decodeURIComponent(url.pathname.slice(SIGNED_PDF.length))
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...CORS, 'access-control-allow-methods': 'GET, HEAD' })
      res.end()
      return
    }
    if (req.method === 'GET' && url.searchParams.has('token') && documents.some(d => d.filename === filename)) {
      servePdf(req.headers.range, filename, url.searchParams.has('stall'), res)
      return
    }
  }
  if (url.pathname === '/health' || url.pathname === '/__unexpected') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(url.pathname === '/health' ? { ok: true } : unexpected))
    return
  }
  unexpected.push(`${req.method} ${url.pathname}${url.search}`)
  console.error(`[supabase-stub] unexpected ${req.method} ${url.pathname}${url.search}`)
  res.writeHead(501, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ message: 'Not stubbed for the E2E run.' }))
}).listen(PORT, '127.0.0.1', () => console.log(`[supabase-stub] listening on ${PORT}`))

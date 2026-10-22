import { promisify } from 'node:util'
import { brotliCompress, constants, gzip } from 'node:zlib'
import type { H3Event } from 'h3'

// Response compression for the node-server preset, which sends SSR HTML and
// API JSON as is (prebuilt assets are covered by nitro.compressPublicAssets).
// Only finished text bodies are touched: streams (the chat SSE), Web Responses
// and binary bodies pass through, as does anything an edge already encoded.
// On Vercel (ADR-0011) the CDN compresses JSON itself but not text/html (its
// published allowlist), so only HTML is compressed there: `json: false`.

const brotli = promisify(brotliCompress)
const gzipAsync = promisify(gzip)

/** Below this a compressed body saves less than the header costs. */
export const MIN_COMPRESS_BYTES = 1024

export type Encoding = 'br' | 'gzip'

/** The best encoding the client accepts (q=0 refuses one), or undefined. */
export function pickEncoding(acceptEncoding: string | undefined): Encoding | undefined {
  const accepted = new Map<string, number>()
  for (const part of (acceptEncoding ?? '').toLowerCase().split(',')) {
    const [name, ...params] = part.split(';').map(p => p.trim())
    const q = params.find(p => /^q\s*=/.test(p))
    if (name) accepted.set(name, q ? Number(q.split('=')[1]) || 0 : 1)
  }
  const allows = (name: Encoding) => (accepted.get(name) ?? accepted.get('*') ?? 0) > 0
  return allows('br') ? 'br' : allows('gzip') ? 'gzip' : undefined
}

const isPlainJson = (body: unknown): body is object =>
  Array.isArray(body) || (body !== null && typeof body === 'object' && Object.getPrototypeOf(body) === Object.prototype)

/**
 * Nuxt's error handler renders the error page by fetching this route itself,
 * reads the result with res.text() and copies its headers onto the real
 * response. A compressed body would reach the browser as mangled text under a
 * Content-Encoding header, so a 404 or 500 page failed to decode. The handler
 * sends the real response itself, uncompressed.
 */
const NUXT_ERROR_RENDER = '/__nuxt_error'

/** Compresses `response.body` in place when it is HTML or (unless `json: false`) JSON text. */
export async function compressResponse(event: H3Event, response: { body?: unknown }, options: { json?: boolean } = {}) {
  if (event.path.startsWith(NUXT_ERROR_RENDER)) return
  const json = options.json ?? true
  let text: string
  if (typeof response.body === 'string') {
    text = response.body
  }
  else if (json && isPlainJson(response.body)) {
    // h3 would serialise it after this hook; do it here so it can be encoded.
    text = JSON.stringify(response.body)
    if (!getResponseHeader(event, 'content-type')) setResponseHeader(event, 'content-type', 'application/json')
  }
  else {
    return
  }

  // A string body without a type is sent as HTML by h3.
  const type = String(getResponseHeader(event, 'content-type') ?? 'text/html')
  const compressible = json ? /^(text\/html|application\/json)\b/ : /^text\/html\b/
  if (!compressible.test(type) || getResponseHeader(event, 'content-encoding')) return
  appendResponseHeader(event, 'vary', 'Accept-Encoding')

  const encoding = pickEncoding(getRequestHeader(event, 'accept-encoding'))
  const size = Buffer.byteLength(text)
  if (!encoding || size < MIN_COMPRESS_BYTES) {
    response.body = text
    return
  }
  response.body = encoding === 'br'
    // Quality 5: most of the ratio of 11 at a fraction of the CPU, per request.
    ? await brotli(text, { params: { [constants.BROTLI_PARAM_QUALITY]: 5, [constants.BROTLI_PARAM_SIZE_HINT]: size } })
    : await gzipAsync(text, { level: 6 })
  setResponseHeader(event, 'content-encoding', encoding)
  removeResponseHeader(event, 'content-length')
}

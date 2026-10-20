// Phase 14: the few places where the deploy target matters (ADR-0011).
//
// Production runs as a Vercel Function (Nitro's vercel preset, Fluid compute);
// CI, E2E and local runs use the node-server preset. Vercel sets VERCEL=1 in
// the build and in every function invocation (a system environment variable),
// so the same bundle can tell where it runs.

/** True inside a Vercel build or function invocation. */
export function onVercel(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VERCEL === '1'
}

/**
 * The header Vercel's proxy sets to the client's IP. Vercel overwrites
 * X-Forwarded-For and its x-vercel-* headers, so a client can't spoof it
 * (vercel.com/docs/headers/request-headers).
 */
export const VERCEL_CLIENT_IP_HEADER = 'x-vercel-forwarded-for'

/**
 * NUXT_TRUSTED_IP_HEADER, or Vercel's client IP header when it is unset on
 * Vercel: a forgotten setting must not put every visitor in one bucket (the
 * function's socket address is Vercel's proxy, not the client).
 */
export function trustedIpHeader(configured: unknown, env: NodeJS.ProcessEnv = process.env): string {
  const header = String(configured ?? '').trim()
  if (header) return header
  return onVercel(env) ? VERCEL_CLIENT_IP_HEADER : ''
}

/** Vercel's per-invocation context, as @vercel/functions reads it (get-context.js). */
const REQUEST_CONTEXT = Symbol.for('@vercel/request-context')
type RequestContext = { waitUntil?: (promise: Promise<unknown>) => void }

/**
 * Vercel's waitUntil for the current invocation, or undefined elsewhere (or
 * outside a request's async context). The same lookup as @vercel/functions'
 * waitUntil, without its dependency tree; Nitro 2's vercel runtime doesn't
 * wire it into event.waitUntil itself.
 */
export function platformWaitUntil(): ((promise: Promise<unknown>) => void) | undefined {
  const store = (globalThis as { [REQUEST_CONTEXT]?: { get?: () => RequestContext | undefined } })[REQUEST_CONTEXT]
  const context = store?.get?.()
  return typeof context?.waitUntil === 'function' ? promise => context.waitUntil!(promise) : undefined
}

/**
 * The largest upload this deployment accepts. Vercel Functions reject request
 * bodies over 4.5 MB (413 FUNCTION_PAYLOAD_TOO_LARGE) before any code runs, so
 * there the route says so itself for a declared length past it (ADR-0011);
 * the corpus is ingested with the CLI instead (pnpm ingest:golden).
 * Elsewhere: the PDF limit plus room for the multipart framing.
 */
export function uploadLimit(vercel: boolean, maxPdfBytes: number): { maxRequestBytes: number, message: string } {
  return vercel
    ? { maxRequestBytes: 4_500_000, message: 'Uploads to this deployment are limited to 4.5 MB (the Vercel Functions request body limit). Ingest larger PDFs with the CLI (see docs/DEPLOYMENT.md).' }
    : { maxRequestBytes: maxPdfBytes + 1024 * 1024, message: `PDFs are limited to ${maxPdfBytes / 1024 / 1024} MB.` }
}

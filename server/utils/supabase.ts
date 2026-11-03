import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// SERVER ONLY. Uses the service_role key from runtimeConfig — never import this
// from client/app code, and never move the key under runtimeConfig.public.
//
// Auto-imported by Nitro from server/utils, so route handlers can call
// serverSupabase() without an import.

let client: SupabaseClient | undefined

/**
 * Per-request cap on database (PostgREST/RPC) calls, so a stalled connection
 * ends in an error (and the quota check fails open) instead of hanging the
 * route. Generous: hybrid_search_bge_m3 on a cold free-tier database takes a few
 * seconds, and PostgREST's own statement timeout (~8 s) normally answers
 * first. Storage is left uncapped: a 20 MB PDF upload can take longer.
 */
const REQUEST_TIMEOUT_MS = 15_000

const fetchWithTimeout: typeof fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input)
  if (!url.includes('/rest/v1/')) return fetch(input, init)
  const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS), init?.signal].filter(s => s != null)
  return fetch(input, { ...init, signal: AbortSignal.any(signals) })
}

/**
 * Lazily-built module singleton (one per server/worker instance). runtimeConfig
 * is static after boot and createClient only sets up an HTTP wrapper (no
 * connection, no realtime socket until you .subscribe()), so reuse is safe.
 */
export function serverSupabase(): SupabaseClient {
  if (client) return client

  const config = useRuntimeConfig()
  const url = config.supabaseUrl
  const serviceKey = config.supabaseServiceKey
  if (!url || !serviceKey) {
    throw createError({
      statusCode: 503,
      statusMessage: 'Service Unavailable',
      message: 'Supabase is not configured (set NUXT_SUPABASE_URL and NUXT_SUPABASE_SERVICE_KEY).',
    })
  }

  client = createClient(url, serviceKey, {
    auth: {
      persistSession: false, // no session storage on a server
      autoRefreshToken: false, // no refresh loop
      detectSessionInUrl: false, // no URL parsing on a server
    },
    global: { fetch: fetchWithTimeout },
  })
  return client
}

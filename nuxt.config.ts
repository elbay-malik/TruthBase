import { fileURLToPath } from 'node:url'

// Local verification runs (scripts/check-viewer.ts) make hundreds of page
// loads; NUXT_DISABLE_RATE_LIMIT=1 turns the in-memory limiter off, but only
// for `nuxt dev` — a production build always keeps it (audit finding).
const rateLimitOff = process.env.NODE_ENV !== 'production' && process.env.NUXT_DISABLE_RATE_LIMIT === '1'

/** Per-route limits on top of the global one: these routes spend LLM quota. */
const routeLimit = (tokensPerInterval: number) =>
  rateLimitOff ? false : { tokensPerInterval, interval: 60_000 }

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },

  modules: [
    '@nuxt/ui', // auto-registers @nuxt/icon, @nuxt/fonts, @nuxtjs/color-mode
    '@vueuse/nuxt',
    'nuxt-security',
    '@nuxt/eslint',
  ],

  css: ['~/assets/css/main.css'],

  hooks: {
    // The PDF.js worker (~1.3 MB) is fetched when the viewer first opens a
    // document (app/utils/pdf-highlight.ts); don't prefetch it on every page.
    'build:manifest': (manifest) => {
      for (const entry of Object.values(manifest)) {
        if (entry.file.includes('pdf.worker')) {
          entry.prefetch = false
          entry.preload = false
        }
        entry.assets = entry.assets?.filter(asset => !asset.includes('pdf.worker'))
      }
    },
  },

  nitro: {
    // The same PDF.js data files for the browser viewer, same-origin
    // (app/utils/pdf-highlight.ts PDFJS_ASSET_OPTIONS). Versioned with
    // pdfjs-dist, so they can be cached for a day.
    publicAssets: ['cmaps', 'standard_fonts', 'wasm', 'iccs'].map(dir => ({
      baseURL: `/pdfjs/${dir}`,
      dir: fileURLToPath(new URL(`./node_modules/pdfjs-dist/${dir}`, import.meta.url)),
      maxAge: 60 * 60 * 24,
    })),
    // PDF.js CMaps (CJK / CID fonts) and standard-font data for server-side
    // extraction, bundled with the server (server/utils/pdfjs-assets.ts).
    serverAssets: [
      { baseName: 'pdfjs-cmaps', dir: fileURLToPath(new URL('./node_modules/pdfjs-dist/cmaps', import.meta.url)) },
      { baseName: 'pdfjs-standard-fonts', dir: fileURLToPath(new URL('./node_modules/pdfjs-dist/standard_fonts', import.meta.url)) },
    ],
  },

  typescript: {
    strict: true,
  },

  runtimeConfig: {
    // Server-only secrets — overridden at runtime by NUXT_* env vars
    // (see .env.example). Never move these under `public`.
    groqApiKey: '', // NUXT_GROQ_API_KEY
    geminiApiKey: '', // NUXT_GEMINI_API_KEY
    supabaseUrl: '', // NUXT_SUPABASE_URL
    supabaseServiceKey: '', // NUXT_SUPABASE_SERVICE_KEY
    ingestToken: '', // NUXT_INGEST_TOKEN — operator-only ingestion until Phase 11
    public: {},
  },

  routeRules: {
    // Questions are data, never rendered as HTML; the XSS validator would 400
    // on harmless text like "Tier 2 < Tier 3".
    // Chat spends generation + embedding quota (Groq free tier: 1K req/day),
    // search spends embedding quota: a few per minute per IP is plenty.
    '/api/chat': {
      security: { xssValidator: false, rateLimiter: routeLimit(10) },
    },
    '/api/search': {
      security: { xssValidator: false, rateLimiter: routeLimit(30) },
    },
    // PDF uploads exceed nuxt-security's 8 MB default; matches the 20 MB
    // `documents` bucket limit enforced in server/api/ingest.post.ts.
    '/api/ingest': {
      security: {
        // Binary upload: the XSS validator would buffer and stringify the
        // whole body before the route's token check (audit finding).
        xssValidator: false,
        requestSizeLimiter: { maxUploadFileRequestInBytes: 20 * 1024 * 1024, maxRequestSizeInBytes: 21 * 1024 * 1024 },
      },
    },
  },

  // nuxt-security runs with OWASP defaults, including an in-memory
  // per-IP rate limiter (150 req / 5 min). Route-specific overrides and a
  // shared-storage driver come with Phase 11 (docs/EXECUTION_PLAN.md).
  security: {
    rateLimiter: rateLimitOff ? false : undefined,
    headers: {
      // The default COEP makes the PDF.js module worker fail to load, so PDF.js
      // silently falls back to a main-thread "fake worker". Nothing here needs
      // cross-origin isolation (no SharedArrayBuffer), so it is off (TECH_NOTES §11).
      crossOriginEmbedderPolicy: false,
      contentSecurityPolicy: {
        // The PDF.js viewer's module worker: explicit, so it does not depend on
        // how browsers apply 'strict-dynamic' in script-src (TECH_NOTES §8).
        // Only this directive is set; the other defaults stay in place.
        'worker-src': ['\'self\'', 'blob:'],
      },
    },
  },
})

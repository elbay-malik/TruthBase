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

  app: {
    head: {
      htmlAttrs: { lang: 'en' },
    },
  },

  css: ['~/assets/css/main.css'],

  ui: {
    // Theme CSS only for the components the app uses (about half the entry CSS).
    experimental: { componentDetection: true },
  },


  hooks: {
    // PDF.js (the ~490 KB library and the ~1.3 MB worker) is loaded when the
    // viewer first opens a document (app/utils/pdf-highlight.ts), and the page
    // warms it on intent; ai (with zod) is loaded once the page is idle
    // (app/composables/useLazyChat.ts). Don't prefetch them during first paint.
    'build:manifest': (manifest) => {
      for (const entry of Object.values(manifest)) {
        if (entry.file.includes('pdf.worker') || /\/(pdfjs-dist|ai)\//.test(entry.src ?? '')) {
          entry.prefetch = false
          entry.preload = false
        }
        entry.assets = entry.assets?.filter(asset => !asset.includes('pdf.worker'))
      }
    },
  },

  nitro: {
    // Prebuilt .gz/.br next to every compressible public asset (_nuxt, /pdfjs);
    // SSR HTML and API JSON are compressed by server/plugins/compression.ts.
    compressPublicAssets: { gzip: true, brotli: true },
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
    rerankModel: 'groq-20b', // NUXT_RERANK_MODEL — groq-20b | groq-120b | groq-qwen | gemini | off (ADR-0007)
    expandModel: 'groq-20b', // NUXT_EXPAND_MODEL — same choices; multi-query rewriting (ADR-0009)
    supabaseUrl: '', // NUXT_SUPABASE_URL
    supabaseServiceKey: '', // NUXT_SUPABASE_SERVICE_KEY
    ingestToken: '', // NUXT_INGEST_TOKEN — operator-only ingestion
    // Behind a proxy: the header it sets with the client IP (cf-connecting-ip,
    // fly-client-ip, x-real-ip, x-forwarded-for). Empty: the socket address.
    // Keys the daily caps and the per-minute limiter (server/plugins/client-ip.ts).
    // With chained proxies, use the outermost one's header; x-forwarded-for's
    // last entry is only the nearest proxy.
    trustedIpHeader: '', // NUXT_TRUSTED_IP_HEADER
    // Daily caps per client IP and for the whole demo (ADR-0010); a limit
    // below 1, or one that isn't a whole number, closes the route. Chat's
    // global budget keeps gpt-oss-120b inside its 200K tokens/day (~100
    // answers) with room for evals.
    quota: {
      enabled: !rateLimitOff, // off only with NUXT_DISABLE_RATE_LIMIT=1 in `nuxt dev`
      chatPerClient: 30, // NUXT_QUOTA_CHAT_PER_CLIENT
      chatGlobal: 80, // NUXT_QUOTA_CHAT_GLOBAL
      searchPerClient: 100, // NUXT_QUOTA_SEARCH_PER_CLIENT
      searchGlobal: 300, // NUXT_QUOTA_SEARCH_GLOBAL
    },
    public: {},
  },

  routeRules: {
    // Public assets get a Cache-Control only through publicAssets.maxAge.
    '/favicon.ico': { headers: { 'cache-control': 'public, max-age=86400' } },
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
  // per-IP rate limiter (150 req / 5 min) as the burst limit; the daily caps
  // live in Postgres (server/utils/quota.ts, ADR-0010).
  security: {
    rateLimiter: rateLimitOff
      ? false
      : {
          // CLIENT_IP_HEADER (server/utils/quota.ts): set on every request
          // from the trusted client IP by server/plugins/client-ip.ts.
          ipHeader: 'x-truthbase-client-ip',
          // One small entry per client and rule; LRU-evicted past this.
          driver: { name: 'lruCache', options: { max: 10_000 } },
        },
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

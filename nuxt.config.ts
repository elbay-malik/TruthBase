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
    // Phase 3.5 highlight spike: client-only (PDF.js needs window/canvas).
    '/spike/**': { ssr: false },
    // Questions are data, never rendered as HTML; the XSS validator would 400
    // on harmless text like "Tier 2 < Tier 3".
    '/api/chat': {
      security: { xssValidator: false },
    },
    '/api/search': {
      security: { xssValidator: false },
    },
    // PDF uploads exceed nuxt-security's 8 MB default; matches the 20 MB
    // `documents` bucket limit enforced in server/api/ingest.post.ts.
    '/api/ingest': {
      security: {
        requestSizeLimiter: { maxUploadFileRequestInBytes: 20 * 1024 * 1024, maxRequestSizeInBytes: 21 * 1024 * 1024 },
      },
    },
  },

  // nuxt-security runs with OWASP defaults, including an in-memory
  // per-IP rate limiter (150 req / 5 min). Route-specific overrides and a
  // shared-storage driver come with Phase 11 (docs/EXECUTION_PLAN.md).
  security: {
    // Local verification runs (scripts/check-viewer.ts) make hundreds of page
    // loads; NUXT_DISABLE_RATE_LIMIT=1 at dev/build start turns the in-memory
    // limiter off for them. Never set it in deployed environments (Phase 11).
    rateLimiter: process.env.NUXT_DISABLE_RATE_LIMIT === '1' ? false : undefined,
    headers: {
      contentSecurityPolicy: {
        // The PDF.js viewer's module worker: explicit, so it does not depend on
        // how browsers apply 'strict-dynamic' in script-src (TECH_NOTES §8).
        // Only this directive is set; the other defaults stay in place.
        'worker-src': ['\'self\'', 'blob:'],
      },
    },
  },
})

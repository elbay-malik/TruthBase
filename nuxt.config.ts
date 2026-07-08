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
    public: {},
  },

  // nuxt-security runs with OWASP defaults, including an in-memory
  // per-IP rate limiter (150 req / 5 min). Route-specific overrides and a
  // shared-storage driver come with Phase 11 (docs/EXECUTION_PLAN.md).
})

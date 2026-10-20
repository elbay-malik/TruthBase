import { defineConfig, devices } from '@playwright/test'
import { PORT, STUB_ORIGIN, STUB_PORT } from './test/e2e/ports'

// Phase 13 E2E (test/e2e): the production build, started without secrets.
// The browser's /api/* requests are answered from repo fixtures
// (test/e2e/fixtures.ts); the server's SSR documents listing and the signed PDF
// URLs from a local Supabase stub, so no key or network service is needed.
//
//   pnpm test:e2e:build                    # pnpm build && pnpm test:e2e (tests whatever .output holds)
//   E2E_FULL=1 pnpm test:e2e               # every golden span on the phone too
//   pnpm exec playwright install chromium  # once per machine

const CI = !!process.env.CI

export default defineConfig({
  testDir: 'test/e2e',
  fullyParallel: true,
  forbidOnly: CI,
  // No retries locally; on CI one, and the report lists the test as flaky.
  retries: CI ? 1 : 0,
  workers: CI ? 2 : undefined,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Instant scrolling and no highlight flash: the viewer honours it.
    contextOptions: { reducedMotion: 'reduce' },
  },
  projects: [
    // DPR 2 as in check:viewer: its ink-coverage thresholds need ≥ 2 device px per CSS px at 50%.
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 } },
    // Below 1024 px the viewer is a bottom sheet (WIREFRAMES §6).
    // E2E_FULL=1 also runs the @full highlight checks there (desktop always does).
    { name: 'phone', use: { ...devices['Pixel 7'] }, grepInvert: process.env.E2E_FULL ? undefined : /@full/ },
  ],
  webServer: [
    {
      command: 'node test/e2e/supabase-stub.ts',
      url: `http://127.0.0.1:${STUB_PORT}/health`,
      env: { E2E_SUPABASE_PORT: String(STUB_PORT) },
      // Never an old server that happens to listen there (ports: test/e2e/ports.ts).
      reuseExistingServer: false,
    },
    {
      command: 'node .output/server/index.mjs',
      url: `http://127.0.0.1:${PORT}/`,
      reuseExistingServer: false,
      env: {
        PORT: String(PORT),
        HOST: '127.0.0.1',
        NUXT_SUPABASE_URL: STUB_ORIGIN,
        NUXT_SUPABASE_SERVICE_KEY: 'e2e-stub-not-a-secret',
        // Model keys stay empty: the browser's chat requests never reach the server.
        NUXT_GROQ_API_KEY: '',
        NUXT_GEMINI_API_KEY: '',
        NUXT_INGEST_TOKEN: '',
        LANGFUSE_PUBLIC_KEY: '',
        LANGFUSE_SECRET_KEY: '',
        // Each test sends its own client IP (test/e2e/fixtures.ts).
        NUXT_TRUSTED_IP_HEADER: 'x-e2e-client-ip',
      },
    },
  ],
})

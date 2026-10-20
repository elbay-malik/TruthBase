// Brotli/gzip for SSR HTML and API JSON (server/utils/compression.ts). The
// 'beforeResponse' hook runs after the page render and nuxt-security's header
// and CSP hooks, so the HTML is final by then. On Vercel the CDN compresses
// JSON (and the prebuilt assets) itself, so only HTML is done here (ADR-0011).

export default defineNitroPlugin((nitroApp) => {
  const options = { json: !onVercel() }
  nitroApp.hooks.hook('beforeResponse', async (event, response) => {
    await compressResponse(event, response, options)
  })
})

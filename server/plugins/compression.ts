// Brotli/gzip for SSR HTML and API JSON (server/utils/compression.ts). The
// 'beforeResponse' hook runs after the page render and nuxt-security's header
// and CSP hooks, so the HTML is final by then.

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('beforeResponse', async (event, response) => {
    await compressResponse(event, response)
  })
})

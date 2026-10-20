// On Vercel, hands Nitro's event.waitUntil (the cached handlers' background
// refresh, error capture) to the platform, which keeps the invocation alive
// for those promises after the response; Nitro 2's vercel runtime leaves
// event.context.waitUntil unset, so they would only be collected locally.
// The 'request' hook runs inside the invocation's async context, where
// Vercel's request context can be read. A no-op on node-server.

export default defineNitroPlugin((nitroApp) => {
  if (!onVercel()) return
  nitroApp.hooks.hook('request', (event) => {
    if (event.context.waitUntil) return
    const waitUntil = platformWaitUntil()
    if (waitUntil) event.context.waitUntil = waitUntil
  })
})

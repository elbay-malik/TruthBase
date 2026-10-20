// One client IP for both abuse layers (ADR-0010): nuxt-security's per-minute
// limiter keys on CLIENT_IP_HEADER (security.rateLimiter.ipHeader), which is
// set here from the same trusted header as the daily quotas. Without it the
// limiter would key on the first X-Forwarded-For entry, which any client can
// send. The 'request' hook runs before every handler, nuxt-security's included.

export default defineNitroPlugin((nitroApp) => {
  const config = useRuntimeConfig()
  const trustedIpHeader = String(config.trustedIpHeader ?? '')
  // A malformed NUXT_QUOTA_* value is reported at startup, not first use.
  dailyQuotaConfig('chat')
  dailyQuotaConfig('search')

  nitroApp.hooks.hook('request', (event) => {
    event.node.req.headers[CLIENT_IP_HEADER] = clientIp(event, trustedIpHeader)
  })
})

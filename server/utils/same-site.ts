import type { H3Event } from 'h3'

// The routes that spend model quota take JSON from this site's own page.
// Another website could otherwise make its visitors' browsers spend the
// demo's quota: a form post or a no-cors fetch sends a "simple" request
// (form-encoded or text/plain, no preflight) that h3's readBody still parses.
// Requiring application/json forces a CORS preflight, which only this origin
// passes, and Sec-Fetch-Site, sent by every current browser, turns away
// cross-site requests outright. Clients outside a browser send no
// Sec-Fetch-Site and still meet the quota.

/** Throws a 403 for a cross-site browser request, or a 415 for a body that isn't JSON. */
export function assertSameSiteJson(event: H3Event): void {
  const site = getRequestHeader(event, 'sec-fetch-site')
  // "none": the user's own action (a typed URL, a bookmark), not another site.
  if (site && site !== 'same-origin' && site !== 'none') {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden', message: 'Requests from other sites are not accepted.' })
  }
  if (!/^application\/json\b/i.test(getRequestHeader(event, 'content-type') ?? '')) {
    throw createError({ statusCode: 415, statusMessage: 'Unsupported Media Type', message: 'Send the request body as application/json.' })
  }
}

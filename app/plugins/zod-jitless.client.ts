import { config } from 'zod/v4/core'

// ai builds zod schemas when its module loads; jitless skips zod's new Function("") probe (CSP report).
// Set on import, not in setup: the router plugin loads the page chunk (and ai) before this plugin runs.
config({ jitless: true })

export default defineNuxtPlugin({ name: 'zod-jitless' })

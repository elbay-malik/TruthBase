// Cloudflare Turnstile on POST /api/chat (ADR-0010, 2026-11-08 note). The page
// sends one fresh token per question in this header; the route redeems it at
// Siteverify before the quota is counted. No zod here: the client imports it.

/** Request header carrying the Turnstile token for one chat request. */
export const TURNSTILE_HEADER = 'x-turnstile-token'

/** The widget's action, checked against Siteverify's answer. */
export const TURNSTILE_CHAT_ACTION = 'chat'

/** Longest token accepted; Cloudflare's are well under this. */
export const TURNSTILE_MAX_TOKEN_LENGTH = 2048

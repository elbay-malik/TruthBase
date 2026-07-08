export default defineEventHandler(() => ({
  status: 'ok' as const,
  timestamp: new Date().toISOString(),
}))

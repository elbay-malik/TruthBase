import { afterEach, describe, expect, it, vi } from 'vitest'

// GET /api/cron/keep-alive with Nitro's auto-imports stubbed, like
// file-route.test.ts: the stubs go in before the import.
let readError: { message: string } | null = null
const reads: string[] = []
const supabase = {
  from: (table: string) => ({
    select: () => ({
      limit: async () => {
        reads.push(table)
        return { data: readError ? null : [{ id: 1 }], error: readError }
      },
    }),
  }),
}
vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
vi.stubGlobal('serverSupabase', () => supabase)
vi.stubGlobal('getHeader', (event: { headers: Record<string, string> }, name: string) => event.headers[name])
vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => Object.assign(new Error(input.message), input))

const { default: handler } = await import('../../server/api/cron/keep-alive.get') as unknown as { default: (event: unknown) => Promise<unknown> }
const call = (authorization?: string) => handler({ headers: authorization === undefined ? {} : { authorization } })

describe('GET /api/cron/keep-alive', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    readError = null
    reads.length = 0
  })

  it('is closed (503) without CRON_SECRET, and reads nothing', async () => {
    vi.stubEnv('CRON_SECRET', '')
    await expect(call('Bearer ')).rejects.toMatchObject({ statusCode: 503 })
    expect(reads).toEqual([])
  })

  it('refuses a missing or wrong bearer token (401), and reads nothing', async () => {
    vi.stubEnv('CRON_SECRET', 's3cret')
    for (const auth of [undefined, '', 's3cret', 'Bearer s3cre', 'Bearer s3cretx', 'bearer s3cret']) {
      await expect(call(auth)).rejects.toMatchObject({ statusCode: 401 })
    }
    expect(reads).toEqual([])
  })

  it('reads one keep_alive row with the right token', async () => {
    vi.stubEnv('CRON_SECRET', 's3cret')
    expect(await call('Bearer s3cret')).toEqual({ status: 'ok' })
    expect(reads).toEqual(['keep_alive'])
  })

  it('fails the run (502) when the read fails, without echoing the database message', async () => {
    vi.stubEnv('CRON_SECRET', 's3cret')
    readError = { message: 'relation "keep_alive" does not exist' }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(call('Bearer s3cret')).rejects.toMatchObject({ statusCode: 502, message: 'Keep-alive read failed.' })
    expect(error).toHaveBeenCalledWith(expect.stringContaining('does not exist'))
    error.mockRestore()
  })
})

import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import type { H3Event } from 'h3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// server/utils/compression.ts uses Nitro's auto-imported h3 helpers; stub them
// with minimal fakes (h3 isn't resolvable from the unit project).
type FakeEvent = { req: Record<string, string>, res: Record<string, string | undefined> }
const fakeEvent = (req: Record<string, string> = {}, res: Record<string, string | undefined> = {}): FakeEvent => ({ req, res })

beforeAll(() => {
  vi.stubGlobal('getRequestHeader', (event: FakeEvent, name: string) => event.req[name])
  vi.stubGlobal('getResponseHeader', (event: FakeEvent, name: string) => event.res[name])
  vi.stubGlobal('setResponseHeader', (event: FakeEvent, name: string, value: string) => {
    event.res[name] = value
  })
  vi.stubGlobal('appendResponseHeader', (event: FakeEvent, name: string, value: string) => {
    event.res[name] = event.res[name] ? `${event.res[name]}, ${value}` : value
  })
  vi.stubGlobal('removeResponseHeader', (event: FakeEvent, name: string) => {
    event.res[name] = undefined
  })
})
afterAll(() => {
  vi.unstubAllGlobals()
})

const { compressResponse, pickEncoding, MIN_COMPRESS_BYTES } = await import('../../server/utils/compression')
const asEvent = (e: FakeEvent) => e as unknown as H3Event
const html = `<!DOCTYPE html><html lang="en">${'<p>cited</p>'.repeat(200)}</html>`

describe('pickEncoding', () => {
  it('prefers brotli, then gzip', () => {
    expect(pickEncoding('gzip, deflate, br')).toBe('br')
    expect(pickEncoding('gzip')).toBe('gzip')
    expect(pickEncoding('deflate')).toBeUndefined()
    expect(pickEncoding(undefined)).toBeUndefined()
  })

  it('honours q=0 and the * wildcard', () => {
    expect(pickEncoding('br;q=0, gzip')).toBe('gzip')
    expect(pickEncoding('BR ; Q=0.5')).toBe('br')
    expect(pickEncoding('*')).toBe('br')
    expect(pickEncoding('*, br;q=0')).toBe('gzip')
  })
})

describe('compressResponse', () => {
  it('brotli-encodes HTML and drops Content-Length', async () => {
    const event = fakeEvent({ 'accept-encoding': 'gzip, br' }, { 'content-type': 'text/html;charset=utf-8', 'content-length': '2420' })
    const response: { body?: unknown } = { body: html }
    await compressResponse(asEvent(event), response)
    expect(event.res['content-encoding']).toBe('br')
    expect(event.res['content-length']).toBeUndefined()
    expect(event.res.vary).toBe('Accept-Encoding')
    expect(brotliDecompressSync(response.body as Buffer).toString()).toBe(html)
  })

  it('serialises and gzips a JSON body', async () => {
    const data = Array.from({ length: 40 }, (_, i) => ({ id: `doc-${i}`, filename: `doc-${i}.pdf`, pageCount: i }))
    const event = fakeEvent({ 'accept-encoding': 'gzip' })
    const response: { body?: unknown } = { body: data }
    await compressResponse(asEvent(event), response)
    expect(event.res['content-type']).toBe('application/json')
    expect(event.res['content-encoding']).toBe('gzip')
    expect(JSON.parse(gunzipSync(response.body as Buffer).toString())).toEqual(data)
  })

  it('leaves small bodies and clients without an encoding uncompressed', async () => {
    const small = fakeEvent({ 'accept-encoding': 'br' }, { 'content-type': 'application/json' })
    const tiny: { body?: unknown } = { body: { ok: true } }
    await compressResponse(asEvent(small), tiny)
    expect(tiny.body).toBe('{"ok":true}')
    expect(small.res['content-encoding']).toBeUndefined()
    expect(MIN_COMPRESS_BYTES).toBeGreaterThan(11)

    const plain = fakeEvent({}, { 'content-type': 'text/html' })
    const page: { body?: unknown } = { body: html }
    await compressResponse(asEvent(plain), page)
    expect(page.body).toBe(html)
    expect(plain.res.vary).toBe('Accept-Encoding')
  })

  it('passes streams, errors, other types and encoded bodies through', async () => {
    const stream = new ReadableStream()
    const cases: [FakeEvent, unknown][] = [
      [fakeEvent({ 'accept-encoding': 'br' }, { 'content-type': 'text/event-stream' }), stream],
      [fakeEvent({ 'accept-encoding': 'br' }), new Error('boom')],
      [fakeEvent({ 'accept-encoding': 'br' }, { 'content-type': 'text/event-stream' }), html],
      [fakeEvent({ 'accept-encoding': 'br' }, { 'content-type': 'text/html', 'content-encoding': 'gzip' }), html],
      [fakeEvent({ 'accept-encoding': 'br' }), Buffer.from(html)],
    ]
    for (const [event, body] of cases) {
      const response = { body }
      await compressResponse(asEvent(event), response)
      expect(response.body).toBe(body)
      expect(event.res['content-encoding']).not.toBe('br')
    }
  })
})

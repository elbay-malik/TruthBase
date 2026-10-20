import { describe, expect, it } from 'vitest'
import { lowerModulePreloads } from '../../server/utils/preload-priority'

const head = [
  '<link nonce="n" rel="stylesheet" href="/_nuxt/entry.css" crossorigin>',
  '<link nonce="n" integrity="sha384-a" rel="modulepreload" as="script" crossorigin href="/_nuxt/entry.js">',
  '<link nonce="n" integrity="sha384-b" rel="modulepreload" as="script" crossorigin href="/_nuxt/page.js">',
  '<link nonce="n" rel="prefetch" as="script" crossorigin href="/_nuxt/later.js">',
  '<script nonce="n" type="module" src="/_nuxt/entry.js" crossorigin></script>',
].join('')

describe('lowerModulePreloads', () => {
  const out = lowerModulePreloads(head)

  it('lowers the page chunks, keeping their other attributes', () => {
    expect(out).toContain('<link nonce="n" integrity="sha384-b" rel="modulepreload" fetchpriority="low" as="script" crossorigin href="/_nuxt/page.js">')
  })

  it('leaves the entry module, stylesheets and prefetches alone', () => {
    expect(out).toContain('rel="modulepreload" as="script" crossorigin href="/_nuxt/entry.js"')
    expect(out.match(/fetchpriority/g)).toHaveLength(1)
  })

  it('does not add a second fetchpriority', () => {
    expect(lowerModulePreloads(out)).toBe(out)
  })
})

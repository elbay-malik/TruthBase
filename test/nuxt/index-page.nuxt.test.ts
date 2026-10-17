import { describe, expect, it } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import IndexPage from '~/pages/index.vue'

registerEndpoint('/api/documents', () => [
  { id: '0b2a3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d', filename: 'nist-csf-2.0.pdf', pageCount: 32 },
])

describe('index page', () => {
  it('renders the chat with example questions and the question box', async () => {
    const page = await mountSuspended(IndexPage)
    expect(page.text()).toContain('TruthBase')
    expect(page.text()).toContain('What are the six Functions of the NIST CSF 2.0?')
    expect(page.find('textarea[aria-label="Question"]').exists()).toBe(true)
  })
})

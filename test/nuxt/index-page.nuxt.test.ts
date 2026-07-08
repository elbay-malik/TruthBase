import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import IndexPage from '~/pages/index.vue'

describe('index page', () => {
  it('renders the project name and phase status', async () => {
    const page = await mountSuspended(IndexPage)
    expect(page.text()).toContain('TruthBase')
    expect(page.text()).toContain('Phase 1')
  })
})

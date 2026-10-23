import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import type { NuxtError } from '#app'
import ErrorPage from '~/error.vue'

const mountError = (statusCode: number, message: string) =>
  mountSuspended(ErrorPage, { props: { error: { statusCode, message } as NuxtError } })
const buttons = (page: Awaited<ReturnType<typeof mountError>>) =>
  page.findAll('a, button').map(b => b.text())

describe('error page', () => {
  it('names a missing page and links to the start page, without echoing the address', async () => {
    const page = await mountError(404, 'Page not found: /<i>no-such-page</i>')
    expect(page.find('h1').text()).toBe('Page not found')
    expect(page.text()).toContain('There is no page at this address. Questions are asked on the start page.')
    expect(page.text()).not.toContain('no-such-page')
    expect(page.find('a[href="/"]').text()).toBe('Go to the start page')
    expect(buttons(page)).toEqual(['Go to the start page'])
    // The wordmark is not a second heading.
    expect(page.findAll('h1, h2')).toHaveLength(1)
  })

  it('offers Try again for a server error and never shows its message', async () => {
    const page = await mountError(500, 'connect ECONNREFUSED 10.0.0.5:5432')
    expect(page.find('h1').text()).toBe('Page failed to load')
    expect(page.text()).toContain('TruthBase couldn’t load this page (error 500).')
    expect(page.text()).not.toContain('ECONNREFUSED')
    expect(buttons(page)).toEqual(['Try again', 'Go to the start page'])
  })

  it('turns down other requests with their status code', async () => {
    const page = await mountError(400, 'Bad Request')
    expect(page.find('h1').text()).toBe('Request not accepted')
    expect(page.text()).toContain('(error 400)')
    expect(buttons(page)).toEqual(['Go to the start page'])
  })
})

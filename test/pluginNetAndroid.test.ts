import { describe, expect, it, vi } from 'vitest'

// The Android app: no forum proxy on localhost:7071, the forum asked through the app instead.
const forumProxyFetch = vi.fn(async () => new Response('{"topics":[]}'))
const nativeFetch = vi.fn(async () => new Response('ok'))
vi.mock('~/lib/android/detect', () => ({ isAndroidApp: true, devPhoneLayout: false }))
vi.mock('~/lib/android/net', () => ({ forumProxyFetch, nativeFetch }))

const { pluginFetch } = await import('../src/plugins/net')

describe('plugin fetch in the Android app', () => {
  it('asks the forum through the app for the forum proxy, and anything else natively', async () => {
    await pluginFetch('http://localhost:7071/search.json?q=clip', { headers: { Accept: 'application/json' } })
    expect(forumProxyFetch).toHaveBeenCalledWith('http://localhost:7071/search.json?q=clip', expect.objectContaining({ headers: { accept: 'application/json' } }))
    await pluginFetch('https://example.com/a.json')
    await pluginFetch('http://localhost:7071/t/1.json', { method: 'POST', body: 'x' })
    expect(nativeFetch).toHaveBeenCalledTimes(2)
    expect(forumProxyFetch).toHaveBeenCalledTimes(1)
  })
})

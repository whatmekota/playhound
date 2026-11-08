import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { clipRect, occlude, occluded, overlaps } from '~/lib/occluders'
import { accessOf, allows, PERMISSIONS, readManifest } from '~/plugins/manifest'
import { MAX_WEBVIEWS, placementFor, webUrl } from '~/plugins/webview'
import { forwardedKey, isAdHost, webUrl as mainWebUrl, MAX_VIEWS, permissionAllowed, plainUserAgent, popupAction, sameSite, scaleRect, siteOf } from '../desktop/webviewRules.mjs'

describe('web view rules (main process)', () => {
  it('scales a CSS rect by the page zoom, rounding edges and keeping it in the window', () => {
    expect(scaleRect({ x: 10, y: 20, width: 100, height: 50 }, 1)).toEqual({ x: 10, y: 20, width: 100, height: 50 })
    expect(scaleRect({ x: 10, y: 20, width: 100, height: 50 }, 1.25)).toEqual({ x: 13, y: 25, width: 125, height: 63 })
    // Two views side by side at an odd zoom still meet exactly.
    const a = scaleRect({ x: 0, y: 0, width: 100.3, height: 10 }, 1.1)!
    const b = scaleRect({ x: 100.3, y: 0, width: 100, height: 10 }, 1.1)!
    expect(a.x + a.width).toBe(b.x)
    expect(scaleRect({ x: -20, y: 10, width: 100, height: 100 }, 1, { width: 50, height: 60 })).toEqual({ x: 0, y: 10, width: 50, height: 50 })
  })

  it('gives nothing for a rect with nothing left to show, or a bad one', () => {
    expect(scaleRect({ x: 0, y: 0, width: 0, height: 10 }, 1)).toBeNull()
    expect(scaleRect({ x: 500, y: 0, width: 10, height: 10 }, 1, { width: 400, height: 400 })).toBeNull()
    expect(scaleRect({ x: Number.NaN, y: 0, width: 10, height: 10 }, 1)).toBeNull()
    expect(scaleRect({ x: 0, y: 0, width: 10, height: 10 }, 0)).toBeNull()
    expect(scaleRect(null as any, 1)).toBeNull()
  })

  it('loads web pages only', () => {
    for (const ok of ['https://example.com', 'http://127.0.0.1:8080/x?y#z'])
      expect(mainWebUrl(ok)).toBe(new URL(ok).href)
    for (const bad of ['file:///C:/x', 'javascript:alert(1)', 'data:text/html,hi', 'chrome://gpu', 'about:blank', 'magnet:?xt=1', 'example.com', ''])
      expect(mainWebUrl(bad)).toBeNull()
    // The page's copy holds to the same rules.
    expect(webUrl('https://example.com')).toBe('https://example.com/')
    expect(webUrl('file:///etc/passwd')).toBeNull()
  })

  it('grants a page full screen and the clipboard, and nothing else', () => {
    expect(permissionAllowed('fullscreen')).toBe(true)
    expect(permissionAllowed('clipboard-sanitized-write')).toBe(true)
    for (const p of ['media', 'geolocation', 'notifications', 'midi', 'midiSysex', 'openExternal', 'pointerLock', 'clipboard-read', 'hid', 'serial', 'usb', 'display-capture', 'window-management'])
      expect(permissionAllowed(p)).toBe(false)
  })

  it('opens new windows in the same view, and drops pop-unders and non-web ones', () => {
    expect(popupAction({ url: 'https://a.example/', disposition: 'foreground-tab' })).toBe('same-view')
    expect(popupAction({ url: 'https://a.example/', disposition: 'new-window' })).toBe('same-view')
    expect(popupAction({ url: 'https://ads.example/', disposition: 'background-tab' })).toBe('drop')
    expect(popupAction({ url: 'mailto:x@y.z', disposition: 'foreground-tab' })).toBe('drop')
  })

  it('follows a pop-up only on the same site, never to an ad network', () => {
    const from = 'https://www.tube.example/video/123'
    expect(popupAction({ url: 'https://tube.example/video/456', disposition: 'foreground-tab' }, from)).toBe('same-view')
    expect(popupAction({ url: 'https://cdn.tube.example/x', disposition: 'new-window' }, from)).toBe('same-view')
    // A pop-under: a click anywhere opens another site.
    expect(popupAction({ url: 'https://casino.example/win', disposition: 'foreground-tab' }, from)).toBe('drop')
    expect(popupAction({ url: 'https://syndication.exoclick.com/x', disposition: 'foreground-tab' })).toBe('drop')
  })

  it('knows ad networks by domain, subdomains included, and nothing else', () => {
    expect(isAdHost('syndication.exoclick.com')).toBe(true)
    expect(isAdHost('a.realsrv.com')).toBe(true)
    expect(isAdHost('ads.trafficjunky.net')).toBe(true)
    expect(isAdHost('securepubads.g.doubleclick.net')).toBe(true)
    expect(isAdHost('pmvhaven.com')).toBe(false)
    expect(isAdHost('notexoclick.com')).toBe(false)
    expect(isAdHost('exoclick.com.evil.example')).toBe(false)
  })

  it('names the site of a host', () => {
    expect(siteOf('www.example.com')).toBe('example.com')
    expect(siteOf('a.b.example.co.uk')).toBe('example.co.uk')
    expect(siteOf('localhost')).toBe('localhost')
    expect(sameSite('cdn.example.com', 'https://www.example.com/page')).toBe(true)
    expect(sameSite('example.org', 'https://example.com/')).toBe(false)
  })

  it('takes panic and the palette back from a page, and leaves other keys to it', () => {
    const key = (o: object) => forwardedKey({ type: 'keyDown', ...o })
    expect(key({ code: 'Escape' })).toBe('Escape')
    expect(key({ code: 'Backquote' })).toBe('Backquote')
    expect(key({ code: 'KeyK', control: true })).toBe('KeyK')
    expect(key({ code: 'KeyK', meta: true })).toBe('KeyK')
    expect(key({ code: 'KeyK' })).toBeNull()
    expect(key({ code: 'Backquote', shift: true })).toBeNull()
    expect(key({ code: 'Escape', alt: true })).toBeNull()
    expect(key({ code: 'Space' })).toBeNull()
    expect(forwardedKey({ type: 'keyUp', code: 'Escape' })).toBeNull()
    expect(key({ code: 'Escape', isAutoRepeat: true })).toBeNull()
  })

  it('shows sites plain Chrome', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) playhound/1.6.0 Chrome/140.0.0.0 Electron/44.9.3 Safari/537.36'
    expect(plainUserAgent(ua)).toBe('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36')
  })

  it('holds the page and the main process to the same number of views', () => {
    expect(MAX_WEBVIEWS).toBe(MAX_VIEWS)
  })
})

describe('the "web" permission', () => {
  const base = { id: 'web-demo', name: 'Web demo', version: '1.0.0', api: 2 }
  it('is known, said plainly, and only given to a plugin that asks', () => {
    expect(PERMISSIONS.find(p => p.id === 'web')?.label).toBe('Open web pages inside playhound')
    expect(readManifest({ ...base, permissions: ['stage', 'web'] }).permissions).toEqual(['stage', 'web'])
    expect(allows(accessOf(readManifest({ ...base, permissions: ['web'] })), 'web')).toBe(true)
    expect(allows(accessOf(readManifest({ ...base, permissions: ['stage'] })), 'web')).toBe(false)
    expect(allows(accessOf(readManifest(base)), 'web')).toBe(false)
    // A plugin from before permissions has everything, this included.
    expect(allows(accessOf(readManifest({ ...base, api: 1 })), 'web')).toBe(true)
  })
})

describe('placing a web view', () => {
  const viewport = { x: 0, y: 0, width: 1000, height: 700 }
  const never = () => false

  it('cuts the box to the window', () => {
    expect(clipRect({ x: -10, y: 650, width: 100, height: 100 }, viewport)).toEqual({ x: 0, y: 650, width: 90, height: 50 })
    expect(clipRect({ x: 1200, y: 0, width: 100, height: 100 }, viewport)).toBeNull()
    expect(placementFor({ box: { x: 100, y: 50, width: 600, height: 400 }, viewport, panicked: false, covered: never, radius: 8 }))
      .toEqual({ x: 100, y: 50, width: 600, height: 400, radius: 8 })
  })

  it('hides on panic, without a box, and when something is over it', () => {
    const box = { x: 100, y: 50, width: 600, height: 400 }
    expect(placementFor({ box, viewport, panicked: true, covered: never })).toBeNull()
    expect(placementFor({ box: null, viewport, panicked: false, covered: never })).toBeNull()
    expect(placementFor({ box, viewport, panicked: false, covered: () => true })).toBeNull()
  })

  it('knows when a layer is over it', () => {
    expect(overlaps({ x: 0, y: 0, width: 10, height: 10 }, { x: 9, y: 9, width: 5, height: 5 })).toBe(true)
    expect(overlaps({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 5, height: 5 })).toBe(false)
    const r = { x: 100, y: 100, width: 200, height: 200 }
    expect(occluded(r)).toBe(false)
    const menu = document.createElement('div')
    document.body.append(menu)
    menu.getBoundingClientRect = () => ({ left: 400, top: 100, width: 50, height: 50, right: 450, bottom: 150, x: 400, y: 100, toJSON: () => ({}) })
    const closeMenu = occlude(() => menu)
    // A menu beside it doesn't hide it…
    expect(occluded(r)).toBe(false)
    menu.getBoundingClientRect = () => ({ left: 250, top: 100, width: 100, height: 50, right: 350, bottom: 150, x: 250, y: 100, toJSON: () => ({}) })
    // …one that moved over it does.
    expect(occluded(r)).toBe(true)
    closeMenu()
    expect(occluded(r)).toBe(false)
    const closeDialog = occlude('full')
    expect(occluded(r)).toBe(true)
    closeDialog()
    menu.remove()
  })
})

describe('web views in the page', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.resetModules()
  })
  afterEach(() => {
    delete (globalThis as any).playhoundDesktop
  })

  it('needs the desktop app', async () => {
    const { createWebview } = await import('~/plugins/webview')
    expect(() => createWebview('demo')).toThrow('desktop app')
  })

  it('follows its element, hides for dialogs and panic, and closes', async () => {
    const calls: unknown[][] = []
    let onState: (id: number, p: object) => void = () => {}
    const web = {
      create: async () => ({ id: 7 }),
      destroy: (id: number) => calls.push(['destroy', id]),
      layout: (id: number, rect: unknown) => calls.push(['layout', id, rect]),
      nav: (id: number, action: string, arg?: unknown) => calls.push(['nav', id, action, arg]),
      panic: (on: boolean) => calls.push(['panic', on]),
      onState: (cb: typeof onState) => {
        onState = cb
        return () => {}
      },
      onKey: () => () => {},
      onActivity: () => () => {},
    }
    ;(globalThis as any).playhoundDesktop = { web, platform: 'win32' }
    ;(globalThis as any).ResizeObserver ??= class { observe() {} disconnect() {} }
    const { createWebview } = await import('~/plugins/webview')
    const { occlude } = await import('~/lib/occluders')
    const { useSafetyStore } = await import('~/stores/safetyStore')
    setActivePinia(createPinia())

    const view = createWebview('demo', { url: 'https://example.com/' })
    expect(() => view.navigate('file:///C:/secret.txt')).toThrow('isn\'t a web address')
    const el = document.createElement('div')
    document.body.append(el)
    el.getBoundingClientRect = () => ({ left: 60, top: 40, width: 500, height: 300, right: 560, bottom: 340, x: 60, y: 40, toJSON: () => ({}) })
    view.attach(el)
    await new Promise(r => setTimeout(r, 0))
    // Asked for before the view existed, done once it does.
    expect(calls).toContainEqual(['nav', 7, 'load', 'https://example.com/'])
    expect(calls).toContainEqual(['layout', 7, { x: 60, y: 40, width: 500, height: 300, radius: 0 }])
    expect(view.state().shown).toBe(true)

    const seen: string[] = []
    view.onState(s => seen.push(s.title))
    onState(7, { title: 'Example Domain', url: 'https://example.com/' })
    expect(view.state()).toMatchObject({ title: 'Example Domain', url: 'https://example.com/' })
    expect(seen).toEqual(['Example Domain'])

    calls.length = 0
    const close = occlude('full')
    await nextTick()
    expect(calls).toContainEqual(['layout', 7, null])
    expect(view.state().shown).toBe(false)
    close()
    await nextTick()
    expect(calls.at(-1)).toEqual(['layout', 7, { x: 60, y: 40, width: 500, height: 300, radius: 0 }])

    calls.length = 0
    useSafetyStore().panicked = true
    expect(calls).toEqual([['panic', true], ['layout', 7, null]])
    useSafetyStore().panicked = false
    expect(calls).toContainEqual(['panic', false])
    // Back where it was on the next frame.
    await new Promise(r => setTimeout(r, 50))
    expect(calls.at(-1)).toEqual(['layout', 7, { x: 60, y: 40, width: 500, height: 300, radius: 0 }])

    // Its element leaving the page hides it.
    calls.length = 0
    el.remove()
    view.attach(el)
    expect(calls).toEqual([['layout', 7, null]])

    view.destroy()
    expect(calls.at(-1)).toEqual(['destroy', 7])
    expect(view.destroyed).toBe(true)
    expect(() => view.navigate('https://example.com/')).toThrow('destroyed')
  })

  it('holds to the most views at once', async () => {
    ;(globalThis as any).playhoundDesktop = { web: { create: () => new Promise(() => {}), destroy() {}, layout() {}, nav() {}, panic() {}, onState: () => () => {}, onKey: () => () => {}, onActivity: () => () => {} } }
    const { createWebview, MAX_WEBVIEWS } = await import('~/plugins/webview')
    const views = Array.from({ length: MAX_WEBVIEWS }, () => createWebview('demo'))
    expect(() => createWebview('demo')).toThrow(`Only ${MAX_WEBVIEWS}`)
    views[0].destroy()
    expect(() => createWebview('demo')).not.toThrow()
  })
})

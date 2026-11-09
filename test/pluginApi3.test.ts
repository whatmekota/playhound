import type { PluginContext } from '~/plugins/types'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { parseRange, requestFor, responseOf, routeOf } from '~/plugins/http'
import { readManifest } from '~/plugins/manifest'
import { cleanProvided, cleanProvidedList, entryOf, providedName } from '~/plugins/provider'
import { clampLimit, pluginTarget, RAMP_DOWN_PER_SEC, RAMP_UP_PER_SEC, rampStep } from '~/plugins/session'
import { allowedAddresses, checkHost, isPrivateAddress, portOf } from '../desktop/lanRules.mjs'

// jsdom has no IndexedDB; the plugin store only touches it to install and read settings.
vi.mock('~/lib/idb', async (orig) => {
  const real = await orig<typeof import('~/lib/idb')>()
  const none = { get: async () => undefined, set: async () => {}, del: async () => {}, keys: async () => [], all: async () => ({}), getList: async () => undefined, setList: async () => {} }
  return { ...real, pluginDb: none, summaryDb: none, metaDb: none, handleDb: none, videoMetaDb: none }
})

describe('sockets reach this computer and the local network only', () => {
  it('knows private addresses', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.20', '169.254.10.1', '::1', 'fe80::1', 'fe80::1%eth0', 'fd12:3456::1', '::ffff:192.168.0.5', '[::1]'])
      expect(isPrivateAddress(a), a).toBe(true)
    for (const a of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '192.169.0.1', '100.64.0.1', '0.0.0.0', '2001:4860::8888', '::ffff:8.8.8.8', 'example.com', '', null])
      expect(isPrivateAddress(a), String(a)).toBe(false)
  })

  it('takes localhost, private addresses and .local names, and nothing else', () => {
    expect(checkHost('localhost')).toEqual({ ok: true, address: '127.0.0.1' })
    expect(checkHost('192.168.1.50')).toEqual({ ok: true, address: '192.168.1.50' })
    expect(checkHost('Quest-3.local')).toEqual({ ok: true, lookup: true })
    expect(checkHost('8.8.8.8')).toMatchObject({ ok: false, reason: expect.stringContaining('not on your network') })
    expect(checkHost('heresphere.example.com')).toMatchObject({ ok: false })
    expect(checkHost('quest')).toMatchObject({ ok: false })
    expect(checkHost('evil.local.example.com')).toMatchObject({ ok: false })
    expect(checkHost('')).toMatchObject({ ok: false })
    expect(checkHost(42)).toMatchObject({ ok: false })
  })

  it('refuses a .local name that leads anywhere outside', () => {
    expect(allowedAddresses([{ address: '192.168.1.9', family: 4 }])).toEqual(['192.168.1.9'])
    expect(allowedAddresses([{ address: '192.168.1.9', family: 4 }, { address: '8.8.8.8', family: 4 }])).toBeNull()
    expect(allowedAddresses([])).toBeNull()
  })

  it('takes a real port only', () => {
    expect(portOf(23554)).toBe(23554)
    expect(portOf(0)).toBeNull()
    expect(portOf(70000)).toBeNull()
    expect(portOf('23554')).toBeNull()
    expect(portOf(1.5)).toBeNull()
  })
})

describe('serving on the LAN', () => {
  it('routes a plugin\'s own paths and shared files, nothing else', () => {
    expect(routeOf('/plugins/heresphere/library.json')).toEqual({ kind: 'plugin', id: 'heresphere', path: '/library.json' })
    expect(routeOf('/plugins/heresphere')).toEqual({ kind: 'plugin', id: 'heresphere', path: '/' })
    expect(routeOf('/ph-files/abcdefghijklmnopqrstuvwx/clip.mp4')).toEqual({ kind: 'file', token: 'abcdefghijklmnopqrstuvwx' })
    expect(routeOf('/ph-files/short')).toBeNull()
    expect(routeOf('/plugins/Bad_Id/x')).toBeNull()
    expect(routeOf('/assets/index.js')).toBeNull()
    expect(routeOf('/')).toBeNull()
  })

  it('reads Range headers the way video players send them', () => {
    expect(parseRange(null, 1000)).toBeNull()
    expect(parseRange('bytes=0-', 1000)).toEqual({ start: 0, end: 999 })
    expect(parseRange('bytes=100-199', 1000)).toEqual({ start: 100, end: 199 })
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=0-1, 5-6', 1000)).toEqual({ start: 0, end: 1 })
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable')
    expect(parseRange('bytes=50-10', 1000)).toBe('unsatisfiable')
    expect(parseRange('items=0-5', 1000)).toBeNull()
  })

  it('turns a handler\'s answer into a response, or says what is wrong with it', async () => {
    const json = responseOf({ json: { ok: 1 } })
    expect(json.status).toBe(200)
    expect(json.headers).toContainEqual(['Content-Type', 'application/json; charset=utf-8'])
    expect(new TextDecoder().decode(json.body as Uint8Array)).toBe('{"ok":1}')
    expect(responseOf(undefined).status).toBe(404)
    expect(responseOf({ status: 302, headers: { 'Location': '/x', 'Bad Header': 'y' } }).headers).toEqual([['Location', '/x'], ['Content-Type', 'text/plain; charset=utf-8']])
    expect(() => responseOf({ status: 99 })).toThrow('status')
    expect(() => responseOf({ body: 42 as unknown as string })).toThrow('body')
    expect(() => responseOf('hi')).toThrow()
  })

  it('hands the plugin its request after its prefix, with the query and lower-case headers', () => {
    const req = requestFor({ method: 'POST', url: '/plugins/x/api?a=1&b=two', headers: [['Content-Type', 'application/json']], body: new TextEncoder().encode('{"n":3}'), remote: '192.168.1.7' }, '/api')
    expect(req).toMatchObject({ method: 'POST', path: '/api', query: { a: '1', b: 'two' }, headers: { 'content-type': 'application/json' }, remote: '192.168.1.7' })
    expect(req.json()).toEqual({ n: 3 })
  })
})

describe('library sources', () => {
  const ok = { id: 12, title: ' Scene ', url: 'http://stash.local:9999/scene/12/stream' }

  it('takes a well-formed video, tidied', () => {
    const v = cleanProvided({
      ...ok,
      scripts: [{ url: 'http://stash.local:9999/scene/12/funscript' }, { axis: 'R0', url: 'http://stash.local:9999/s.twist.funscript' }, { axis: 'L0', url: 'http://x/dup.funscript' }],
      tags: ['POV', ' pov', 3],
      chapters: [{ name: 'B', start: 60 }, { name: 'A', start: 0, end: 30 }, { name: '', start: 5 }, { name: 'bad', start: -1 }],
      thumbnail: 'data:image/jpeg;base64,AAAA',
      duration: 600,
      headers: { 'ApiKey': 'k', 'Bad Header': 'x' },
    })
    expect(v).toMatchObject({
      id: '12',
      title: 'Scene',
      kind: 'file',
      hasScript: true,
      // One per axis, the first wins.
      scripts: [{ axis: 'default', url: 'http://stash.local:9999/scene/12/funscript' }, { axis: 'r0', url: 'http://stash.local:9999/s.twist.funscript' }],
      tags: ['pov'],
      chapters: [{ name: 'A', start: 0, end: 30 }, { name: 'B', start: 60 }],
      thumbnail: 'data:image/jpeg;base64,AAAA',
      duration: 600,
      headers: { ApiKey: 'k' },
    })
    expect(cleanProvided({ ...ok, url: 'https://cdn.example.com/x/master.m3u8?t=1' })).toMatchObject({ kind: 'hls', hasScript: false })
  })

  it('says why a video can\'t be used', () => {
    const why = (v: unknown) => (cleanProvided(v) as { error?: string }).error
    expect(why(null)).toBe('not an object')
    expect(why({ ...ok, id: '' })).toMatch('"id"')
    expect(why({ ...ok, title: '  ' })).toMatch('"title"')
    expect(why({ ...ok, url: 'file:///C:/secret.mp4' })).toMatch('"url"')
    expect(why({ ...ok, url: 'javascript:alert(1)' })).toMatch('"url"')
    expect(why({ ...ok, scripts: 'x' })).toMatch('"scripts"')
    expect(why({ ...ok, scripts: [{ axis: 'X9', url: 'http://a/b' }] })).toMatch('X9')
    expect(why({ ...ok, scripts: [{ url: 'ftp://a/b' }] })).toMatch('http')
    // Not a picture: dropped, the video stays.
    expect(cleanProvided({ ...ok, thumbnail: 'javascript:1', sourceUrl: 'nope' })).toMatchObject({ thumbnail: null, sourceUrl: null })
  })

  it('counts scripts from a loader only when the source has one', () => {
    expect(cleanProvided({ ...ok, hasScript: true })).toMatchObject({ hasScript: false })
    expect(cleanProvided({ ...ok, hasScript: true }, { loader: true })).toMatchObject({ hasScript: true })
  })

  it('checks a whole list: each id once, the rest explained', () => {
    const { videos, errors } = cleanProvidedList([ok, { ...ok, title: 'again' }, { id: 2 }, { ...ok, id: 3 }])
    expect(videos.map(v => v.id)).toEqual(['12', '3'])
    expect(errors).toHaveLength(2)
    expect(cleanProvidedList('nope').errors[0]).toMatch('list')
  })

  it('makes a library entry with no file, under the source\'s name', () => {
    const v = cleanProvided({ ...ok, tags: ['solo'], sourceUrl: 'http://stash.local:9999/scenes/12' })
    if ('error' in v)
      throw new Error(v.error)
    const e = entryOf(v, 'stash', 'Stash')
    expect(e).toMatchObject({ name: providedName('stash', '12'), basename: 'Scene', folder: 'Stash', path: 'Stash/Scene', hasScript: false, scriptMeta: { tags: ['solo'], url: 'http://stash.local:9999/scenes/12' } })
    expect(e.file.size).toBe(0)
    expect(e.remote).toMatchObject({ owner: 'stash', label: 'Stash', id: '12', url: ok.url })
  })
})

describe('plugins and the intensity knob', () => {
  it('holds a plugin to the user\'s limit and the knob\'s range', () => {
    expect(pluginTarget(1, 0.8)).toBe(0.8)
    expect(pluginTarget(0.55, 0.8)).toBe(0.55)
    expect(pluginTarget(0, 0.8)).toBe(0.1)
    expect(pluginTarget(Number.NaN, 0.8)).toBeNull()
    expect(pluginTarget('1', 0.8)).toBeNull()
    expect(clampLimit(5)).toBe(1)
    expect(clampLimit('x')).toBe(0.8)
  })

  it('ramps, never jumps: slowly up, quicker down', () => {
    expect(rampStep(0.3, 0.8, 1000)).toBeCloseTo(0.3 + RAMP_UP_PER_SEC)
    expect(rampStep(0.8, 0.3, 1000)).toBeCloseTo(0.8 - RAMP_DOWN_PER_SEC)
    expect(rampStep(0.75, 0.8, 1000)).toBe(0.8)
    // Short steps add up.
    let v = 0.3
    for (let i = 0; i < 25; i++)
      v = rampStep(v, 0.8, 40)
    expect(v).toBeCloseTo(0.4)
  })
})

describe('the API holds a plugin to its permissions', () => {
  let stop: (() => void) | null = null
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })
  afterEach(() => {
    stop?.()
    stop = null
  })

  async function contextWith(permissions: string[]): Promise<PluginContext> {
    const { usePluginStore } = await import('~/stores/pluginStore')
    const c = usePluginStore().contextFor(readManifest({ id: 'demo', name: 'Demo', version: '1.0.0', api: 3, permissions }))
    stop = c.stop
    return c.ctx
  }

  it('refuses every API 3 call it didn\'t ask for, naming the permission', async () => {
    const ctx = await contextWith([])
    const calls: [() => unknown, string][] = [
      [() => ctx.playback.external({ label: 'HereSphere' }), 'external'],
      [() => ctx.net.socket({ host: 'localhost', port: 23554 }), 'socket'],
      [() => ctx.http.serve(() => null), 'serve'],
      [() => ctx.http.stop(), 'serve'],
      [() => ctx.library.provide({ label: 'Stash', videos: () => [] }), 'library-source'],
      [() => ctx.library.mediaUrl('x.mp4'), 'serve'],
      [() => ctx.library.scriptUrl('x.mp4'), 'serve'],
      [() => ctx.session.edge(), 'session'],
      [() => ctx.session.endEdge(), 'session'],
      [() => ctx.session.intensity.set(0.5), 'session'],
    ]
    for (const [call, p] of calls)
      expect(call, p).toThrow(`"${p}" permission`)
    // Reading the edge and the knob: player or session.
    for (const read of [() => ctx.session.edgeState(), () => ctx.session.onEdge(() => {}), () => ctx.session.onFinish(() => {}), () => ctx.session.intensity.get(), () => ctx.session.intensity.max(), () => ctx.session.intensity.onChange(() => {})])
      expect(read).toThrow('"player" or the "session"')
    // Sharing a library video needs to read the library too.
    const serveOnly = await contextWith(['serve'])
    expect(() => serveOnly.library.mediaUrl('x.mp4')).toThrow('"library" permission')
  })

  it('lets through what it asked for', async () => {
    const ctx = await contextWith(['session', 'socket', 'serve', 'library'])
    expect(ctx.session.intensity.max()).toBe(0.8)
    // Asked for more than the user allows plugins: held to the limit.
    expect(ctx.session.intensity.set(1)).toBe(0.8)
    expect(ctx.session.edgeState()).toMatchObject({ phase: 'idle', effective: 1 })
    // Past the permission, the desktop app is what's missing here.
    expect(ctx.net.socketAvailable).toBe(false)
    await expect(ctx.net.socket({ host: 'localhost', port: 23554 })).rejects.toThrow('desktop app')
    expect(ctx.http.available).toBe(false)
    await expect(ctx.http.serve(() => null)).rejects.toThrow('desktop app')
    // No such video: nothing to share.
    expect(await ctx.library.mediaUrl('nope.mp4')).toBeNull()
    const reader = await contextWith(['player'])
    expect(reader.session.intensity.get()).toBe(1)
  })

  it('lowers the knob at once in a panic, never raises it, and restores the user\'s own level past the limit', async () => {
    vi.useFakeTimers()
    try {
      const ctx = await contextWith(['session'])
      const { useSessionControlStore } = await import('~/stores/sessionControlStore')
      const { useSafetyStore } = await import('~/stores/safetyStore')
      const control = useSessionControlStore()
      const safety = useSafetyStore()
      // The user had it at 100%; the plugin brings it down to 50%.
      control.setIntensityScale(1)
      ctx.session.intensity.set(0.5)
      await vi.advanceTimersByTimeAsync(4000)
      expect(control.intensityScale).toBeCloseTo(0.5)
      // Restore goes back to the user's 100%, past the plugin limit (80%).
      expect(ctx.session.intensity.restore()).toBe(1)
      await vi.advanceTimersByTimeAsync(8000)
      expect(control.intensityScale).toBeCloseTo(1)
      // Nothing to restore now.
      expect(ctx.session.intensity.restore()).toBeNull()

      // Moved again and again mid-ramp (a slider dragged), then restored mid-ramp:
      // still the user's own level, not wherever the ramp happened to be.
      control.setIntensityScale(0.4)
      ctx.session.intensity.set(0.5)
      await vi.advanceTimersByTimeAsync(300)
      ctx.session.intensity.set(0.6)
      await vi.advanceTimersByTimeAsync(300)
      ctx.session.intensity.set(0.7)
      await vi.advanceTimersByTimeAsync(300)
      expect(ctx.session.intensity.restore()).toBe(0.4)
      await vi.advanceTimersByTimeAsync(200)
      // A set() while it eases back, then restore again: the user's level still.
      ctx.session.intensity.set(0.65)
      await vi.advanceTimersByTimeAsync(300)
      expect(ctx.session.intensity.restore()).toBe(0.4)
      await vi.advanceTimersByTimeAsync(8000)
      expect(control.intensityScale).toBeCloseTo(0.4)
      expect(ctx.session.intensity.restore()).toBeNull()

      // In a panic: down at once, up not at all.
      control.setIntensityScale(0.6)
      safety.panicked = true
      expect(ctx.session.intensity.set(0.3)).toBeCloseTo(0.3)
      expect(control.intensityScale).toBeCloseTo(0.3)
      expect(ctx.session.intensity.set(0.7)).toBeCloseTo(0.3)

      // The user turning the knob after the plugin makes it theirs: no restore.
      safety.panicked = false
      ctx.session.intensity.restore()
      control.setIntensityScale(0.6)
      ctx.session.intensity.set(0.4)
      control.setIntensityScale(0.9)
      expect(ctx.session.intensity.restore()).toBeNull()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('tells a plugin when panic is lifted, and when a script holds the stroke', async () => {
    const ctx = await contextWith(['player'])
    const { useSafetyStore } = await import('~/stores/safetyStore')
    const safety = useSafetyStore()
    const seen: string[] = []
    ctx.safety.onPanic(() => seen.push('panic'))
    ctx.safety.onResume(() => seen.push('resume'))
    safety.panicked = true
    await nextTick()
    safety.panicked = false
    await nextTick()
    expect(seen).toEqual(['panic', 'resume'])
    expect(ctx.motion.readout().scriptDriving).toBe(false)
  })

  it('follows a video playing elsewhere: the player and the device take its clock, panic stops the device', async () => {
    const ctx = await contextWith(['external'])
    const { usePlaybackStore } = await import('~/stores/playbackStore')
    const { usePlayerStore } = await import('~/stores/playerStore')
    const { useSafetyStore } = await import('~/stores/safetyStore')
    const playback = usePlaybackStore()
    const player = usePlayerStore()
    const commands: unknown[] = []
    // Nothing to play to its clock: refused.
    expect(await ctx.playback.external({ label: 'HereSphere', video: 'not-there.mp4' })).toBeNull()
    const ext = await ctx.playback.external({
      label: 'HereSphere',
      title: 'Clip',
      scripts: [{ actions: [{ at: 0, pos: 0 }, { at: 500, pos: 100 }, { at: 1000, pos: 0 }] }],
      onCommand: c => commands.push(c),
    })
    expect(ext).not.toBeNull()
    expect(player.videoKind).toBe('external')
    expect(playback.external?.label).toBe('HereSphere')
    const events: string[] = []
    playback.external!.onEvent(e => events.push(e))
    ext!.update({ time: 12, playing: true, duration: 60 })
    expect(player.isPlaying).toBe(true)
    expect(player.currentTime).toBeCloseTo(12, 1)
    expect(player.videoDuration).toBe(60)
    expect(playback.external!.media.paused).toBe(false)
    // playhound's own controls go to the other app.
    playback.togglePlay()
    playback.seek(30)
    expect(commands).toEqual([{ type: 'pause' }, { type: 'seek', time: 30 }])
    // Panic: the device stops following at once, whatever the other app does.
    useSafetyStore().panicked = true
    expect(playback.external!.media.paused).toBe(true)
    ext!.update({ time: 12.01, playing: true })
    expect(playback.external!.media.paused).toBe(true)
    useSafetyStore().panicked = false
    ext!.update({ time: 12.02, playing: true })
    expect(events).toEqual(['play', 'pause', 'play'])
    const ended: string[] = []
    ext!.onEnd(r => ended.push(r))
    ext!.end()
    expect(ended).toEqual(['ended'])
    expect(ext!.active).toBe(false)
    expect(playback.external).toBeNull()
    expect(player.videoUrl).toBe('')
    // Switched off, the plugin's session stops being followed.
    await ctx.playback.external({ label: 'HereSphere', scripts: [{ actions: [{ at: 0, pos: 0 }, { at: 500, pos: 100 }] }] })
    expect(playback.external).not.toBeNull()
    stop!()
    stop = null
    expect(playback.external).toBeNull()
  })

  it('adds a source\'s videos to the library and takes them out when switched off', async () => {
    const ctx = await contextWith(['library-source'])
    const { useLibraryStore } = await import('~/stores/libraryStore')
    const lib = useLibraryStore()
    const src = await ctx.library.provide({
      label: 'Stash',
      videos: () => [
        { id: 1, title: 'One', url: 'http://192.168.1.4:9999/scene/1/stream', scripts: [{ url: 'http://192.168.1.4:9999/scene/1/funscript' }] },
        { id: 2, title: '', url: 'http://192.168.1.4:9999/scene/2/stream' },
      ],
    })
    expect(lib.videos.map(v => v.basename)).toEqual(['One'])
    expect(lib.sources).toEqual(['Stash'])
    expect(src.problems).toHaveLength(1)
    stop!()
    stop = null
    expect(lib.videos).toEqual([])
    expect(lib.sources).toEqual([])
  })
})

describe('short root paths for headsets', () => {
  it('routes /deovr and /heresphere to the plugin that holds them, and nothing else', async () => {
    const { aliasPath } = await import('../desktop/pluginhttp.mjs')
    const held = new Map([['deovr', 'phvr']])
    expect(aliasPath('/deovr', held)).toBe('/plugins/phvr/deovr')
    expect(aliasPath('/deovr/video/3', held)).toBe('/plugins/phvr/deovr/video/3')
    expect(aliasPath('/heresphere', held)).toBe('/heresphere')
    expect(aliasPath('/deovrx', held)).toBe('/deovrx')
    expect(aliasPath('/plugins/other/x', held)).toBe('/plugins/other/x')
  })
})

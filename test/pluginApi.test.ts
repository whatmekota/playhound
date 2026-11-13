import { describe, expect, it } from 'vitest'
import { signatureOf, skipName } from '~/plugins/devFolder'
import { capMove, ceilingPerMs, createFilterChain, filterActions } from '~/plugins/filters'
import { CHUNK, fingerprintOf, fingerprintRanges, fingerprintSize } from '~/plugins/fingerprint'
import { accessOf, addedPermissions, allows, PERMISSIONS, PLUGIN_API, readManifest } from '~/plugins/manifest'
import { axisKeyFor, cleanActions, snapshotOf } from '~/plugins/scripts'
import { chordId, chordOf, kbdKeys, parseKbd, reservedBy } from '~/plugins/shortcuts'
import { packageFrom } from '~/stores/pluginStore'

const base = { id: 'demo', name: 'Demo', version: '1.0.0' }

describe('manifest v2', () => {
  it('reads the api version and the permissions, in the app\'s order', () => {
    expect(readManifest(base)).toMatchObject({ api: 1, main: 'index.js' })
    expect(readManifest(base).permissions).toBeUndefined()
    const m = readManifest({ ...base, api: 2, permissions: ['network', 'device', 'network'] })
    expect(m.api).toBe(2)
    expect(m.permissions).toEqual(['device', 'network'])
  })

  it('refuses a newer api, a bad api and unknown permissions, saying why', () => {
    expect(() => readManifest({ ...base, api: PLUGIN_API + 1 })).toThrow(/newer playhound/)
    expect(() => readManifest({ ...base, api: 1.5 })).toThrow('"api"')
    expect(() => readManifest({ ...base, api: '2' })).toThrow('"api"')
    expect(() => readManifest({ ...base, permissions: 'device' })).toThrow('"permissions"')
    expect(() => readManifest({ ...base, permissions: ['device', 'camera'] })).toThrow('"camera"')
    expect(() => readManifest([])).toThrow('not an object')
  })

  it('gives an older plugin without a list full access, and anyone with a list only that', () => {
    const old = accessOf(readManifest(base))
    expect(old.full).toBe(true)
    expect(allows(old, 'device')).toBe(true)
    const none = accessOf(readManifest({ ...base, api: 2 }))
    expect(none.full).toBe(false)
    expect(allows(none, 'player')).toBe(false)
    const some = accessOf(readManifest({ ...base, api: 2, permissions: ['player'] }))
    expect(allows(some, 'player')).toBe(true)
    expect(allows(some, 'device')).toBe(false)
    // An API 1 plugin that does list them is held to its list.
    expect(allows(accessOf(readManifest({ ...base, permissions: ['stage'] })), 'network')).toBe(false)
  })

  it('says what an update asks for that the installed version did not', () => {
    const v = (permissions?: string[]) => accessOf(readManifest({ ...base, api: 2, ...(permissions ? { permissions } : {}) }))
    expect(addedPermissions(null, v(['player']))).toEqual(['player'])
    expect(addedPermissions(v(['player']), v(['player']))).toEqual([])
    expect(addedPermissions(v(['player']), v(['network', 'player']))).toEqual(['network'])
    // From full access to a list: nothing new.
    expect(addedPermissions(accessOf(readManifest(base)), v(['device']))).toEqual([])
    // From a list back to full access: everything else it covers is new.
    expect(addedPermissions(v(['device']), accessOf(readManifest(base)))).toEqual(['scripts', 'player', 'playback', 'library', 'library-edit', 'network', 'stage', 'web'])
  })

  it('speaks API 3, and keeps full access to what there was before', () => {
    expect(PLUGIN_API).toBe(4)
    expect(readManifest({ ...base, api: 3, permissions: ['serve', 'socket', 'session', 'external', 'library-source'] }).permissions)
      .toEqual(['external', 'session', 'library-source', 'socket', 'serve'])
    const old = accessOf(readManifest(base))
    expect(allows(old, 'web')).toBe(true)
    // Calls that came later have to be asked for, even by an older plugin.
    for (const p of ['external', 'session', 'library-source', 'socket', 'serve'] as const)
      expect(allows(old, p)).toBe(false)
    // So an older plugin updated to use them shows them as new.
    expect(addedPermissions(old, accessOf(readManifest({ ...base, api: 3, permissions: ['device', 'serve'] })))).toEqual(['serve'])
    // Every permission has words for the install screen.
    for (const p of PERMISSIONS)
      expect(p.label.length).toBeGreaterThan(10)
  })

  it('reads a package from a folder\'s files', () => {
    const enc = new TextEncoder()
    const m = (o: object = {}) => enc.encode(JSON.stringify({ ...base, ...o }))
    const pkg = packageFrom([{ path: 'manifest.json', data: m({ main: './dist/index.js' }) }, { path: 'dist/index.js', data: enc.encode('export default () => {}') }], 'the folder')
    expect(pkg.manifest.main).toBe('dist/index.js')
    expect(() => packageFrom([{ path: 'manifest.json', data: m() }], 'the folder')).toThrow('index.js (the plugin\'s code) is not in the folder')
  })
})

describe('plugin shortcuts', () => {
  it('reads shortcuts, by key position', () => {
    expect(parseKbd('Shift+K')).toEqual({ code: 'KeyK', ctrl: false, alt: false, shift: true })
    expect(parseKbd('ctrl + shift + y')).toEqual({ code: 'KeyY', ctrl: true, alt: false, shift: true })
    expect(parseKbd('Alt+2')).toEqual({ code: 'Digit2', ctrl: false, alt: true, shift: false })
    expect(parseKbd('F8')).toMatchObject({ code: 'F8' })
    expect(parseKbd('Shift+ArrowLeft')).toBeNull()
    expect(parseKbd('Hyper+K')).toBeNull()
    expect(parseKbd('F13')).toBeNull()
    expect(parseKbd('')).toBeNull()
    expect(parseKbd(42)).toBeNull()
    expect(kbdKeys(parseKbd('shift+alt+ctrl+q')!)).toEqual(['Ctrl', 'Alt', 'Shift', 'Q'])
  })

  it('keeps playhound\'s, the player\'s and the browser\'s keys', () => {
    const who = (s: string) => reservedBy(parseKbd(s)!)
    expect(who('E')).toBe('playhound') // edge
    expect(who('Shift+G')).toBe('playhound') // finish
    expect(who('1')).toBe('playhound') // the player view
    expect(who('F')).toBe('the player')
    expect(who('Shift+M')).toBe('the player')
    expect(who('Ctrl+C')).toBe('the browser')
    expect(who('Ctrl+Shift+I')).toBe('the browser')
    expect(who('F5')).toBe('the browser')
    expect(who('Alt+F4')).toBe('the window')
    expect(who('K')).toBeNull()
    expect(who('Shift+K')).toBeNull()
    expect(who('Alt+2')).toBeNull()
    expect(who('Ctrl+Shift+Y')).toBeNull()
  })

  it('matches a key press, Cmd counting as Ctrl', () => {
    const e = { code: 'KeyY', ctrlKey: false, metaKey: true, altKey: false, shiftKey: true }
    expect(chordId(chordOf(e))).toBe(chordId(parseKbd('Ctrl+Shift+Y')!))
    expect(chordId(chordOf({ ...e, shiftKey: false }))).not.toBe(chordId(parseKbd('Ctrl+Shift+Y')!))
  })
})

describe('motion filters', () => {
  it('chains filters in plugin order, clamped to 0–1', () => {
    const chain = createFilterChain()
    expect(chain.active()).toBe(false)
    expect(chain.apply(0.3, 'L0', 0)).toBe(0.3)
    chain.set('b', p => p + 0.5)
    chain.set('a', p => p * 2)
    chain.setOrder(['a', 'b'])
    expect(chain.active()).toBe(true)
    expect(chain.apply(0.2, 'L0', 0)).toBeCloseTo(0.9) // (0.2 × 2) + 0.5
    chain.setOrder(['b', 'a'])
    expect(chain.apply(0.2, 'L0', 0)).toBe(1) // (0.2 + 0.5) × 2, clamped
    chain.set('a', p => 1 - p) // one per plugin: replaces
    expect(chain.apply(0.2, 'L0', 0)).toBeCloseTo(0.3)
    chain.remove('b')
    expect(chain.apply(0.2, 'L0', 0)).toBeCloseTo(0.8)
  })

  it('hands each filter the axis and the time', () => {
    const chain = createFilterChain()
    const seen: unknown[] = []
    chain.set('a', (p, info) => {
      seen.push(info)
      return p
    })
    chain.apply(0.5, 'R0', 1234)
    expect(seen).toEqual([{ axis: 'R0', t: 1234 }])
  })

  it('takes out a filter that throws or answers nonsense, and carries on', () => {
    const errors: string[] = []
    const chain = createFilterChain({ onError: owner => errors.push(owner) })
    chain.set('bad', () => {
      throw new Error('boom')
    })
    chain.set('nan', () => Number.NaN)
    chain.set('ok', p => p / 2)
    chain.setOrder(['bad', 'nan', 'ok'])
    expect(chain.apply(0.8, 'L0', 0)).toBeCloseTo(0.4)
    expect(errors).toEqual(['bad', 'nan'])
    expect(chain.apply(0.8, 'L0', 0)).toBeCloseTo(0.4)
    expect(errors).toEqual(['bad', 'nan'])
  })

  it('holds a filtered move to the script\'s own speed or the ceiling, whichever is more', () => {
    const perMs = ceilingPerMs(150) // a full stroke (2 units) per 400 ms
    expect(perMs).toBeCloseTo(0.005)
    // The script moves 0.2 in 100 ms; the ceiling allows 0.5. A filter asking for 0.9 gets 0.5.
    expect(capMove(0, 0.9, 0.4, 0.6, 100, perMs)).toBeCloseTo(0.5)
    expect(capMove(1, 0.1, 0.4, 0.6, 100, perMs)).toBeCloseTo(0.5)
    // A fast script lets a filter go as fast as it does.
    expect(capMove(0, 0.9, 0, 1, 100, perMs)).toBeCloseTo(0.9)
    // Within both, untouched.
    expect(capMove(0.2, 0.4, 0.2, 0.4, 100, perMs)).toBe(0.4)
  })

  it('runs a whole script\'s points through, step by step', () => {
    const actions = [{ at: 0, pos: 0.5 }, { at: 1000, pos: 0.6 }, { at: 1100, pos: 0.4 }]
    const out = filterActions(actions, 'L0', p => (p > 0.5 ? 1 : 0), ceilingPerMs(150))
    expect(out[0].pos).toBe(0)
    expect(out[1].pos).toBe(1) // 1 s is plenty at the ceiling
    // 100 ms: the script moves 0.2, the ceiling allows 0.5, so 1 → 0.5, not 0.
    expect(out[2].pos).toBeCloseTo(0.5)
    expect(out.map(a => a.at)).toEqual([0, 1000, 1100])
  })
})

describe('video fingerprints', () => {
  it('hashes the start, middle and end of a big file, and a small one whole', () => {
    const K = CHUNK
    expect(fingerprintRanges(1000)).toEqual([[0, 1000]])
    expect(fingerprintRanges(3 * K)).toEqual([[0, 3 * K]])
    const size = 10 * K + 7
    const r = fingerprintRanges(size)
    expect(r).toHaveLength(3)
    expect(r[0]).toEqual([0, K])
    expect(r[2]).toEqual([size - K, size])
    expect(r[1][1] - r[1][0]).toBe(K)
    expect(r[1][0]).toBe(Math.floor((size - K) / 2))
  })

  it('is the same for the same bytes, and differs when a hashed piece does', async () => {
    const big = new Uint8Array(5 * CHUNK).map((_, i) => i % 251)
    const a = await fingerprintOf(new Blob([big]))
    expect(a).toMatch(/^v1:327680:[0-9a-f]{64}$/)
    expect(await fingerprintOf(new Blob([big.slice()]))).toBe(a)
    const changed = big.slice()
    changed[Math.floor(big.length / 2)] ^= 1
    expect(await fingerprintOf(new Blob([changed]))).not.toBe(a)
    // A byte outside the three pieces does not count: that's the trade for speed.
    const outside = big.slice()
    outside[CHUNK + 10] ^= 1
    expect(await fingerprintOf(new Blob([outside]))).toBe(a)
    expect(fingerprintSize(a)).toBe(327680)
    expect(fingerprintSize('nope')).toBeNull()
  })
})

describe('plugin scripts', () => {
  it('names axes by channel or suffix', () => {
    expect(axisKeyFor(undefined)).toBe('default')
    expect(axisKeyFor('L0')).toBe('l0')
    expect(axisKeyFor('Twist')).toBe('twist')
    expect(axisKeyFor('vib')).toBe('vib')
    expect(axisKeyFor('X9')).toBeNull()
    expect(axisKeyFor(3)).toBeNull()
  })

  it('cleans actions into a funscript\'s', () => {
    expect(cleanActions([{ at: 200.4, pos: 120 }, { at: -5, pos: 50 }, { at: 'x', pos: 1 }, null, { at: 100, pos: -3 }]))
      .toEqual([{ at: 0, pos: 50 }, { at: 100, pos: 0 }, { at: 200, pos: 100 }])
    expect(cleanActions('nope')).toEqual([])
  })

  it('copies what plays, positions 0–100', () => {
    const axis = (channel: string, enabled: boolean) => ({
      path: 'a.funscript',
      filename: 'a.funscript',
      channel,
      axisKey: 'default',
      label: 'Stroke',
      enabled,
      isAlt: false,
      altName: '',
      offsetMs: 40,
      parsed: { channel, axisKey: 'default', label: 'Stroke', axisDef: { channel, label: 'Stroke', defaultPos: 0.5, isLinear: true }, actions: [{ at: 0, pos: 0.255 }], filePath: 'a', duration: 0 },
    })
    const snap = snapshotOf([axis('L0', true), axis('R0', false)], 'a.mp4')
    expect(snap).toEqual({ video: 'a.mp4', axes: [{ axis: 'L0', label: 'Stroke', name: 'a.funscript', actions: [{ at: 0, pos: 25.5 }], offsetMs: 40 }] })
  })
})

describe('dev folders', () => {
  it('skips dependencies and hidden folders', () => {
    expect(skipName('node_modules')).toBe(true)
    expect(skipName('.git')).toBe(true)
    expect(skipName('dist')).toBe(false)
  })

  it('notices a file added, removed or saved', () => {
    const a = [{ path: 'index.js', size: 10, lastModified: 1 }, { path: 'manifest.json', size: 5, lastModified: 1 }]
    const sig = signatureOf(a)
    expect(signatureOf([...a].reverse())).toBe(sig)
    expect(signatureOf([{ ...a[0], lastModified: 2 }, a[1]])).not.toBe(sig)
    expect(signatureOf([a[0]])).not.toBe(sig)
  })
})

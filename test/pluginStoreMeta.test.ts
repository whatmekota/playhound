import type { SourceError } from '~/plugins/sources'
import type { PluginInfo, SourceState } from '~/stores/pluginStore'
import { describe, expect, it } from 'vitest'
import { readManifest } from '~/plugins/manifest'
import { fetchRelease, listingManifest, readRelease } from '~/plugins/sources'
import { buildEntries, iconRef, screenshotRefs } from '~/plugins/storeEntry'
import { ago, APP_VERSION, checkImage, count, imageInfo, incompatibility, matchesQuery, monogram, readStoreFields, shortVersion, storeImages } from '~/plugins/storeMeta'

function png(w: number, h: number, size = 64): Uint8Array {
  const b = new Uint8Array(size)
  b.set([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const v = new DataView(b.buffer)
  v.setUint32(16, w)
  v.setUint32(20, h)
  return b
}
function jpeg(w: number, h: number): Uint8Array {
  // SOI, an APP0 of 16 bytes, then SOF0.
  const b = new Uint8Array(2 + 18 + 19)
  b.set([0xFF, 0xD8, 0xFF, 0xE0, 0, 16], 0)
  const sof = 20
  b.set([0xFF, 0xC0, 0, 17, 8], sof)
  const v = new DataView(b.buffer)
  v.setUint16(sof + 5, h)
  v.setUint16(sof + 7, w)
  return b
}
function webpX(w: number, h: number): Uint8Array {
  const b = new Uint8Array(30)
  b.set([...'RIFF'].map(c => c.charCodeAt(0)), 0)
  b.set([...'WEBPVP8X'].map(c => c.charCodeAt(0)), 8)
  const u24 = (i: number, n: number) => b.set([n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF], i)
  u24(24, w - 1)
  u24(27, h - 1)
  return b
}
const svg = (s = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>') => new TextEncoder().encode(s)

describe('store fields in the manifest', () => {
  it('reads the good ones and says what is wrong with the rest, without throwing', () => {
    const { fields, problems } = readStoreFields({
      icon: 'icon.png',
      longDescription: '  **More** about it  ',
      screenshots: ['shot-1.png', { file: 'shot-2.webp', caption: 'The panel' }, 'evil.svg', 'https://example.com/x.png'],
      homepage: 'https://example.com/plugin',
      category: 'Sync',
      keywords: ['Party', 'sync', 'party'],
      minPlayhound: 'v2.2.0',
    })
    expect(fields).toEqual({
      icon: 'icon.png',
      longDescription: '**More** about it',
      screenshots: [{ file: 'shot-1.png' }, { file: 'shot-2.webp', caption: 'The panel' }],
      homepage: 'https://example.com/plugin',
      category: 'sync',
      keywords: ['party', 'sync'],
      minPlayhound: '2.2.0',
    })
    expect(problems.some(p => p.includes('evil.svg'))).toBe(true)
    expect(problems.some(p => p.includes('example.com/x.png'))).toBe(true)
    expect(problems.some(p => p.includes('keywords'))).toBe(true)
  })

  it('refuses paths out of the release, hotlinks and unknown categories', () => {
    const { fields, problems } = readStoreFields({ icon: '../icon.png', homepage: 'http://insecure.example', category: 'games', minPlayhound: 'soon' })
    expect(fields).toEqual({})
    expect(problems).toHaveLength(4)
    expect(readStoreFields({ icon: 'https://evil.example/i.png' }).fields.icon).toBeUndefined()
  })

  it('keeps at most six screenshots and ten keywords', () => {
    const { fields } = readStoreFields({
      screenshots: Array.from({ length: 9 }, (_, i) => `s${i}.png`),
      keywords: Array.from({ length: 14 }, (_, i) => `k${i}`),
    })
    expect(fields.screenshots).toHaveLength(6)
    expect(fields.keywords).toHaveLength(10)
  })

  it('carries through readManifest, and an old manifest reads as before', () => {
    const m = readManifest({ id: 'x', name: 'X', version: '1.0.0', icon: 'icon.svg', category: 'tools' })
    expect(m.icon).toBe('icon.svg')
    expect(m.category).toBe('tools')
    expect(readManifest({ id: 'x', name: 'X', version: '1.0.0', category: 'nope' })).toEqual({ id: 'x', name: 'X', version: '1.0.0', description: undefined, author: undefined, main: 'index.js', api: 1 })
  })

  it('refuses to install a plugin that needs a newer playhound', () => {
    expect(() => readManifest({ id: 'x', name: 'X', version: '1.0.0', minPlayhound: '99.0' })).toThrow(/needs playhound 99.0 or newer/)
    expect(() => readManifest({ id: 'x', name: 'X', version: '1.0.0', minPlayhound: APP_VERSION })).not.toThrow()
  })
})

describe('compatibility', () => {
  it('says what this playhound lacks', () => {
    expect(incompatibility({ minPlayhound: '2.2.0' }, 2, '2.1.1')).toBe('Needs playhound 2.2 or newer')
    expect(incompatibility({ minPlayhound: '2.2.0' }, 2, '2.2.0')).toBeNull()
    // A beta of 2.2.0 runs plugins made for 2.2.0; 2.1.9 still doesn't.
    expect(incompatibility({ minPlayhound: '2.2.0' }, 2, '2.2.0-beta.1')).toBeNull()
    expect(incompatibility({ minPlayhound: '2.2.0' }, 2, '2.1.9')).toBe('Needs playhound 2.2 or newer')
    expect(incompatibility({ api: 3 }, 2, '2.1.1')).toBe('Needs a newer playhound (plugin API 3)')
    expect(incompatibility({}, 2)).toBeNull()
  })
  it('writes versions the way a sentence does', () => {
    expect(shortVersion('2.2.0')).toBe('2.2')
    expect(shortVersion('2.2.1')).toBe('2.2.1')
    expect(shortVersion('3')).toBe('3.0')
    expect(shortVersion('v3.0.0')).toBe('3.0')
  })
})

describe('store images', () => {
  it('reads the type and size of PNG, JPEG, WebP and SVG', () => {
    expect(imageInfo(png(256, 256))).toEqual({ type: 'png', width: 256, height: 256 })
    expect(imageInfo(jpeg(1280, 800))).toEqual({ type: 'jpeg', width: 1280, height: 800 })
    expect(imageInfo(webpX(1600, 1000))).toEqual({ type: 'webp', width: 1600, height: 1000 })
    expect(imageInfo(svg())?.type).toBe('svg')
    expect(imageInfo(new TextEncoder().encode('<html><script>alert(1)</script>'))).toBeNull()
  })

  it('takes square PNG and SVG icons of a sensible size', () => {
    expect(checkImage(png(256, 256), 'icon')).toEqual({ ok: true, type: 'png' })
    expect(checkImage(svg(), 'icon')).toEqual({ ok: true, type: 'svg' })
    expect(checkImage(png(256, 128), 'icon')).toMatchObject({ ok: false, problem: expect.stringContaining('square') })
    expect(checkImage(png(32, 32), 'icon')).toMatchObject({ ok: false })
    expect(checkImage(png(256, 256, 300 * 1024), 'icon')).toMatchObject({ ok: false, problem: expect.stringContaining('256 KB') })
    expect(checkImage(jpeg(256, 256), 'icon')).toMatchObject({ ok: false })
  })

  it('takes PNG, JPEG and WebP screenshots, not SVG or giants', () => {
    expect(checkImage(jpeg(1280, 800), 'screenshot')).toEqual({ ok: true, type: 'jpeg' })
    expect(checkImage(webpX(1600, 1000), 'screenshot')).toEqual({ ok: true, type: 'webp' })
    expect(checkImage(svg(), 'screenshot')).toMatchObject({ ok: false })
    expect(checkImage(png(8000, 4000), 'screenshot')).toMatchObject({ ok: false })
    expect(checkImage(png(200, 100), 'screenshot')).toMatchObject({ ok: false })
  })

  const assets = [
    { name: 'icon.png', url: 'https://gh/icon.png', size: 20_000 },
    { name: 'screenshot-10.png', url: 'https://gh/s10.png', size: 1000 },
    { name: 'screenshot-2.png', url: 'https://gh/s2.png', size: 1000 },
    { name: 'Panel.jpg', url: 'https://gh/panel.jpg', size: 1000 },
    { name: 'huge.png', url: 'https://gh/huge.png', size: 50 * 1024 * 1024 },
  ]
  it('finds the icon and screenshots among the release assets by convention', () => {
    const r = storeImages(null, assets)
    expect(r.icon?.url).toBe('https://gh/icon.png')
    expect(r.screenshots.map(s => s.asset.url)).toEqual(['https://gh/s2.png', 'https://gh/s10.png'])
  })
  it('or by the names the manifest gives, leaving out missing and oversized ones', () => {
    const r = storeImages({ icon: 'missing.svg', screenshots: [{ file: 'panel.jpg', caption: 'Panel' }, { file: 'huge.png' }, { file: 'gone.png' }] }, assets)
    expect(r.icon).toBeNull()
    expect(r.screenshots).toEqual([{ asset: assets[3], caption: 'Panel' }])
  })
})

describe('generated icons', () => {
  it('takes initials from the name and a steady hue from the id', () => {
    expect(monogram('ph2gether', 'ph2gether').letters).toBe('P')
    expect(monogram('phbrowser', 'Browser').letters).toBe('B')
    expect(monogram('x', 'Script tools').letters).toBe('ST')
    expect(monogram('x', '  ').letters).toBe('X')
    expect(monogram('abc', 'A').hue).toBe(monogram('abc', 'Other').hue)
    expect(monogram('abc', 'A').hue).not.toBe(monogram('abd', 'A').hue)
    const h = monogram('anything', 'a').hue
    expect(h >= 0 && h < 360).toBe(true)
  })
})

describe('search and labels', () => {
  const p = { name: 'Threads', repo: 'whatmekota/phthreads', description: 'Finds the EroScripts threads', author: 'whatmekota', category: 'library', keywords: ['tags'] }
  it('matches every word anywhere', () => {
    expect(matchesQuery(p, '')).toBe(true)
    expect(matchesQuery(p, 'eroscripts TAGS')).toBe(true)
    expect(matchesQuery(p, 'library threads')).toBe(true)
    expect(matchesQuery(p, 'threads device')).toBe(false)
  })
  it('says how long ago and how many, briefly', () => {
    const now = Date.parse('2026-11-09T12:00:00Z')
    expect(ago('2026-11-09T11:59:30Z', now)).toBe('just now')
    expect(ago('2026-11-08T11:00:00Z', now)).toBe('yesterday')
    expect(ago('2026-11-01T12:00:00Z', now)).toBe('8 days ago')
    expect(count(950)).toBe('950')
    expect(count(1234)).toBe('1.2k')
    expect(count(45_000)).toBe('45k')
  })
})

describe('reading a source', () => {
  const release = (tag: string, extra: object = {}) => ({
    tag_name: tag,
    html_url: `https://github.com/o/r/releases/tag/${tag}`,
    published_at: '2026-11-05T00:00:00Z',
    body: `Notes for ${tag}`,
    assets: [
      { name: 'manifest.json', browser_download_url: `https://x/${tag}/manifest.json`, size: 200, download_count: 500 },
      { name: `r-${tag}.zip`, browser_download_url: `https://x/${tag}/r.zip`, size: 1234, download_count: 10 },
      { name: 'icon.png', browser_download_url: `https://x/${tag}/icon.png`, size: 3000 },
    ],
    ...extra,
  })
  const respond = (routes: Record<string, unknown>) => async (url: string) => {
    if (!(url in routes))
      throw new TypeError('offline')
    const v = routes[url]
    return typeof v === 'number' ? new Response('', { status: v }) : new Response(JSON.stringify(v), { status: 200 })
  }
  const API = 'https://api.github.com/repos/o/r/releases?per_page=100'

  it('reads notes, images and download counts from the release', () => {
    const r = readRelease('o/r', release('v0.2.0'))!
    expect(r.release.notes).toBe('Notes for v0.2.0')
    expect(r.release.downloads).toBe(10)
    expect(r.release.images).toEqual([{ name: 'icon.png', url: 'https://x/v0.2.0/icon.png', size: 3000 }])
  })

  it('takes the latest published release, and counts zip downloads over all of them', async () => {
    const f = respond({
      [API]: [release('v0.3.0-beta', { prerelease: true }), release('v0.2.0'), release('v0.1.0')],
      'https://x/v0.2.0/manifest.json': { id: 'r', name: 'R', version: '0.2.0', category: 'tools', minPlayhound: '99.0.0' },
    })
    const r = await fetchRelease(f, 'o/r')
    expect(r.version).toBe('0.2.0')
    expect(r.downloads).toBe(20)
    expect(r.manifest?.category).toBe('tools')
    expect(r.problem).toBe('Needs playhound 99.0 or newer')
  })

  it('tells apart no repository, no release, no zip, and no connection', async () => {
    const kind = (f: (url: string) => Promise<Response>) => fetchRelease(f, 'o/r').then(() => null, (e: SourceError) => e.kind)
    expect(await kind(respond({ [API]: 404 }))).toBe('not-found')
    expect(await kind(respond({ [API]: [] }))).toBe('no-release')
    expect(await kind(respond({ [API]: [release('v1', { assets: [] })] }))).toBe('no-zip')
    expect(await kind(respond({ [API]: 403 }))).toBe('rate')
    expect(await kind(respond({}))).toBe('offline')
  })

  it('shows a manifest it can\'t install, with why', () => {
    expect(listingManifest({ id: 'x', name: 'X', version: '1', api: 9, permissions: ['teleport', 'device'] })).toMatchObject({ manifest: { id: 'x', api: 9, permissions: ['device'] }, problem: 'Needs a newer playhound (plugin API 9)' })
    expect(listingManifest({ name: 'no id' })).toMatchObject({ manifest: null, problem: expect.stringContaining('"id"') })
    expect(listingManifest({ id: 'x', name: 'X', version: '1' }).problem).toBeNull()
  })
})

describe('store entries', () => {
  const info = (id: string, version: string, extra: Partial<PluginInfo> = {}): PluginInfo => ({
    manifest: { id, name: id.toUpperCase(), version },
    installedAt: 1,
    size: 1,
    source: null,
    enabled: true,
    status: 'on',
    error: null,
    fields: null,
    panel: null,
    page: null,
    overlay: null,
    commands: [],
    values: {},
    dev: null,
    ...extra,
  })
  const src = (repo: string, id: string, version: string, images: { name: string, url: string, size: number }[] = []): SourceState => ({
    repo,
    status: 'ok',
    error: '',
    checkedAt: 1,
    release: { repo, version, manifest: { id, name: id, version, author: 'someone' }, zipUrl: '', zipSize: 1, pageUrl: '', publishedAt: '', notes: '', downloads: 3, images, problem: null },
  })

  it('pairs sources with installed plugins and finds updates', () => {
    const e = buildEntries(
      ['whatmekota/a', 'someone/b'],
      { 'whatmekota/a': src('whatmekota/a', 'a', '1.1.0'), 'someone/b': src('someone/b', 'b', '1.0.0') },
      [info('a', '1.0.0'), info('local', '0.1.0', { source: 'gone/repo' })],
    )
    expect(e.map(x => x.key)).toEqual(['whatmekota/a', 'someone/b', 'local:local'])
    expect(e[0]).toMatchObject({ trust: 'official', update: { version: '1.1.0' }, installed: { manifest: { id: 'a' } } })
    expect(e[1]).toMatchObject({ trust: null, update: null, installed: null, author: 'someone' })
    expect(e[2]).toMatchObject({ repo: 'gone/repo', author: 'gone' })
  })

  it('offers no update over a plugin loaded from a folder', () => {
    const e = buildEntries(['o/a'], { 'o/a': src('o/a', 'a', '2.0.0') }, [info('a', '1.0.0', { dev: { label: 'C:/a', error: null } })])
    expect(e[0].update).toBeNull()
  })

  it('takes the icon from the release, else the installed package; screenshots likewise', () => {
    const load = async () => null
    const withIcon = buildEntries(['o/a'], { 'o/a': src('o/a', 'a', '1.0.0', [{ name: 'icon.svg', url: 'https://x/icon.svg', size: 100 }]) }, [])[0]
    expect(iconRef(withIcon, load)).toEqual({ kind: 'release', url: 'https://x/icon.svg' })
    const local = buildEntries([], {}, [info('a', '1.0.0', { manifest: { id: 'a', name: 'A', version: '1.0.0', icon: 'i.png', screenshots: [{ file: 's.png' }] } })])[0]
    expect(iconRef(local, load)).toMatchObject({ kind: 'package', key: 'a@1.0.0:i.png' })
    expect(screenshotRefs(local, load)).toMatchObject([{ image: { kind: 'package', key: 'a@1.0.0:s.png' } }])
    expect(iconRef(buildEntries([], {}, [info('b', '1')])[0], load)).toBeNull()
  })
})

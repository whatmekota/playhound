import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { newer, parseRepo, readRelease } from '~/plugins/sources'
import { BUILTIN_STAGE, parseStage, stageOf } from '~/plugins/stage'
import { stripCommonRoot, unzip } from '~/plugins/zip'
import { readPackage } from '~/stores/pluginStore'

/** A minimal zip writer: stored or deflated entries, no extras. */
function zip(files: Record<string, string | Uint8Array>, deflate = true): Uint8Array {
  const enc = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const data = typeof content === 'string' ? enc.encode(content) : content
    const body = deflate ? new Uint8Array(deflateRawSync(data)) : data
    const n = enc.encode(name)
    const loc = new DataView(new ArrayBuffer(30))
    loc.setUint32(0, 0x04034B50, true)
    loc.setUint16(8, deflate ? 8 : 0, true)
    loc.setUint32(18, body.length, true)
    loc.setUint32(22, data.length, true)
    loc.setUint16(26, n.length, true)
    const cen = new DataView(new ArrayBuffer(46))
    cen.setUint32(0, 0x02014B50, true)
    cen.setUint16(10, deflate ? 8 : 0, true)
    cen.setUint32(20, body.length, true)
    cen.setUint32(24, data.length, true)
    cen.setUint16(28, n.length, true)
    cen.setUint32(42, offset, true)
    locals.push(new Uint8Array(loc.buffer), n, body)
    centrals.push(new Uint8Array(cen.buffer), n)
    offset += 30 + n.length + body.length
  }
  const cenSize = centrals.reduce((s, b) => s + b.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054B50, true)
  end.setUint16(8, Object.keys(files).length, true)
  end.setUint16(10, Object.keys(files).length, true)
  end.setUint32(12, cenSize, true)
  end.setUint32(16, offset, true)
  const parts = [...locals, ...centrals, new Uint8Array(end.buffer)]
  const out = new Uint8Array(parts.reduce((s, b) => s + b.length, 0))
  let p = 0
  for (const b of parts) {
    out.set(b, p)
    p += b.length
  }
  return out
}

const text = (d: Uint8Array) => new TextDecoder().decode(d)
const manifest = (o: object = {}) => JSON.stringify({ id: 'demo', name: 'Demo', version: '1.0.0', ...o })

describe('unzip', () => {
  it('reads deflated and stored entries, skipping directories', async () => {
    for (const deflate of [true, false]) {
      const files = await unzip(zip({ 'a.txt': 'hello hello hello', 'dir/': '', 'dir/b.js': 'export default 1' }, deflate))
      expect(files.map(f => f.path)).toEqual(['a.txt', 'dir/b.js'])
      expect(text(files[0].data)).toBe('hello hello hello')
      expect(text(files[1].data)).toBe('export default 1')
    }
  })

  it('refuses what is not a zip, and paths that climb out', async () => {
    await expect(unzip(new TextEncoder().encode('not a zip at all, sorry'))).rejects.toThrow('Not a zip')
    await expect(unzip(zip({ '../evil.js': 'x' }))).rejects.toThrow('Unsafe path')
  })

  it('takes off a single wrapping folder around the manifest', () => {
    const e = (path: string) => ({ path, data: new Uint8Array() })
    expect(stripCommonRoot([e('demo/manifest.json'), e('demo/index.js')]).map(x => x.path)).toEqual(['manifest.json', 'index.js'])
    expect(stripCommonRoot([e('manifest.json'), e('lib/x.js')]).map(x => x.path)).toEqual(['manifest.json', 'lib/x.js'])
  })
})

describe('readPackage', () => {
  it('reads the manifest and the files, main defaulting to index.js', async () => {
    const pkg = await readPackage(zip({ 'manifest.json': manifest(), 'index.js': 'export default () => {}', 'img/a.png': new Uint8Array([1, 2, 3]) }))
    expect(pkg.manifest).toMatchObject({ id: 'demo', name: 'Demo', version: '1.0.0', main: 'index.js' })
    expect(Object.keys(pkg.files).sort()).toEqual(['img/a.png', 'index.js', 'manifest.json'])
    expect(pkg.files['index.js'].type).toBe('text/javascript')
    expect(pkg.files['img/a.png'].type).toBe('image/png')
  })

  it('says what is wrong with a bad package', async () => {
    const read = (files: Record<string, string>) => readPackage(zip(files))
    await expect(read({ 'index.js': '' })).rejects.toThrow('No manifest.json')
    await expect(read({ 'manifest.json': '{nope', 'index.js': '' })).rejects.toThrow('not valid JSON')
    await expect(read({ 'manifest.json': manifest({ id: 'Bad Id' }), 'index.js': '' })).rejects.toThrow('"id"')
    await expect(read({ 'manifest.json': manifest({ main: 'main.js' }), 'index.js': '' })).rejects.toThrow('main.js')
  })
})

describe('the stage', () => {
  it('names what the stage shows', () => {
    expect(stageOf('library', null)).toBe('library')
    expect(stageOf('plugin', 'playmate')).toBe('plugin:playmate')
  })
  it('reads playhound\'s views and plugin pages, and nothing else', () => {
    expect(parseStage('wall')).toEqual({ view: 'wall' })
    expect(parseStage('eroscripts')).toEqual({ view: 'eroscripts' })
    expect(parseStage('plugin:my-plugin')).toEqual({ plugin: 'my-plugin' })
    expect(parseStage('plugin')).toBeNull()
    expect(parseStage('plugin:')).toBeNull()
    expect(parseStage('plugin:Bad Id')).toBeNull()
    expect(parseStage('device')).toBeNull()
    expect(parseStage(42)).toBeNull()
    expect(BUILTIN_STAGE).toContain('player')
    expect(BUILTIN_STAGE).not.toContain('plugin')
  })
})

describe('plugin sources', () => {
  it('reads a repository from owner/repo or a GitHub link', () => {
    expect(parseRepo('whatmekota/playmate')).toBe('whatmekota/playmate')
    expect(parseRepo('https://github.com/whatmekota/playmate/releases')).toBe('whatmekota/playmate')
    expect(parseRepo('github.com/a-b/c.d.git')).toBe('a-b/c.d')
    expect(parseRepo('not a repo')).toBeNull()
  })

  it('compares versions like the app updater', () => {
    expect(newer('0.2.0', '0.1.9')).toBe(true)
    expect(newer('v1.10.0', '1.9.2')).toBe(true)
    expect(newer('0.1.0', '0.1.0')).toBe(false)
    expect(newer('1.0.0', '1.0.0-rc.1')).toBe(true)
  })

  it('finds the plugin zip and its manifest in a release', () => {
    const r = readRelease('o/r', {
      tag_name: 'v0.2.0',
      html_url: 'https://github.com/o/r/releases/tag/v0.2.0',
      published_at: '2026-11-05T00:00:00Z',
      assets: [
        { name: 'manifest.json', browser_download_url: 'https://x/manifest.json', size: 200 },
        { name: 'thing-0.2.0.zip', browser_download_url: 'https://x/thing.zip', size: 1234 },
      ],
    })
    expect(r?.release).toMatchObject({ repo: 'o/r', version: '0.2.0', zipUrl: 'https://x/thing.zip', zipSize: 1234 })
    expect(r?.manifestUrl).toBe('https://x/manifest.json')
    expect(readRelease('o/r', { tag_name: 'v1', html_url: '', published_at: '', assets: [] })).toBeNull()
  })
})

import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { blobPart } from '~/lib/android/folders'
import { gofileWt, iwaraSources, megaDownloadRequest, pixeldrainFsFiles, pmvhavenVideo, resolvesOnAndroid, rule34Links, UA } from '~/lib/android/hosts'
import { setMediaBase } from '~/lib/android/nativeFile'
import { cookiesOf, forumProxyFetch, nativeFetch, proxyRequest } from '~/lib/android/net'

const BASE = 'http://127.0.0.1:41234/tok/'

describe('the resolvers, in the app', () => {
  it('computes Gofile\'s website token as the site does', async () => {
    const now = 1_700_000_000_000
    const expected = createHash('sha256').update(`${UA}::en-US::abc::${Math.floor(now / 1000 / 14400)}::12af056dacea0b`).digest('hex')
    expect(await gofileWt('abc', now)).toBe(expected)
  })

  it('reads Rule34Video\'s download links, best first, once each', () => {
    const html = `
      <a href="https://rule34video.com/get_file/1/a/b/123_480p.mp4/?download=true&amp;x=1">480p</a>
      <a href="https://rule34video.com/get_file/1/a/b/123_1080p.mp4/?download=true&amp;x=1">1080p</a>
      <a href="https://rule34video.com/get_file/1/a/b/123_480p.mp4/?download=true&amp;x=1">again</a>`
    expect(rule34Links(html).map(l => l.height)).toEqual([1080, 480])
    expect(rule34Links(html)[0].url).toContain('&x=1')
  })

  it('finds PMVHaven\'s original upload in the Nuxt payload', () => {
    const html = '<meta property="og:title" content="Song &amp; Dance - PMVHaven">"https:\\u002F\\u002Fbucket.example\\u002Fvideos\\u002Fx\\u002Fclip.mp4"'
    expect(pmvhavenVideo(html)).toEqual({ url: 'https://bucket.example/videos/x/clip.mp4', title: 'Song & Dance' })
    expect(pmvhavenVideo('<html></html>')).toBeNull()
  })

  it('orders Iwara\'s qualities and leaves out the preview', () => {
    const sources = iwaraSources([
      { name: '360', src: { view: '//cdn/360.mp4' } },
      { name: 'preview', src: { view: '//cdn/p.mp4' } },
      { name: 'Source', src: { view: '//cdn/src.mp4' } },
      { name: '540', src: { view: '//cdn/540.mp4' } },
    ])
    expect(sources.map(s => s.label)).toEqual(['Source', '540p', '360p'])
    expect(sources[0].target).toMatchObject({ url: 'https://cdn/src.mp4', headers: { Referer: 'https://www.iwara.tv/' } })
  })

  it('lists a Pixeldrain filesystem folder\'s videos', () => {
    const stat = { base_index: 0, path: [{ type: 'dir' }], children: [
      { type: 'file', name: 'a b.mp4', path: '/me/a b.mp4', file_size: 5 },
      { type: 'file', name: 'notes.txt', path: '/me/notes.txt' },
    ] }
    const items = pixeldrainFsFiles(stat)
    expect(items).toHaveLength(1)
    expect(items[0].sources[0].target).toMatchObject({ url: 'https://pixeldrain.com/api/filesystem/me/a%20b.mp4' })
  })

  it('asks MEGA for a download address the way megajs does', () => {
    expect(JSON.parse(megaDownloadRequest({ downloadId: 'abc' }).request)).toEqual({ a: 'g', g: 1, ssl: 2, p: 'abc' })
    const inFolder = megaDownloadRequest({ downloadId: ['folder', 'node'] })
    expect(inFolder.folder).toBe('folder')
    expect(JSON.parse(inFolder.request)).toMatchObject({ n: 'node' })
  })

  it('resolves its own hosts and leaves yt-dlp sites to the desktop app', () => {
    expect(resolvesOnAndroid('https://pixeldrain.com/u/abc')).toBe(true)
    expect(resolvesOnAndroid('https://mega.nz/file/x#y')).toBe(true)
    expect(resolvesOnAndroid('https://www.pornhub.com/view_video.php?viewkey=1')).toBe(false)
  })
})

describe('nativeFetch', () => {
  let seen: { url: string, init: RequestInit }[] = []

  beforeEach(() => {
    setMediaBase(BASE)
    seen = []
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    setMediaBase(null)
  })

  function answer(res: Response) {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, init })
      return res
    }))
  }

  it('describes the request to the server\'s "p" route', () => {
    const p = proxyRequest(BASE, 'https://x.example/a?b=1', 'POST', { Referer: 'https://y/', Cookie: 'é=1' }, true)
    expect(p.url).toBe(`${BASE}p?u=${encodeURIComponent('https://x.example/a?b=1')}`)
    expect(p.headers['X-Ph-Method']).toBe('POST')
    expect(p.headers['X-Ph-Jar']).toBe('1')
    expect(JSON.parse(decodeURIComponent(p.headers['X-Ph-Headers']))).toEqual({ Referer: 'https://y/', Cookie: 'é=1' })
  })

  it('hands back the answer with where it ended and the cookies it set', async () => {
    answer(new Response('hi', { status: 200, headers: {
      'Content-Type': 'text/plain',
      'X-Ph-Url': encodeURIComponent('https://x.example/landed'),
      'X-Ph-Set-Cookie': encodeURIComponent(JSON.stringify(['a=1; Path=/', 'b=2'])),
    } }))
    const res = await nativeFetch('https://x.example/start', { headers: { Referer: 'https://r/' } })
    expect(await res.text()).toBe('hi')
    expect(res.url).toBe('https://x.example/landed')
    expect(res.redirected).toBe(true)
    expect(res.headers.get('x-ph-url')).toBeNull()
    expect(cookiesOf(res)).toBe('a=1; b=2')
    expect(seen[0].init.method).toBe('GET')
  })

  it('fails as fetch does when the server could not get through', async () => {
    answer(new Response(JSON.stringify({ error: 'Could not find x.example' }), { status: 502, headers: { 'X-Ph-Error': '1' } }))
    await expect(nativeFetch('https://x.example/')).rejects.toThrow(TypeError)
  })

  it('makes the local proxy\'s forum and Pixeldrain requests', async () => {
    answer(new Response('{}'))
    await forumProxyFetch('http://localhost:7071/latest.json', { headers: { 'X-ES-Cookie': '_t=abc' } })
    await forumProxyFetch('http://localhost:7071/t/x/1.json')
    await forumProxyFetch('http://localhost:7071/pd/AbC123')
    const u = (i: number) => decodeURIComponent(new URL(seen[i].url).searchParams.get('u')!)
    const h = (i: number) => JSON.parse(decodeURIComponent((seen[i].init.headers as Record<string, string>)['X-Ph-Headers']))
    expect(u(0)).toBe('https://discuss.eroscripts.com/latest.json')
    expect(h(0).Cookie).toBe('_t=abc')
    expect((seen[0].init.headers as Record<string, string>)['X-Ph-Jar']).toBeUndefined()
    // No pasted cookie: the app's own session.
    expect((seen[1].init.headers as Record<string, string>)['X-Ph-Jar']).toBe('1')
    expect(u(2)).toBe('https://pixeldrain.com/api/file/AbC123?download')
  })
})

describe('writing into folders', () => {
  it('takes what a writable stream is handed', async () => {
    expect(await blobPart('text')).toBe('text')
    expect(await blobPart({ type: 'write', data: 'x' })).toBe('x')
    await expect(blobPart({ type: 'seek', position: 3 })).rejects.toThrow()
  })
})

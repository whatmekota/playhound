import { describe, expect, it } from 'vitest'
import { detectStreamHost } from '../src/lib/streamHosts'

const id = (href: string) => detectStreamHost(href)?.id ?? null

describe('stream hosts', () => {
  it('knows the hosts playhound resolves itself', () => {
    expect(id('https://pixeldrain.com/u/V4cuSoQc')).toBe('pixeldrain')
    expect(id('https://pixeldrain.com/l/oW2dJrae')).toBe('pixeldrain')
    expect(id('https://pixeldrain.com/d/abc123')).toBe('pixeldrain')
    expect(id('https://gofile.io/d/mV4t8p')).toBe('gofile')
    expect(id('https://www.iwara.tv/video/canvVDQxSp574K/impregnate-me-hmv')).toBe('iwara')
    expect(id('https://www.iwara.tv/videos/canvVDQxSp574K')).toBe('iwara')
    expect(id('https://rule34video.com/video/3773837/duke-shiwa/')).toBe('rule34video')
    expect(id('https://rule34video.com/videos/3135969/boom-mlp-hmv/')).toBe('rule34video')
    expect(id('https://pmvhaven.com/video/furry-hmv_6a91a6139318cecabab8a769')).toBe('pmvhaven')
    expect(id('https://mega.nz/file/AbCdEf#key')).toBe('mega')
    expect(id('https://mega.nz/folder/AbCdEf#key')).toBe('mega')
    expect(id('https://mega.nz/#!AbCdEf!key')).toBe('mega')
  })

  it('marks the sites that go through yt-dlp', () => {
    expect(detectStreamHost('https://x.com/someone/status/2085468445919875278')).toMatchObject({ id: 'twitter', ytdlp: true })
    expect(detectStreamHost('https://cn.pornhub.com/view_video.php?viewkey=abc')).toMatchObject({ id: 'pornhub', ytdlp: true })
    expect(id('https://hanime1.me/watch?v=12345')).toBe('hanime1')
    expect(id('https://rule34.xyz/post/4642595')).toBe('rule34xyz')
    expect(id('https://rule34.xxx/index.php?page=post&s=view&id=123')).toBe('rule34xxx')
    expect(id('https://bunkr.cr/f/tckQdmvJy39zG')).toBe('bunkr')
    expect(detectStreamHost('https://gofile.io/d/mV4t8p')?.ytdlp).toBe(false)
  })

  it('leaves profiles, shops and the forum itself alone', () => {
    expect(id('https://www.iwara.tv/profile/someone')).toBeNull()
    expect(id('https://pmvhaven.com/profile/6ac3f5d701e438c2b22082af')).toBeNull()
    expect(id('https://x.com/someone')).toBeNull()
    expect(id('https://www.patreon.com/someone')).toBeNull()
    expect(id('https://discord.gg/abc')).toBeNull()
    expect(id('https://discuss.eroscripts.com/t/x/1')).toBeNull()
    expect(id('not a link')).toBeNull()
    expect(id('ftp://pixeldrain.com/u/abc')).toBeNull()
  })
})

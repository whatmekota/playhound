import { describe, expect, it } from 'vitest'
import { baseNameFor, downloadNames, videoExtFor, withCopyNumber } from '~/lib/postDownload'
import { classifyPostScripts } from '~/lib/postScripts'

describe('baseNameFor', () => {
  it('drops the extension and characters Windows refuses', () => {
    expect(baseNameFor('Alcina Dimitrescu 4k FULL VIDEO - Wutboi.mp4')).toBe('Alcina Dimitrescu 4k FULL VIDEO - Wutboi')
    expect(baseNameFor('What? A "video": 1/2*')).toBe('What A video 12')
    expect(baseNameFor('  ...  ')).toBe('video')
  })
})

describe('videoExtFor', () => {
  it('prefers the title, then the content type', () => {
    expect(videoExtFor('clip.MKV', 'video/mp4')).toBe('.mkv')
    expect(videoExtFor('clip', 'video/webm')).toBe('.webm')
    expect(videoExtFor('clip', null)).toBe('.mp4')
  })
})

describe('downloadNames', () => {
  it('saves every script under the video name, keeping its axis', () => {
    const scripts = classifyPostScripts(['alcina-dimitrescu-4k-full-video-wutboi2.funscript', 'alcina-dimitrescu-4k-full-video-wutboi2.roll.funscript'])
    expect(downloadNames('Alcina', '.mp4', scripts)).toEqual({
      video: 'Alcina.mp4',
      scripts: [
        { filename: 'alcina-dimitrescu-4k-full-video-wutboi2.funscript', saveAs: 'Alcina.funscript' },
        { filename: 'alcina-dimitrescu-4k-full-video-wutboi2.roll.funscript', saveAs: 'Alcina.roll.funscript' },
      ],
    })
  })

  it('turns a second stroke script into an alternative instead of overwriting', () => {
    const scripts = classifyPostScripts(['Song soft.funscript', 'Song hard.funscript'])
    expect(downloadNames('Song', '.mp4', scripts).scripts.map(s => s.saveAs)).toEqual(['Song.funscript', 'Song (alt 2).funscript'])
  })

  it('numbers the whole set when the name is taken', () => {
    const names = downloadNames('Song', '.mp4', classifyPostScripts(['a.funscript', 'a.roll.funscript']))
    expect(withCopyNumber(names, 'Song', 2)).toEqual({
      video: 'Song (2).mp4',
      scripts: [{ filename: 'a.funscript', saveAs: 'Song (2).funscript' }, { filename: 'a.roll.funscript', saveAs: 'Song (2).roll.funscript' }],
    })
  })
})

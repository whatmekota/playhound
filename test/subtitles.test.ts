import { describe, expect, it } from 'vitest'
import {
  cueHtml,
  decodeSubtitle,
  pairSubtitles,
  parseAss,
  parseSrt,
  parseSubtitle,
  pickTrack,
  readTag,
  sortTracks,
  subtitleLabel,
  toVtt,
} from '../src/lib/subtitles'

describe('parseSrt', () => {
  it('reads a plain SRT', () => {
    const cues = parseSrt('1\n00:00:01,000 --> 00:00:02,500\nHello\n\n2\n00:00:03,000 --> 00:00:04,000\nTwo\nlines\n')
    expect(cues).toEqual([
      { start: 1, end: 2.5, text: 'Hello' },
      { start: 3, end: 4, text: 'Two\nlines' },
    ])
  })

  it('takes a BOM, CRLF and periods for millis', () => {
    const cues = parseSrt('﻿1\r\n00:00:01.000 --> 00:00:02.000\r\nHi\r\n\r\n')
    expect(cues).toEqual([{ start: 1, end: 2, text: 'Hi' }])
  })

  it('does without cue numbers and without blank lines between cues', () => {
    const cues = parseSrt('00:00:01,000 --> 00:00:02,000\nOne\n2\n00:00:03,000 --> 00:00:04,000\nTwo')
    expect(cues.map(c => c.text)).toEqual(['One', 'Two'])
  })

  it('reads short millis as a fraction and hours past 9', () => {
    const [c] = parseSrt('10:00:01,5 --> 10:00:02,25\nx')
    expect(c.start).toBeCloseTo(36001.5)
    expect(c.end).toBeCloseTo(36002.25)
  })

  it('keeps <i> and <b>, drops {\\an8} and <font>', () => {
    const [c] = parseSrt('1\n00:00:01,000 --> 00:00:02,000\n{\\an8}<i>Up</i> <font color="#ff0">top</font> <b>now</b>')
    expect(c.text).toBe('<i>Up</i> top <b>now</b>')
  })

  it('skips empty and backwards cues', () => {
    const cues = parseSrt('1\n00:00:05,000 --> 00:00:04,000\nBackwards\n\n2\n00:00:06,000 --> 00:00:07,000\n{\\an8}\n\n3\n00:00:08,000 --> 00:00:09,000\nKept')
    expect(cues.map(c => c.text)).toEqual(['Kept'])
  })

  it('reads WebVTT too: header, notes, cue ids and settings', () => {
    const vtt = 'WEBVTT\n\nNOTE a comment\n\nintro\n00:01.000 --> 00:02.000 line:10%\nShort time\n\n01:00:00.000 --> 01:00:01.000\nLong time'
    expect(parseSrt(vtt)).toEqual([
      { start: 1, end: 2, text: 'Short time' },
      { start: 3600, end: 3601, text: 'Long time' },
    ])
  })

  it('sorts cues by start', () => {
    const cues = parseSrt('00:00:05,000 --> 00:00:06,000\nB\n\n00:00:01,000 --> 00:00:02,000\nA')
    expect(cues.map(c => c.text)).toEqual(['A', 'B'])
  })
})

describe('parseAss', () => {
  const ass = [
    '[Script Info]',
    'Title: x',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname',
    'Style: Default,Arial',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,{\\i1}Hello{\\i0}, world\\Nsecond line',
    'Dialogue: 1,0:00:01.00,0:00:02.50,Default,,0,0,0,,{\\i1}Hello{\\i0}, world\\Nsecond line',
    'Comment: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,not shown',
    'Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100{\\p0}',
    'Dialogue: 0,0:00:07.00,0:00:08.00,Default,,0,0,0,,non\\hbreaking',
  ].join('\r\n')

  it('keeps the dialogue as plain text', () => {
    expect(parseAss(ass)).toEqual([
      { start: 1, end: 2.5, text: 'Hello, world\nsecond line' },
      { start: 7, end: 8, text: 'non breaking' },
    ])
  })

  it('is picked by extension or by its header', () => {
    expect(parseSubtitle(ass, 'x.ass')).toHaveLength(2)
    expect(parseSubtitle(ass, 'x.txt')).toHaveLength(2)
  })
})

describe('toVtt', () => {
  it('writes WebVTT with escaped text and kept tags', () => {
    const vtt = toVtt([{ start: 3661.5, end: 3662, text: '<i>A & B</i> <c.red>x</c> 1 < 2 -->' }])
    expect(vtt).toBe('WEBVTT\n\n01:01:01.500 --> 01:01:02.000\n<i>A &amp; B</i> x 1 &lt; 2 →\n')
  })

  it('round-trips through the parser', () => {
    const cues = [{ start: 1.25, end: 2, text: 'One\n<b>Two</b>' }]
    expect(parseSrt(toVtt(cues))).toEqual(cues)
  })
})

describe('cueHtml', () => {
  it('keeps i, b and u and escapes everything else', () => {
    expect(cueHtml('<i.x>a</i> <script>alert(1)</script> <b>b</b> &amp; &lt;img&gt;'))
      .toBe('<i>a</i> alert(1) <b>b</b> &amp; &lt;img&gt;')
  })

  it('drops voice and timestamp tags', () => {
    expect(cueHtml('<v Bob>Hi</v> <00:00:01.000>there')).toBe('Hi there')
  })

  it('does not let attributes through', () => {
    expect(cueHtml('<b onmouseover="x">y</b>')).toBe('<b>y</b>')
  })
})

describe('decodeSubtitle', () => {
  it('reads UTF-8 and falls back to Windows-1252', () => {
    expect(decodeSubtitle(new TextEncoder().encode('café'))).toBe('café')
    expect(decodeSubtitle(new Uint8Array([0x63, 0x61, 0x66, 0xE9]))).toBe('café')
  })

  it('reads UTF-16 with a BOM', () => {
    expect(decodeSubtitle(new Uint8Array([0xFF, 0xFE, 0x68, 0x00, 0x69, 0x00]))).toBe('hi')
  })
})

describe('readTag and labels', () => {
  it('finds the language and flags', () => {
    expect(readTag('en')).toEqual({ tag: 'en', lang: 'en', flags: [] })
    expect(readTag('eng.forced')).toEqual({ tag: 'eng.forced', lang: 'en', flags: ['forced'] })
    expect(readTag('English')).toMatchObject({ lang: 'en' })
    expect(readTag('pt-BR')).toMatchObject({ lang: 'pt' })
    expect(readTag('ger.sdh')).toMatchObject({ lang: 'de', flags: ['sdh'] })
    expect(readTag('')).toEqual({ tag: '', lang: null, flags: [] })
    expect(readTag('part2')).toMatchObject({ lang: null })
  })

  it('labels by language, else by file name', () => {
    expect(subtitleLabel(readTag('ja'), 'clip.ja.srt')).toBe('Japanese')
    expect(subtitleLabel(readTag('en.forced'), 'clip.en.forced.srt')).toBe('English (forced)')
    expect(subtitleLabel(readTag(''), 'clip.srt')).toBe('clip.srt')
  })
})

describe('pairSubtitles', () => {
  const f = (name: string) => ({ name })

  it('matches name.srt, name.lang.vtt and name.lang.flag.srt', () => {
    const pairs = pairSubtitles(['Clip One.mp4'], [f('Clip One.srt'), f('clip one.en.vtt'), f('Clip One.eng.forced.srt'), f('Clip One.ass')])
    expect(pairs.map(p => [p.file.name, p.name.lang])).toEqual([
      ['Clip One.srt', null],
      ['clip one.en.vtt', 'en'],
      ['Clip One.eng.forced.srt', 'en'],
      ['Clip One.ass', null],
    ])
  })

  it('leaves unrelated and non-subtitle files alone', () => {
    const pairs = pairSubtitles(['clip.mp4'], [f('clipper.srt'), f('clip 2.srt'), f('clip.funscript'), f('other.en.srt')])
    expect(pairs).toEqual([])
  })

  it('handles dots in the video name', () => {
    const pairs = pairSubtitles(['my.video.name.mkv'], [f('my.video.name.en.srt'), f('my.video.name.srt')])
    expect(pairs.map(p => p.name.tag)).toEqual(['en', ''])
  })

  it('gives a subtitle to the longest matching video name', () => {
    const pairs = pairSubtitles(['clip.mp4', 'clip.part2.mp4'], [f('clip.part2.en.srt'), f('clip.en.srt')])
    expect(pairs.map(p => [p.file.name, p.video])).toEqual([['clip.part2.en.srt', 1], ['clip.en.srt', 0]])
  })

  it('takes no more than three tags', () => {
    expect(pairSubtitles(['a.mp4'], [f('a.b.c.d.e.srt')])).toEqual([])
    expect(pairSubtitles(['a.mp4'], [f('a.b.c.d.srt')])).toHaveLength(1)
  })
})

describe('pickTrack', () => {
  const tracks = sortTracks([
    { id: 'ja', lang: 'ja', label: 'Japanese' },
    { id: 'enf', lang: 'en', label: 'English (forced)', flags: ['forced'] },
    { id: 'en', lang: 'en', label: 'English' },
    { id: 'plain', lang: null, label: 'clip.srt' },
  ])

  it('sorts untagged first, then by label', () => {
    expect(tracks.map(t => t.id)).toEqual(['plain', 'en', 'enf', 'ja'])
  })

  it('prefers the remembered language, full before forced', () => {
    expect(pickTrack(tracks, 'en')?.id).toBe('en')
    expect(pickTrack(tracks, 'ja')?.id).toBe('ja')
  })

  it('falls back to the first track, or none', () => {
    expect(pickTrack(tracks, 'fr')?.id).toBe('plain')
    expect(pickTrack(tracks, null)?.id).toBe('plain')
    expect(pickTrack([], 'en')).toBeNull()
  })
})

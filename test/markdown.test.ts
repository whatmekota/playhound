import { describe, expect, it } from 'vitest'
import { githubMarkdown, inlines, parseMarkdown } from '~/lib/markdown'

const gh = githubMarkdown('o/r')

describe('markdown blocks', () => {
  it('reads headings, paragraphs, rules and code', () => {
    const b = parseMarkdown('# Title #\n\nSome *text*\nwrapped.\n\n---\n\n```js\nconst a = 1 < 2\n```\n\n    indented\n\nUnderlined\n----------')
    expect(b.map(x => x.t)).toEqual(['h', 'p', 'hr', 'code', 'code', 'h'])
    expect(b[0]).toEqual({ t: 'h', level: 1, c: [{ t: 'text', v: 'Title' }] })
    expect(b[1]).toEqual({ t: 'p', c: [{ t: 'text', v: 'Some ' }, { t: 'em', c: [{ t: 'text', v: 'text' }] }, { t: 'text', v: ' wrapped.' }] })
    expect(b[3]).toEqual({ t: 'code', lang: 'js', v: 'const a = 1 < 2' })
    expect(b[4]).toEqual({ t: 'code', lang: '', v: 'indented' })
    expect(b[5]).toMatchObject({ t: 'h', level: 2 })
  })

  it('reads nested lists and quotes', () => {
    const b = parseMarkdown('- one\n- two\n  - deeper\n- three\n\n1. first\n2. second\n\n> quoted\n> more')
    expect(b[0]).toMatchObject({ t: 'list', ordered: false })
    const items = (b[0] as any).items
    expect(items).toHaveLength(3)
    expect(items[1][1]).toMatchObject({ t: 'list', items: [[{ t: 'p' }]] })
    expect(b[1]).toMatchObject({ t: 'list', ordered: true, start: 1 })
    expect(b[2]).toMatchObject({ t: 'quote', c: [{ t: 'p', c: [{ t: 'text', v: 'quoted more' }] }] })
  })

  it('reads tables', () => {
    const b = parseMarkdown('| Path | What |\n|---|:--:|\n| a | **b** |\n| c |')
    expect(b[0]).toMatchObject({ t: 'table', align: [null, 'center'] })
    expect((b[0] as any).rows[0][1]).toEqual([{ t: 'strong', c: [{ t: 'text', v: 'b' }] }])
    expect((b[0] as any).rows[1]).toEqual([[{ t: 'text', v: 'c' }], []])
  })
})

describe('markdown inlines', () => {
  it('reads code, strong, strikethrough and escapes', () => {
    expect(inlines('`a*b*` **bold** ~~gone~~ \\*not em\\*')).toEqual([
      { t: 'code', v: 'a*b*' },
      { t: 'text', v: ' ' },
      { t: 'strong', c: [{ t: 'text', v: 'bold' }] },
      { t: 'text', v: ' ' },
      { t: 'del', c: [{ t: 'text', v: 'gone' }] },
      { t: 'text', v: ' *not em*' },
    ])
  })
  it('leaves snake_case and lone stars alone', () => {
    expect(inlines('snake_case_name and 2 * 3 * 4')).toEqual([{ t: 'text', v: 'snake_case_name and 2 * 3 * 4' }])
  })
})

describe('markdown from strangers stays text', () => {
  it('never turns HTML into anything but its text, an image or a break', () => {
    const b = parseMarkdown('<script>alert(1)</script>\n\nHi <b onclick="x()">there</b><br><iframe src="https://evil"></iframe>')
    expect(JSON.stringify(b)).not.toMatch(/script|alert|onclick|iframe/)
    expect(b).toEqual([
      { t: 'p', c: [{ t: 'text', v: 'Hi there' }, { t: 'br' }] },
    ])
  })

  it('drops a paragraph that was only tags, and HTML comments', () => {
    expect(parseMarkdown('<p align="center">\n</p>\n\n<!-- hidden -->')).toEqual([])
  })

  it('opens only http(s) links, and makes relative ones point at the repository', () => {
    expect(inlines('[a](javascript:alert(1)) [b](docs/x.md) [c](https://example.com) [d](#anchor)', gh)).toEqual([
      { t: 'text', v: 'a ' },
      { t: 'link', href: 'https://github.com/o/r/blob/HEAD/docs/x.md', c: [{ t: 'text', v: 'b' }] },
      { t: 'text', v: ' ' },
      { t: 'link', href: 'https://example.com/', c: [{ t: 'text', v: 'c' }] },
      { t: 'text', v: ' d' },
    ])
  })

  it('links bare URLs without the sentence\'s punctuation', () => {
    expect(inlines('See https://example.com/a_(b).', gh)).toEqual([
      { t: 'text', v: 'See ' },
      { t: 'link', href: 'https://example.com/a_(b)', c: [{ t: 'text', v: 'https://example.com/a_(b)' }] },
      { t: 'text', v: '.' },
    ])
  })

  it('loads images only from GitHub; others show their alt text', () => {
    expect(inlines('![shot](docs/shot.png)', gh)).toEqual([{ t: 'img', src: 'https://raw.githubusercontent.com/o/r/HEAD/docs/shot.png', alt: 'shot' }])
    expect(inlines('![badge](https://img.shields.io/x.svg)', gh)).toEqual([{ t: 'text', v: 'badge' }])
    expect(inlines('<img src="https://github.com/o/r/blob/main/a.png" alt="A">', gh)).toEqual([{ t: 'img', src: 'https://raw.githubusercontent.com/o/r/main/a.png', alt: 'A' }])
    expect(inlines('![x](http://raw.githubusercontent.com/o/r/a.png)', gh)).toEqual([{ t: 'text', v: 'x' }])
    expect(inlines('![x](https://github.com/o/r/issues)', gh)).toEqual([{ t: 'text', v: 'x' }])
  })

  it('keeps an image inside a link', () => {
    expect(inlines('[![logo](logo.png)](https://example.com)', gh)).toEqual([
      { t: 'link', href: 'https://example.com/', c: [{ t: 'img', src: 'https://raw.githubusercontent.com/o/r/HEAD/logo.png', alt: 'logo' }] },
    ])
  })

  it('with no options, links and images are text', () => {
    expect(inlines('[a](https://x.y) ![b](https://x.y/i.png)')).toEqual([{ t: 'text', v: 'a b' }])
  })
})

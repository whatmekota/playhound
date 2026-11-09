/**
 * A small Markdown reader for text playhound didn't write: plugin READMEs,
 * long descriptions and release notes. It builds a tree that the UI renders
 * element by element (never as an HTML string), so nothing in the text can
 * become markup or script.
 *
 * Covered: headings (# and underlined), paragraphs, emphasis, strong,
 * strikethrough, inline code, fenced and indented code, block quotes, nested
 * lists, rules, GFM tables, links, images and bare URLs. Raw HTML is not
 * rendered: tags are dropped and their text kept, except <img> (an image, by
 * the same rules as ![]()) and <br>. Links and images go through the
 * caller's `link` and `image` checks; a refused link is plain text, a
 * refused image its alt text.
 */

export type Inline
  = | { t: 'text', v: string }
    | { t: 'code', v: string }
    | { t: 'strong' | 'em' | 'del', c: Inline[] }
    | { t: 'link', href: string, c: Inline[] }
    | { t: 'img', src: string, alt: string }
    | { t: 'br' }

export type Align = 'left' | 'center' | 'right' | null

export type Block
  = | { t: 'h', level: number, c: Inline[] }
    | { t: 'p', c: Inline[] }
    | { t: 'code', lang: string, v: string }
    | { t: 'quote', c: Block[] }
    | { t: 'list', ordered: boolean, start: number, items: Block[][] }
    | { t: 'hr' }
    | { t: 'table', align: Align[], head: Inline[][], rows: Inline[][][] }

export interface MarkdownOptions {
  /** The address a link goes to, or null to show it as plain text. */
  link?: (href: string) => string | null
  /** The address an image loads from, or null to show its alt text. */
  image?: (src: string) => string | null
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t](.*))?$/
const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const QUOTE_RE = /^ {0,3}>\s?/
const LIST_RE = /^( {0,3})([-*+]|\d{1,9}[.)])(\s+|$)/
const SETEXT_RE = /^ {0,3}(?:=+|-+)[ \t]*$/

const blank = (l: string) => !l.trim()

/** A table's |---|:--:| line. */
function isTableSep(line: string): boolean {
  let s = line.trim()
  if (s.startsWith('|'))
    s = s.slice(1)
  if (s.endsWith('|'))
    s = s.slice(0, -1)
  return !!s && s.split('|').every(c => /^:?-+:?$/.test(c.trim()))
}

function startsBlock(line: string): boolean {
  return FENCE_RE.test(line) || HEADING_RE.test(line) || HR_RE.test(line) || QUOTE_RE.test(line) || LIST_RE.test(line)
}

/** Read Markdown into blocks. */
export function parseMarkdown(src: string, opts: MarkdownOptions = {}): Block[] {
  const text = src
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    // What's inside these was never meant to be read.
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/\t/g, '    ')
  return blocks(text.split('\n'), opts)
}

function blocks(lines: string[], opts: MarkdownOptions): Block[] {
  const out: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (blank(line)) {
      i++
      continue
    }

    const fence = line.match(FENCE_RE)
    if (fence) {
      const mark = fence[1]
      const indent = line.match(/^ */)![0].length
      const body: string[] = []
      i++
      while (i < lines.length && !new RegExp(`^ {0,3}${mark[0] === '`' ? '`' : '~'}{${mark.length},}\\s*$`).test(lines[i])) {
        body.push(lines[i].replace(new RegExp(`^ {0,${indent}}`), ''))
        i++
      }
      i++
      out.push({ t: 'code', lang: fence[2] ?? '', v: body.join('\n') })
      continue
    }

    const heading = line.match(HEADING_RE)
    if (heading) {
      // Closing #s are decoration.
      let title = (heading[2] ?? '').trim()
      const closing = title.match(/(?:^|[ \t])#+$/)
      if (closing)
        title = title.slice(0, closing.index).trim()
      out.push({ t: 'h', level: heading[1].length, c: inlines(title, opts) })
      i++
      continue
    }

    if (HR_RE.test(line)) {
      out.push({ t: 'hr' })
      i++
      continue
    }

    if (QUOTE_RE.test(line)) {
      const body: string[] = []
      while (i < lines.length && !blank(lines[i]) && (QUOTE_RE.test(lines[i]) || body.length)) {
        if (!QUOTE_RE.test(lines[i]) && startsBlock(lines[i]))
          break
        body.push(lines[i].replace(QUOTE_RE, ''))
        i++
      }
      out.push({ t: 'quote', c: blocks(body, opts) })
      continue
    }

    const item = line.match(LIST_RE)
    if (item) {
      i = list(lines, i, out, opts)
      continue
    }

    if (/^ {4}/.test(line)) {
      const body: string[] = []
      while (i < lines.length && (/^ {4}/.test(lines[i]) || blank(lines[i]))) {
        body.push(lines[i].slice(4))
        i++
      }
      while (body.length && blank(body[body.length - 1]))
        body.pop()
      out.push({ t: 'code', lang: '', v: body.join('\n') })
      continue
    }

    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const align = cells(lines[i + 1]).map((c): Align => {
        const l = c.startsWith(':')
        const r = c.endsWith(':')
        return l && r ? 'center' : r ? 'right' : l ? 'left' : null
      })
      const head = cells(line).map(c => inlines(c, opts))
      const rows: Inline[][][] = []
      i += 2
      while (i < lines.length && !blank(lines[i]) && lines[i].includes('|')) {
        const row = cells(lines[i]).map(c => inlines(c, opts))
        rows.push(Array.from({ length: head.length }, (_, k) => row[k] ?? []))
        i++
      }
      out.push({ t: 'table', align: Array.from({ length: head.length }, (_, k) => align[k] ?? null), head, rows })
      continue
    }

    // A paragraph: up to a blank line or something that starts a block.
    const para: string[] = [line]
    i++
    while (i < lines.length && !blank(lines[i]) && !startsBlock(lines[i])) {
      if (SETEXT_RE.test(lines[i]))
        break
      para.push(lines[i])
      i++
    }
    if (i < lines.length && SETEXT_RE.test(lines[i]) && !blank(lines[i])) {
      out.push({ t: 'h', level: lines[i].trim().startsWith('=') ? 1 : 2, c: inlines(para.join('\n'), opts) })
      i++
      continue
    }
    const c = inlines(para.join('\n'), opts)
    // A paragraph that was only HTML tags leaves nothing.
    if (c.some(n => n.t !== 'br' && (n.t !== 'text' || n.v.trim())))
      out.push({ t: 'p', c })
  }
  return out
}

/** A list from line i; returns the line after it. */
function list(lines: string[], i: number, out: Block[], opts: MarkdownOptions): number {
  const first = lines[i].match(LIST_RE)!
  const ordered = /\d/.test(first[2])
  const start = ordered ? Number.parseInt(first[2]) : 1
  const sameKind = (m: RegExpMatchArray) => /\d/.test(m[2]) === ordered
  const items: Block[][] = []
  while (i < lines.length) {
    const m = lines[i].match(LIST_RE)
    if (!m || !sameKind(m))
      break
    const content = m[1].length + m[2].length + Math.min(Math.max(m[3].length, 1), 4)
    const body: string[] = [lines[i].slice(content)]
    i++
    let sawBlank = false
    while (i < lines.length) {
      const l = lines[i]
      if (blank(l)) {
        sawBlank = true
        body.push('')
        i++
        continue
      }
      const indent = l.match(/^ */)![0].length
      if (indent >= content) {
        body.push(l.slice(content))
      }
      else if (!sawBlank && !startsBlock(l)) {
        // A lazy continuation of the item's paragraph.
        body.push(l.trim())
      }
      else {
        break
      }
      sawBlank = false
      i++
    }
    while (body.length && blank(body[body.length - 1]))
      body.pop()
    items.push(blocks(body, opts))
    // A blank line between items is fine; anything else after one ends the list.
    if (i < lines.length && !LIST_RE.test(lines[i]))
      break
  }
  out.push({ t: 'list', ordered, start, items })
  return i
}

function cells(row: string): string[] {
  let s = row.trim()
  if (s.startsWith('|'))
    s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|'))
    s = s.slice(0, -1)
  return s.split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'))
}

// ─── Inline ──────────────────────────────────────────────────────────────────

const PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null
}

/** The index of the `)` closing a link destination that opens at `from` (after the `(`), or -1. */
function closeParen(s: string, from: number): number {
  let depth = 0
  for (let k = from; k < s.length; k++) {
    const ch = s[k]
    if (ch === '\\') {
      k++
      continue
    }
    if (ch === '\n' && s[k + 1] === '\n')
      return -1
    if (ch === '(') {
      depth++
    }
    else if (ch === ')') {
      if (!depth)
        return k
      depth--
    }
  }
  return -1
}

/** The index of the `]` closing a bracket that opens at `from` (after the `[`), or -1. */
function closeBracket(s: string, from: number): number {
  let depth = 0
  for (let k = from; k < s.length; k++) {
    const ch = s[k]
    if (ch === '\\') {
      k++
      continue
    }
    if (ch === '`') {
      const run = s.slice(k).match(/^`+/)![0]
      const end = s.indexOf(run, k + run.length)
      if (end > 0)
        k = end + run.length - 1
      continue
    }
    if (ch === '[') {
      depth++
    }
    else if (ch === ']') {
      if (!depth)
        return k
      depth--
    }
  }
  return -1
}

/** "url" or "url "title"" or "<url>" → the URL. */
function destination(raw: string): string {
  const s = raw.trim()
  if (s.startsWith('<')) {
    const end = s.indexOf('>')
    return end > 0 ? s.slice(1, end) : s
  }
  return s.split(/\s+/)[0]
}

function plain(nodes: Inline[]): string {
  return nodes.map(n => (n.t === 'text' || n.t === 'code' ? n.v : n.t === 'img' ? n.alt : 'c' in n ? plain(n.c) : '')).join('')
}

/** Inline Markdown into nodes. */
export function inlines(s: string, opts: MarkdownOptions = {}): Inline[] {
  const out: Inline[] = []
  let buf = ''
  const flush = () => {
    if (buf) {
      const last = out[out.length - 1]
      if (last?.t === 'text')
        last.v += buf
      else out.push({ t: 'text', v: buf })
      buf = ''
    }
  }
  const push = (n: Inline) => {
    flush()
    out.push(n)
  }
  const image = (src: string, alt: string) => {
    const ok = opts.image?.(src) ?? null
    if (ok)
      push({ t: 'img', src: ok, alt })
    else if (alt)
      buf += alt
  }

  let i = 0
  while (i < s.length) {
    const ch = s[i]

    if (ch === '\\' && i + 1 < s.length) {
      if (s[i + 1] === '\n') {
        push({ t: 'br' })
        i += 2
        continue
      }
      if (PUNCT.includes(s[i + 1])) {
        buf += s[i + 1]
        i += 2
        continue
      }
    }

    if (ch === '\n') {
      if (/ {2,}$/.test(buf)) {
        buf = buf.replace(/ +$/, '')
        push({ t: 'br' })
      }
      else {
        buf = `${buf.replace(/ +$/, '')} `
      }
      i++
      while (s[i] === ' ')
        i++
      continue
    }

    if (ch === '`') {
      const run = s.slice(i).match(/^`+/)![0]
      const end = s.indexOf(run, i + run.length)
      if (end > 0 && s[end + run.length] !== '`') {
        let code = s.slice(i + run.length, end).replace(/\n/g, ' ')
        if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim())
          code = code.slice(1, -1)
        push({ t: 'code', v: code })
        i = end + run.length
        continue
      }
      buf += run
      i += run.length
      continue
    }

    if (ch === '!' && s[i + 1] === '[') {
      const close = closeBracket(s, i + 2)
      if (close > 0 && s[close + 1] === '(') {
        const end = closeParen(s, close + 2)
        if (end > 0) {
          image(destination(s.slice(close + 2, end)), plain(inlines(s.slice(i + 2, close))))
          i = end + 1
          continue
        }
      }
    }

    if (ch === '[') {
      const close = closeBracket(s, i + 1)
      if (close > 0 && s[close + 1] === '(') {
        const end = closeParen(s, close + 2)
        if (end > 0) {
          const inner = inlines(s.slice(i + 1, close), { ...opts, link: () => null })
          const href = opts.link?.(destination(s.slice(close + 2, end))) ?? null
          if (href) {
            push({ t: 'link', href, c: inner })
          }
          else {
            for (const n of inner) {
              if (n.t === 'text')
                buf += n.v
              else push(n)
            }
          }
          i = end + 1
          continue
        }
      }
    }

    if (ch === '<') {
      const auto = s.slice(i).match(/^<(https?:\/\/[^\s<>]+)>/i)
      if (auto) {
        const href = opts.link?.(auto[1]) ?? null
        if (href)
          push({ t: 'link', href, c: [{ t: 'text', v: auto[1] }] })
        else buf += auto[1]
        i += auto[0].length
        continue
      }
      const tag = s.slice(i).match(/^<\/?([a-z][a-z0-9-]*)(?:\s[^<>]*)?\/?>/i)
      if (tag) {
        const name = tag[1].toLowerCase()
        if (name === 'img') {
          const src = attr(tag[0], 'src')
          if (src)
            image(src, attr(tag[0], 'alt') ?? '')
        }
        else if (name === 'br') {
          push({ t: 'br' })
        }
        i += tag[0].length
        continue
      }
    }

    if ((ch === 'h' || ch === 'H') && /^https?:\/\//i.test(s.slice(i, i + 8)) && !/[\w/]$/.test(buf)) {
      let url = s.slice(i).match(/^https?:\/\/[^\s<]+/i)![0]
      // Trailing punctuation belongs to the sentence; a ) only if it isn't closing a ( in the URL.
      while (/[.,:;!?'"*_~]$/.test(url) || (url.endsWith(')') && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)))
        url = url.slice(0, -1)
      const href = opts.link?.(url) ?? null
      if (href)
        push({ t: 'link', href, c: [{ t: 'text', v: url }] })
      else buf += url
      i += url.length
      continue
    }

    if (ch === '*' || ch === '_' || ch === '~') {
      const run = s.slice(i).match(ch === '*' ? /^\*+/ : ch === '_' ? /^_+/ : /^~+/)![0]
      const prev = i > 0 ? s[i - 1] : ' '
      const next = s[i + run.length] ?? ' '
      // _ inside a word (snake_case) is just a character; so is a run before a space.
      const opens = !/\s/.test(next) && !(ch === '_' && /[\p{L}\p{N}]/u.test(prev))
      if (opens && (ch !== '~' || run.length === 2)) {
        const size = ch === '~' ? 2 : Math.min(run.length, 3)
        const delim = ch.repeat(size)
        const end = findClose(s, i + size, delim, ch)
        if (end > 0) {
          const inner = inlines(s.slice(i + size, end), opts)
          if (ch === '~')
            push({ t: 'del', c: inner })
          else if (size === 3)
            push({ t: 'strong', c: [{ t: 'em', c: inner }] })
          else push({ t: size === 2 ? 'strong' : 'em', c: inner })
          i = end + size
          continue
        }
      }
      buf += run
      i += run.length
      continue
    }

    buf += ch
    i++
  }
  flush()
  return out
}

/** The closing `delim` for an emphasis opened before `from`: not after a space, not inside a word for _. */
function findClose(s: string, from: number, delim: string, ch: string): number {
  let k = from
  while (k < s.length) {
    if (s[k] === '\\') {
      k += 2
      continue
    }
    if (s[k] === '`') {
      const run = s.slice(k).match(/^`+/)![0]
      const end = s.indexOf(run, k + run.length)
      k = end > 0 ? end + run.length : k + run.length
      continue
    }
    if (s.startsWith(delim, k) && k > from && !/\s/.test(s[k - 1])) {
      const after = s[k + delim.length] ?? ' '
      const longer = s[k + delim.length] === ch
      if (!longer && !(ch === '_' && /[\p{L}\p{N}]/u.test(after)))
        return k
      // Skip the whole run, so ** doesn't close *.
      while (s[k] === ch)
        k++
      continue
    }
    if (s[k] === '\n' && s[k + 1] === '\n')
      return -1
    k++
  }
  return -1
}

// ─── GitHub ──────────────────────────────────────────────────────────────────

/** Where images in a README may load from: GitHub's own hosts. */
export const GITHUB_IMAGE_HOSTS = ['raw.githubusercontent.com', 'user-images.githubusercontent.com', 'camo.githubusercontent.com', 'objects.githubusercontent.com', 'github.com']

/**
 * Link and image rules for a repository's Markdown: links open on the web
 * (relative ones on the repository's GitHub page), images only from GitHub
 * (relative ones from the repository itself).
 */
export function githubMarkdown(repo: string | null): Required<MarkdownOptions> {
  const resolve = (u: string, base: string): URL | null => {
    try {
      return new URL(u, base)
    }
    catch {
      return null
    }
  }
  return {
    link(href) {
      if (href.startsWith('#'))
        return null
      if (!repo && !/^https?:\/\//i.test(href))
        return null
      const u = resolve(href, `https://github.com/${repo}/blob/HEAD/`)
      return u && (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : null
    },
    image(src) {
      if (!repo && !/^https:\/\//i.test(src))
        return null
      const u = resolve(src, `https://raw.githubusercontent.com/${repo}/HEAD/`)
      if (!u || u.protocol !== 'https:' || !GITHUB_IMAGE_HOSTS.includes(u.hostname))
        return null
      // A file's page on github.com is HTML; its raw form is the picture.
      if (u.hostname === 'github.com') {
        const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/)
        if (m)
          return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`
        if (!/^\/[^/]+\/[^/]+\/raw\//.test(u.pathname) && !u.pathname.startsWith('/user-attachments/'))
          return null
      }
      return u.href
    },
  }
}

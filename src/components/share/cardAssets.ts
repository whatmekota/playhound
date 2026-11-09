import type { CardAssets, Pic } from './drawCard'
import wordmarkSvg from '~/assets/brand/wordmark.svg?raw'
import { logoUrl } from '~/lib/logos'
import { WORDMARK } from '~/lib/wordmarkStyle'

/**
 * What a share card needs before it can be drawn: the fonts (a canvas draws
 * in the fallback rather than wait for a web font) and the brand marks as
 * images. Loaded once and kept.
 */

const FONTS = [
  '400 16px Geist',
  '500 16px Geist',
  '600 16px Geist',
  '700 16px Geist',
  '800 16px Geist',
  '400 16px "Geist Mono"',
  '500 16px "Geist Mono"',
  '500 16px Fredoka',
  '600 16px Fredoka',
  '700 16px Fredoka',
]

/** Wait for the card's fonts, but not forever: offline, the fallbacks will do. */
export async function loadCardFonts(timeoutMs = 4000): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts)
    return
  const all = Promise.all(FONTS.map(f => document.fonts.load(f).catch(() => [])))
  await Promise.race([all, new Promise(r => setTimeout(r, timeoutMs))])
}

/** The wordmark with its colour variables filled in for `logo`'s colouring. */
function wordmarkFor(logo: keyof typeof WORDMARK): string {
  const c = WORDMARK[logo]
  const vars: Record<string, string> = {
    '--wm-top': c.top,
    '--wm-mid': c.mid,
    '--wm-bot': c.bot,
    '--wm-rim': c.rim,
    '--wm-halo': c.halo,
    '--wm-icing': c.icing,
    '--wm-icing-shade': c.icingShade,
    '--wm-heart': c.heart,
    '--wm-deco': c.deco,
  }
  const coloured = wordmarkSvg.replace(/var\((--wm-[a-z-]+)\)/g, (m, name: string) => vars[name] ?? m)
  return tightWordmark(coloured)
}

/**
 * The splash's wordmark has sparkles and paws scattered around it, and room
 * for them. At the size of a corner mark they are specks, so leave them out
 * and crop to the letters (with their halo).
 */
function tightWordmark(svg: string): string {
  const from = svg.indexOf('<g class="wm-deco"')
  const to = svg.indexOf('<g class="wm-halo"')
  const bare = from >= 0 && to > from ? svg.slice(0, from) + svg.slice(to) : svg
  if (typeof document === 'undefined')
    return bare
  const host = document.createElement('div')
  host.style.cssText = 'position:absolute;left:-9999px;top:0;width:10px;height:10px;overflow:hidden;visibility:hidden'
  host.innerHTML = bare
  document.body.appendChild(host)
  try {
    const halo = host.querySelector<SVGGraphicsElement>('.wm-halo')
    const b = halo?.getBBox()
    if (!b || !b.width)
      return bare
    // The halo's stroke (39 wide) is not in its box: half of it shows outside.
    const pad = 22
    const vb = `${(b.x - pad).toFixed(1)} ${(b.y - pad).toFixed(1)} ${(b.width + pad * 2).toFixed(1)} ${(b.height + pad * 2).toFixed(1)}`
    return bare.replace(/viewBox="[^"]+"/, `viewBox="${vb}"`)
  }
  finally {
    host.remove()
  }
}

/**
 * An SVG as an image, given a size so it is drawn crisp (an SVG with only a
 * viewBox comes out 300 wide and is scaled up from that).
 */
async function svgPic(svg: string, width: number): Promise<Pic | null> {
  const vb = /viewBox="([^"]+)"/.exec(svg)?.[1].split(/[\s,]+/).map(Number)
  if (!vb || vb.length !== 4)
    return null
  const height = Math.round((width * vb[3]) / vb[2])
  const sized = svg.replace(/<svg\b/, `<svg width="${width}" height="${height}"`)
  const url = URL.createObjectURL(new Blob([sized], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    return { img, w: width, h: height }
  }
  catch {
    return null
  }
  finally {
    // The decoded image keeps its pixels; the URL is not needed after.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}

let cached: Promise<CardAssets> | null = null

/** Fonts and marks, loaded once. */
export function loadCardAssets(): Promise<CardAssets> {
  cached ??= (async () => {
    const stickerPic = fetch(logoUrl('sly-grin', true, true)).then(r => r.text()).then(t => svgPic(t, 480)).catch(() => null)
    // The logo's own pink on every look: its pale rim reads on dark cards,
    // on Candy's pink and over a frame alike, where the night colouring's
    // dark letters sank into the card.
    const [, wordmark, sticker] = await Promise.all([
      loadCardFonts(),
      svgPic(wordmarkFor('sly-grin'), 1600),
      stickerPic,
    ])
    return { wordmark, sticker }
  })()
  return cached
}

/** An image from a URL (a data URL from the player, a thumbnail), or null. */
export async function picFromUrl(url: string): Promise<Pic | null> {
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    return { img, w: img.naturalWidth, h: img.naturalHeight }
  }
  catch {
    return null
  }
}

/**
 * Plugins' effects on the picture itself (player.effects, API 4): a CSS
 * transform, filter and opacity per plugin, stacked in the order they were
 * set, on whatever shows the picture (the <video>, the pop-out's mirror, the
 * VR view). Written straight to the elements' style, not through Vue: a
 * plugin may change them every frame, and re-rendering the player that often
 * would cost far more than the effect.
 */
import type { Directive } from 'vue'
import type { PictureEffects } from './types'

const MAX_CSS = 600

const sets = new Map<string, PictureEffects>()
const targets = new Set<HTMLElement>()

function clean(fx: PictureEffects): PictureEffects | null {
  const out: PictureEffects = {}
  if (typeof fx.transform === 'string' && fx.transform.trim())
    out.transform = fx.transform.slice(0, MAX_CSS)
  if (typeof fx.filter === 'string' && fx.filter.trim())
    out.filter = fx.filter.slice(0, MAX_CSS)
  if (typeof fx.opacity === 'number' && Number.isFinite(fx.opacity) && fx.opacity < 1)
    out.opacity = Math.max(0, fx.opacity)
  return out.transform || out.filter || out.opacity !== undefined ? out : null
}

/** What all plugins' effects add up to, as CSS ('' where nothing applies). */
export function composeFx(list: Iterable<PictureEffects>): { transform: string, filter: string, opacity: string } {
  const transforms: string[] = []
  const filters: string[] = []
  let opacity = 1
  for (const fx of list) {
    if (fx.transform)
      transforms.push(fx.transform)
    if (fx.filter)
      filters.push(fx.filter)
    if (fx.opacity !== undefined)
      opacity *= fx.opacity
  }
  return { transform: transforms.join(' '), filter: filters.join(' '), opacity: opacity < 1 ? String(opacity) : '' }
}

function paint(el: HTMLElement, css = composeFx(sets.values())) {
  el.style.transform = css.transform
  el.style.filter = css.filter
  el.style.opacity = css.opacity
}

function apply() {
  const css = composeFx(sets.values())
  for (const el of targets)
    paint(el, css)
}

/** Set (or clear, with null) one plugin's effects. Returns whether any are set. */
export function setPictureFx(owner: string, fx: PictureEffects | null): boolean {
  const c = fx && typeof fx === 'object' ? clean(fx) : null
  if (c)
    sets.set(owner, c)
  else if (!sets.delete(owner))
    return false
  apply()
  return !!c
}

export function clearPictureFx(owner: string) {
  if (sets.delete(owner))
    apply()
}

/** `v-picture-fx` on an element that shows the picture. */
export const vPictureFx: Directive<HTMLElement> = {
  mounted(el) {
    targets.add(el)
    if (sets.size)
      paint(el)
  },
  unmounted(el) {
    targets.delete(el)
  },
}

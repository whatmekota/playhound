import type { FunscriptAction } from './funscriptParser'
import { clamp } from './motionMath'

/**
 * Linked axes: another axis follows the stroke (L0), a little later or
 * earlier, turned up or down, the right way round or inverted. The way
 * MultiFunPlayer users fill an SR6 from a one-axis script: surge trailing
 * the stroke by a few tens of ms, pitch inverted with it, and so on. Unlike
 * the generated fill (axisSynth), the axis moves exactly as the stroke does.
 *
 * Pure: a link and the stroke in, the axis out.
 */

export interface AxisLink {
  channel: string
  on: boolean
  /** ms: positive trails the stroke, negative leads it. */
  delayMs: number
  invert: boolean
  /** How much of the stroke's travel it gets, 0–1, around the middle. */
  amount: number
}

export const LINKABLE_AXES = [
  { channel: 'L1', label: 'Surge' },
  { channel: 'L2', label: 'Sway' },
  { channel: 'R0', label: 'Twist' },
  { channel: 'R1', label: 'Roll' },
  { channel: 'R2', label: 'Pitch' },
] as const

export const LINK_DELAY_MAX = 500

export function defaultLinks(): AxisLink[] {
  return LINKABLE_AXES.map(a => ({ channel: a.channel, on: false, delayMs: 0, invert: false, amount: 1 }))
}

/** Saved links, made safe: every linkable axis once, values in range. */
export function sanitizeLinks(raw: unknown): AxisLink[] {
  const saved = Array.isArray(raw) ? raw : []
  return defaultLinks().map((d) => {
    const s = saved.find((x: any) => x && x.channel === d.channel) as Partial<AxisLink> | undefined
    if (!s)
      return d
    return {
      channel: d.channel,
      on: s.on === true,
      delayMs: typeof s.delayMs === 'number' ? Math.round(clamp(s.delayMs, -LINK_DELAY_MAX, LINK_DELAY_MAX)) : 0,
      invert: s.invert === true,
      amount: typeof s.amount === 'number' ? clamp(s.amount, 0, 1) : 1,
    }
  })
}

/** A saved set of links: every linkable axis, on or off. */
export interface LinkPreset {
  id: string
  name: string
  links: AxisLink[]
  builtin?: boolean
}

function builtin(id: string, name: string, set: Record<string, Partial<AxisLink>>): LinkPreset {
  return { id, name, builtin: true, links: defaultLinks().map(d => (set[d.channel] ? { ...d, on: true, ...set[d.channel] } : d)) }
}

/** Starting points: the usual ways to fill a multi-axis device from a one-axis script. */
export const BUILTIN_LINK_PRESETS: LinkPreset[] = [
  builtin('builtin-sr6', 'SR6 fill', { L1: { delayMs: 60, amount: 0.6 }, R2: { invert: true, amount: 0.6 } }),
  builtin('builtin-rock', 'Rocking', { R2: { delayMs: 40, amount: 0.7 }, L1: { delayMs: 120, invert: true, amount: 0.5 } }),
  builtin('builtin-twist', 'Twist along', { R0: { delayMs: 30, amount: 0.5 } }),
]

/** Whether two sets of links do the same: the settings of an axis that's off don't count. */
export function sameLinks(a: readonly AxisLink[], b: readonly AxisLink[]): boolean {
  return LINKABLE_AXES.every(({ channel }) => {
    const x = a.find(l => l.channel === channel)
    const y = b.find(l => l.channel === channel)
    if (!x?.on || !y?.on)
      return !x?.on && !y?.on
    return x.delayMs === y.delayMs && x.invert === y.invert && Math.abs(x.amount - y.amount) < 0.005
  })
}

/** Saved presets, made safe. */
export function sanitizeLinkPresets(raw: unknown): LinkPreset[] {
  if (!Array.isArray(raw))
    return []
  return raw
    .filter((p: any) => p && typeof p.id === 'string' && typeof p.name === 'string' && p.name.trim())
    .map((p: any) => ({ id: p.id, name: p.name.trim().slice(0, 40), links: sanitizeLinks(p.links) }))
}

/** The linked axis's position, 0–1, for a stroke position 0–1. */
export function linkedPosition(strokePos: number, link: Pick<AxisLink, 'invert' | 'amount'>): number {
  const p = link.invert ? 1 - strokePos : strokePos
  return clamp(0.5 + (p - 0.5) * clamp(link.amount, 0, 1), 0, 1)
}

/** Links that may drive their axis: on, and not an axis the script drives itself. */
export function activeLinks(links: readonly AxisLink[], scriptChannels: Iterable<string>): AxisLink[] {
  const taken = new Set(scriptChannels)
  return links.filter(l => l.on && !taken.has(l.channel))
}

const linkedCache = new WeakMap<readonly FunscriptAction[], Map<string, FunscriptAction[]>>()

/**
 * The stroke script as the linked axis plays it: shifted by the delay, its
 * positions mapped. Kept per script and link, so the per-frame sampling and
 * scaling that cache by the actions array keep working.
 */
export function linkedActions(actions: readonly FunscriptAction[], link: Pick<AxisLink, 'delayMs' | 'invert' | 'amount'>): FunscriptAction[] {
  const key = `${link.delayMs}|${link.invert}|${link.amount}`
  let byKey = linkedCache.get(actions)
  if (!byKey) {
    byKey = new Map()
    linkedCache.set(actions, byKey)
  }
  let out = byKey.get(key)
  if (!out) {
    out = actions.map(a => ({ at: a.at + link.delayMs, pos: Math.round(linkedPosition(a.pos / 100, link) * 1000) / 10 }))
    // Old settings for this script aren't needed again.
    if (byKey.size > 8)
      byKey.clear()
    byKey.set(key, out)
  }
  return out
}

/**
 * Generated motion has no script to read ahead in: a short history of where
 * the stroke was, to play it back later. A lead can't be known, so it plays
 * as no delay.
 */
export function createStrokeHistory(keepMs = LINK_DELAY_MAX + 100) {
  const ts: number[] = []
  const pos: number[] = []
  return {
    push(t: number, p: number) {
      ts.push(t)
      pos.push(p)
      while (ts.length > 2 && ts[0] < t - keepMs) {
        ts.shift()
        pos.shift()
      }
    },
    /** Where the stroke was `delayMs` ago. */
    at(t: number, delayMs: number): number | null {
      if (!ts.length)
        return null
      const want = t - Math.max(0, delayMs)
      if (want <= ts[0])
        return pos[0]
      for (let i = ts.length - 1; i > 0; i--) {
        if (ts[i - 1] <= want) {
          const span = ts[i] - ts[i - 1]
          const f = span > 0 ? Math.min(1, (want - ts[i - 1]) / span) : 1
          return pos[i - 1] + (pos[i] - pos[i - 1]) * f
        }
      }
      return pos[pos.length - 1]
    },
    clear() {
      ts.length = 0
      pos.length = 0
    },
  }
}

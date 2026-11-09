/**
 * A picture for an audio file that has none of its own: its script, drawn
 * small. The stroke line across the middle and the speed heatmap along the
 * bottom, on a colour of its own taken from the name, so tracks tell apart
 * at a glance in the library grid.
 *
 * The numbers are worked out here, Vue- and DOM-free so they are tested;
 * thumbs.ts does the drawing.
 */

export interface TileAction { at: number, pos: number }

export interface TileColumns {
  /** Mean position per column, 0–100; NaN where the script says nothing. */
  pos: number[]
  /** Fastest move per column, in funscript units (0–100) a second. */
  speed: number[]
}

/** The actions of a funscript's text, sorted; [] for anything unreadable. */
export function tileActions(text: string): TileAction[] {
  try {
    const raw = JSON.parse(text)
    const list = Array.isArray(raw?.actions) ? raw.actions : []
    return list
      .filter((a: any) => Number.isFinite(a?.at) && Number.isFinite(a?.pos))
      .map((a: any) => ({ at: Number(a.at), pos: Math.max(0, Math.min(100, Number(a.pos))) }))
      .sort((a: TileAction, b: TileAction) => a.at - b.at)
  }
  catch {
    return []
  }
}

/** The script squeezed into `cols` columns across `durationMs` (its own length when not given). */
export function tileColumns(actions: readonly TileAction[], cols: number, durationMs?: number): TileColumns {
  const pos = Array.from<number>({ length: cols }).fill(Number.NaN)
  const speed = Array.from<number>({ length: cols }).fill(0)
  const dur = durationMs && durationMs > 0 ? durationMs : actions.at(-1)?.at ?? 0
  if (actions.length < 2 || dur <= 0 || cols <= 0)
    return { pos, speed }
  const sum = Array.from<number>({ length: cols }).fill(0)
  const n = Array.from<number>({ length: cols }).fill(0)
  const col = (t: number) => Math.min(cols - 1, Math.max(0, Math.floor((t / dur) * cols)))
  for (let i = 1; i < actions.length; i++) {
    const a = actions[i - 1]
    const b = actions[i]
    const dt = b.at - a.at
    if (dt <= 0)
      continue
    const v = (Math.abs(b.pos - a.pos) / dt) * 1000
    const c0 = col(a.at)
    const c1 = col(b.at)
    for (let c = c0; c <= c1; c++) {
      speed[c] = Math.max(speed[c], v)
      // The line where it crosses the column's middle.
      const t = ((c + 0.5) / cols) * dur
      if (t < a.at || t > b.at)
        continue
      sum[c] += a.pos + ((b.pos - a.pos) * (t - a.at)) / dt
      n[c]++
    }
  }
  for (let c = 0; c < cols; c++)
    pos[c] = n[c] ? sum[c] / n[c] : Number.NaN
  return { pos, speed }
}

/** A steady hue for a name, so the same track always gets the same colour. */
export function tileHue(name: string): number {
  let h = 2166136261
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) % 360
}

/**
 * Heatmap colour for a speed in units a second, the scale the timeline uses
 * (EroScripts' funlib): blue through green and yellow to red as it rises.
 */
export function tileHeat(speed: number): string {
  const hue = (((210 - speed / 2.4) % 360) + 360) % 360
  return `hsl(${Math.round(hue)} 85% ${speed > 500 ? 38 : 55}%)`
}

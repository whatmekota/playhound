/**
 * Geometry for the media wall: snapping while dragging or resizing, and
 * tidying everything into a grid. Pure functions, so the maths stays apart
 * from the pointer handling in the tiles.
 */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Guide {
  axis: 'x' | 'y'
  pos: number
}

/** Which edges a gesture moves. A move moves all four. */
export interface Edges {
  left: boolean
  right: boolean
  top: boolean
  bottom: boolean
}

export const MOVE_EDGES: Edges = { left: true, right: true, top: true, bottom: true }

export const SNAP_PX = 8
export const MIN_W = 96
export const MIN_H = 64

function targets(others: Rect[], size: number, axis: 'x' | 'y') {
  const out = [0, size / 2, size]
  for (const o of others) {
    const a = axis === 'x' ? o.x : o.y
    const l = axis === 'x' ? o.w : o.h
    out.push(a, a + l / 2, a + l)
  }
  return out
}

/** Smallest shift (within the threshold) that puts one of `lines` on a target. */
function bestShift(lines: number[], cands: number[]) {
  let best: { d: number, pos: number } | null = null
  for (const l of lines) {
    for (const c of cands) {
      const d = c - l
      if (Math.abs(d) <= SNAP_PX && (!best || Math.abs(d) < Math.abs(best.d)))
        best = { d, pos: c }
    }
  }
  return best
}

/**
 * Snap a rect being moved or resized to the wall's edges and centre lines and
 * to the edges and centres of the other tiles. Returns the snapped rect and the
 * guide lines to draw.
 */
export function snapRect(r: Rect, edges: Edges, others: Rect[], bounds: { w: number, h: number }): { rect: Rect, guides: Guide[] } {
  const out = { ...r }
  const guides: Guide[] = []
  const moving = edges.left && edges.right

  const xs = targets(others, bounds.w, 'x')
  if (moving) {
    const s = bestShift([r.x, r.x + r.w / 2, r.x + r.w], xs)
    if (s) {
      out.x += s.d
      guides.push({ axis: 'x', pos: s.pos })
    }
  }
  else if (edges.left) {
    const s = bestShift([r.x], xs)
    if (s && r.w - s.d >= MIN_W) {
      out.x += s.d
      out.w -= s.d
      guides.push({ axis: 'x', pos: s.pos })
    }
  }
  else if (edges.right) {
    const s = bestShift([r.x + r.w], xs)
    if (s && r.w + s.d >= MIN_W) {
      out.w += s.d
      guides.push({ axis: 'x', pos: s.pos })
    }
  }

  const ys = targets(others, bounds.h, 'y')
  const movingY = edges.top && edges.bottom
  if (movingY) {
    const s = bestShift([r.y, r.y + r.h / 2, r.y + r.h], ys)
    if (s) {
      out.y += s.d
      guides.push({ axis: 'y', pos: s.pos })
    }
  }
  else if (edges.top) {
    const s = bestShift([r.y], ys)
    if (s && r.h - s.d >= MIN_H) {
      out.y += s.d
      out.h -= s.d
      guides.push({ axis: 'y', pos: s.pos })
    }
  }
  else if (edges.bottom) {
    const s = bestShift([r.y + r.h], ys)
    if (s && r.h + s.d >= MIN_H) {
      out.h += s.d
      guides.push({ axis: 'y', pos: s.pos })
    }
  }

  return { rect: out, guides }
}

/**
 * Resize from a handle. `dir` is -1/0/1 per axis (which edge the handle sits
 * on); `keepAspect` locks the starting ratio, driven by the larger change.
 */
export function resizeRect(start: Rect, dir: { x: number, y: number }, dx: number, dy: number, keepAspect: boolean): Rect {
  let w = dir.x ? Math.max(MIN_W, start.w + dir.x * dx) : start.w
  let h = dir.y ? Math.max(MIN_H, start.h + dir.y * dy) : start.h

  if (keepAspect) {
    const ratio = start.w / start.h
    if (!dir.y || (dir.x && Math.abs(w - start.w) / start.w >= Math.abs(h - start.h) / start.h))
      h = Math.max(MIN_H, w / ratio)
    else
      w = Math.max(MIN_W, h * ratio)
  }

  // Handles on the left or top edge move the origin so the far edge stays put.
  const x = dir.x < 0 ? start.x + start.w - w : dir.x === 0 && keepAspect ? start.x + (start.w - w) / 2 : start.x
  const y = dir.y < 0 ? start.y + start.h - h : dir.y === 0 && keepAspect ? start.y + (start.h - h) / 2 : start.y
  return { x, y, w, h }
}

/**
 * Lay tiles out in an even grid that fills the wall, each keeping its own
 * aspect ratio inside its cell. `top` keeps clear of the floating toolbar.
 */
export function arrangeGrid(aspects: number[], bounds: { w: number, h: number }, gap = 16, top = 64): Rect[] {
  const n = aspects.length
  if (!n)
    return []
  const W = Math.max(200, bounds.w - gap * 2)
  const H = Math.max(150, bounds.h - top - gap)

  // Pick the column count whose cells come closest to the tiles' average shape
  // while staying as large as possible.
  const avg = aspects.reduce((a, b) => a + b, 0) / n
  let best = { cols: 1, score: -Infinity }
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols)
    const cw = (W - gap * (cols - 1)) / cols
    const ch = (H - gap * (rows - 1)) / rows
    if (cw <= 0 || ch <= 0)
      continue
    const area = Math.min(cw, ch * avg) * Math.min(ch, cw / avg)
    if (area > best.score)
      best = { cols, score: area }
  }

  const cols = best.cols
  const rows = Math.ceil(n / cols)
  const cw = (W - gap * (cols - 1)) / cols
  const ch = (H - gap * (rows - 1)) / rows
  return aspects.map((a, i) => {
    const c = i % cols
    const r = Math.floor(i / cols)
    const w = Math.min(cw, ch * a)
    const h = w / a
    return {
      x: Math.round(gap + c * (cw + gap) + (cw - w) / 2),
      y: Math.round(top + r * (ch + gap) + (ch - h) / 2),
      w: Math.round(w),
      h: Math.round(h),
    }
  })
}

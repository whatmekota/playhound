/**
 * How a VR video is laid out, for the VR view (SbsViewer).
 *
 * The frame holds the two eyes side by side (most VR), one above the other
 * (top-bottom, common for 360° and some JAV), or one picture for both
 * (mono). Each eye's part is either equirectangular (longitude across,
 * latitude up, the usual 180°) or a fisheye circle, which is what most
 * 190°–220° studio footage is (SLR's MKX200, RF52 and the like). The field of
 * view is how much of the sphere it covers.
 */

export type VrProjection = 'equirect' | 'fisheye'

/** Which half of a side-by-side frame the VR view shows. Some videos are sharper, or better framed, in one eye. */
export type VrEye = 'left' | 'right'

/** Where the eyes are in the frame: left | right, top (left eye) over bottom, or one picture. */
export type VrLayout = 'sbs' | 'tb' | 'mono'

export const VR_LAYOUTS: { value: VrLayout, label: string }[] = [
  { value: 'sbs', label: 'Side by side' },
  { value: 'tb', label: 'Top-bottom' },
  { value: 'mono', label: 'Mono' },
]

export interface VrFormat {
  id: string
  label: string
  /** For the dock button. */
  short: string
  projection: VrProjection
  /** Degrees. */
  fov: number
}

export const VR_FORMATS: VrFormat[] = [
  { id: 'eq180', label: '180° equirectangular', short: '180°', projection: 'equirect', fov: 180 },
  { id: 'eq190', label: '190° equirectangular', short: '190°', projection: 'equirect', fov: 190 },
  { id: 'eq200', label: '200° equirectangular', short: '200°', projection: 'equirect', fov: 200 },
  { id: 'eq360', label: '360° equirectangular', short: '360°', projection: 'equirect', fov: 360 },
  { id: 'fe180', label: '180° fisheye', short: 'F180', projection: 'fisheye', fov: 180 },
  { id: 'fe190', label: '190° fisheye', short: 'F190', projection: 'fisheye', fov: 190 },
  { id: 'fe200', label: '200° fisheye', short: 'F200', projection: 'fisheye', fov: 200 },
  { id: 'fe220', label: '220° fisheye', short: 'F220', projection: 'fisheye', fov: 220 },
]

export const DEFAULT_VR_FORMAT = 'eq180'

export function vrFormat(id: string | null | undefined): VrFormat {
  return VR_FORMATS.find(f => f.id === id) ?? VR_FORMATS[0]
}

/**
 * The format a file name gives away, if it does: studios tag their files
 * (`_MKX200`, `_FISHEYE190`, `_RF52`, `_180_LR`). Null when it says nothing,
 * so the viewer keeps whatever was chosen last.
 */
export function guessVrFormat(name: string): string | null {
  const n = name.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  if (/(?:mkx|vrca|fisheye)[\s_-]?220/.test(n))
    return 'fe220'
  if (/(?:mkx|fisheye)[\s_-]?200/.test(n))
    return 'fe200'
  if (/rf52|fisheye[\s_-]?190/.test(n))
    return 'fe190'
  if (/fisheye[\s_-]?180/.test(n))
    return 'fe180'
  if (/fisheye/.test(n))
    return 'fe190'
  if (/(?:^|[^a-z0-9])360(?![0-9p])/.test(n))
    return 'eq360'
  if (/(?:^|\D)180[\s_-]?(?:x180[\s_-]?)?(?:sbs|lr|3dh)(?![a-z])/.test(n) || /(?:sbs|lr|3dh)[\s_-]?180(?!\d)/.test(n))
    return 'eq180'
  return null
}

/**
 * The layout a file name gives away: `_TB`, `_OU`, `3dv`, `over-under` are
 * top-bottom; `_LR`, `_SBS`, `3dh` side by side; `_mono` one picture. Null
 * when it says nothing.
 */
export function guessVrLayout(name: string): VrLayout | null {
  const n = name.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  if (/(?:^|[^a-z0-9])(?:tb|ou|3dv|over[\s_-]?under|top[\s_-]?bottom)(?:[^a-z0-9]|$)/.test(n))
    return 'tb'
  if (/(?:^|[^a-z0-9])(?:lr|rl|sbs|3dh|side[\s_-]?by[\s_-]?side)(?:[^a-z0-9]|$)/.test(n))
    return 'sbs'
  if (/(?:^|[^a-z0-9])mono(?:[^a-z0-9]|$)/.test(n) && /(?:^|[^a-z0-9])(?:vr|180|360)(?:[^a-z0-9]|$)/.test(n))
    return 'mono'
  return null
}

/**
 * Side-by-side VR is two eyes in one frame; a crop of the middle is the seam
 * between them, so pictures take one eye instead. By shape (2:1), or a wide
 * frame whose name says VR.
 */
export function looksSbs(name: string, w: number, h: number) {
  const aspect = w / h
  return (aspect > 1.95 && aspect < 2.05)
    || (aspect > 1.6 && /(?:^|[^a-z0-9])(?:180|vr|sbs|lr|3dh)(?:[^a-z0-9]|$)/i.test(name))
}

/**
 * Shape alone is enough to open the VR view only for a big 2:1 frame: VR is
 * 4K wide and up, while a phone's 18:9 screen recording is 2:1 too.
 */
export function looksSbsBySize(w: number, h: number) {
  const aspect = w / h
  return aspect > 1.95 && aspect < 2.05 && w >= 3800
}

/**
 * A frame that holds two eyes, by name and shape: side by side, a big square
 * or 1:2 one, or one the name calls top-bottom that isn't wide (a flat video
 * is; " ou " in a French title says nothing).
 */
export function looksVrFrame(name: string, w: number, h: number): boolean {
  return looksSbs(name, w, h) || !!looksTbBySize(w, h) || (guessVrLayout(name) === 'tb' && w / h <= 1.05)
}

/** A rectangle of a video frame, in its pixels. */
export interface FrameRect { sx: number, sy: number, sw: number, sh: number }

/**
 * Where a VR frame's eyes are, for pictures of it: what the name says, else
 * the shape (a big square or 1:2 frame is top-bottom, a 2:1 one side by
 * side), else side by side for a wide frame known to be VR, else one picture.
 */
export function frameLayout(name: string, w: number, h: number, vr = false): VrLayout {
  const named = guessVrLayout(name)
  if (named)
    return named
  if (looksTbBySize(w, h))
    return 'tb'
  if (looksSbs(name, w, h) || (vr && w / h > 1.6))
    return 'sbs'
  return 'mono'
}

/**
 * The part of a frame that shows one eye, for thumbnails, scrub previews and
 * share cards: the left half of side by side, the top half of top-bottom,
 * the whole of anything else. A crop of the middle would be the seam.
 */
export function oneEyeRect(name: string, w: number, h: number, vr = false): FrameRect {
  const layout = frameLayout(name, w, h, vr)
  if (layout === 'tb')
    return { sx: 0, sy: 0, sw: w, sh: h / 2 }
  if (layout === 'sbs')
    return { sx: 0, sy: 0, sw: w / 2, sh: h }
  return { sx: 0, sy: 0, sw: w, sh: h }
}

/**
 * Top-bottom VR by its shape: two 360° eyes (2:1 each) stack into a square,
 * two 180° ones (1:1) into a 1:2 frame. Only big ones: a flat video is never
 * 3K wide and square. The format it suggests, or null.
 */
export function looksTbBySize(w: number, h: number): 'eq360' | 'eq180' | null {
  const aspect = w / h
  if (w >= 3000 && aspect > 0.95 && aspect < 1.05)
    return 'eq360'
  if (w >= 1900 && aspect > 0.48 && aspect < 0.52)
    return 'eq180'
  return null
}

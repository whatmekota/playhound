/**
 * How a side-by-side VR video is laid out, for the VR view (SbsViewer).
 *
 * Each eye's half of the frame is either equirectangular (longitude across,
 * latitude up, the usual 180°) or a fisheye circle, which is what most
 * 190°–220° studio footage is (SLR's MKX200, RF52 and the like). The field of
 * view is how much of the sphere the half covers.
 */

export type VrProjection = 'equirect' | 'fisheye'

/** Which half of a side-by-side frame the VR view shows. Some videos are sharper, or better framed, in one eye. */
export type VrEye = 'left' | 'right'

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
  if (/(?:^|\D)180[\s_-]?(?:x180[\s_-]?)?(?:sbs|lr|3dh)(?![a-z])/.test(n) || /(?:sbs|lr|3dh)[\s_-]?180(?!\d)/.test(n))
    return 'eq180'
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

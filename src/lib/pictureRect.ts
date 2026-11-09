/** Where a picture of vw×vh is drawn in a W×H box with object-fit: contain (centred, letterboxed or pillarboxed). */
export function containRect(W: number, H: number, vw: number, vh: number) {
  if (!(W > 0) || !(H > 0) || !(vw > 0) || !(vh > 0))
    return null
  const scale = Math.min(W / vw, H / vh)
  const width = vw * scale
  const height = vh * scale
  return { x: (W - width) / 2, y: (H - height) / 2, width, height, areaWidth: W, areaHeight: H }
}

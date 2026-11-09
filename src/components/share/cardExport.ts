/**
 * Getting a card out: onto the clipboard, into a folder, or through the
 * system's save dialog (a download where there is none).
 */

/** Put a PNG on the clipboard. Throws where the clipboard takes no images. */
export async function copyPng(png: Blob | Promise<Blob>): Promise<void> {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write)
    throw new Error('No image clipboard here')
  // A promise keeps the click's permission while the image is still being made.
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
}

/** Write `png` as `name` in `dir`, replacing a file of that name. */
export async function writePng(dir: FileSystemDirectoryHandle, name: string, png: Blob): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true })
  const w = await (handle as any).createWritable()
  await w.write(png)
  await w.close()
}

export function downloadPng(png: Blob, name: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(png)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
}

/**
 * Save through the system's dialog, starting in `startIn` when given; a
 * download where there is no dialog. Must be called from a click. Returns
 * the name it was saved as, 'download', or null when cancelled.
 */
export async function savePngAs(png: Blob, suggestedName: string, startIn?: FileSystemDirectoryHandle | null): Promise<string | null> {
  const pick = (window as any).showSaveFilePicker
  if (typeof pick !== 'function') {
    downloadPng(png, suggestedName)
    return 'download'
  }
  let handle: FileSystemFileHandle
  try {
    handle = await pick({
      suggestedName,
      startIn: startIn ?? 'pictures',
      id: 'playhound-cards',
      types: [{ description: 'PNG image', accept: { 'image/png': ['.png'] } }],
    })
  }
  catch (err) {
    if ((err as DOMException)?.name === 'AbortError')
      return null
    downloadPng(png, suggestedName)
    return 'download'
  }
  const w = await (handle as any).createWritable()
  await w.write(png)
  await w.close()
  return handle.name
}

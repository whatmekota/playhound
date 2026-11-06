/**
 * Putting funscripts on disk: next to a video in its library folder, through
 * the system's save dialog, or as a download when neither is possible (a
 * browser without the File System Access API, a video that did not come
 * from a library folder).
 *
 * Text in, files out: what goes in a funscript is funscriptWrite's job, so
 * anything that produces a script (the editor, a session recording) can
 * save through here.
 */

export async function fileExists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name)
    return true
  }
  catch {
    return false
  }
}

/** Write `text` to `name` in `dir` (created or replaced) and return the file as it is now. */
export async function writeTextFile(dir: FileSystemDirectoryHandle, name: string, text: string): Promise<File> {
  const handle = await dir.getFileHandle(name, { create: true })
  return writeToHandle(handle, text)
}

export async function writeToHandle(handle: FileSystemFileHandle, text: string): Promise<File> {
  const w = await (handle as any).createWritable()
  await w.write(new Blob([text], { type: 'application/json' }))
  await w.close()
  return handle.getFile()
}

/**
 * The first time a file is overwritten, keep what it said as `<name>.bak`
 * beside it. Never again after that: the backup is the original, not the
 * last save. Returns true when it wrote one.
 */
export async function backupOnce(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  const bak = `${name}.bak`
  if (await fileExists(dir, bak))
    return false
  let original: string
  try {
    original = await (await (await dir.getFileHandle(name)).getFile()).text()
  }
  catch {
    // Nothing there yet: nothing to keep.
    return false
  }
  await writeTextFile(dir, bak, original)
  return true
}

export function downloadText(text: string, name: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

export type SaveAsResult
  = | { kind: 'file', handle: FileSystemFileHandle, file: File }
    | { kind: 'download' }
    | { kind: 'cancelled' }

/**
 * Save under a name the user picks: the system's save dialog where there is
 * one (the desktop app, Chrome, Edge), starting in `startIn` when given;
 * otherwise a download named `suggestedName`. Must be called from a click.
 */
export async function saveTextAs(text: string, suggestedName: string, startIn?: FileSystemDirectoryHandle | null): Promise<SaveAsResult> {
  const pick = (window as any).showSaveFilePicker
  if (typeof pick !== 'function') {
    downloadText(text, suggestedName)
    return { kind: 'download' }
  }
  let handle: FileSystemFileHandle
  try {
    handle = await pick({
      suggestedName,
      startIn: startIn ?? undefined,
      id: 'playhound-scripts',
      types: [{ description: 'Funscript', accept: { 'application/json': ['.funscript'] } }],
    })
  }
  catch (err) {
    if ((err as DOMException)?.name === 'AbortError')
      return { kind: 'cancelled' }
    // A picker that will not open here (a sandboxed frame): fall back to a download.
    downloadText(text, suggestedName)
    return { kind: 'download' }
  }
  const file = await writeToHandle(handle, text)
  return { kind: 'file', handle, file }
}

/** "clip.funscript" → "clip (edited).funscript": a name the library pairs with the video as another take. */
export function takeName(scriptName: string, take: string): string {
  const base = scriptName.replace(/\.funscript$/i, '')
  // Drop a take name this tool added before, so it does not pile up.
  const clean = base.replace(/ \((?:edited|tweaked)\)$/i, '')
  return `${clean} (${take}).funscript`
}

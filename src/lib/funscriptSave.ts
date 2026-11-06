/**
 * Writing funscripts out: into a folder the app holds a handle to (the
 * library's, desktop and Chrome alike), or as downloads where there is none.
 *
 * Kept small and free of app state so anything that saves scripts (the
 * recorder now, the script editor later) can share it.
 */

export interface ScriptFileOut {
  name: string
  text: string
}

/** Where files go: a folder handle, or the browser's downloads. */
export type SaveTarget
  = | { kind: 'folder', dir: FileSystemDirectoryHandle, /** Shown to the user: "Videos/sub". */ label: string }
    | { kind: 'download', label: string }

/** Names in a folder, lower-cased, to check what a save would replace. */
export async function namesIn(dir: FileSystemDirectoryHandle): Promise<Set<string>> {
  const out = new Set<string>()
  try {
    for await (const name of (dir as any).keys() as AsyncIterable<string>)
      out.add(name.toLowerCase())
  }
  catch {}
  return out
}

/** Read-write access to a folder. Call from a click: it may show the browser's prompt. */
export async function canWrite(dir: FileSystemDirectoryHandle): Promise<boolean> {
  const h = dir as any
  if (!('queryPermission' in h))
    return true
  try {
    let perm = await h.queryPermission({ mode: 'readwrite' })
    if (perm !== 'granted')
      perm = await h.requestPermission({ mode: 'readwrite' })
    return perm === 'granted'
  }
  catch {
    return false
  }
}

/** Write each file, replacing one of the same name. */
export async function saveScripts(target: SaveTarget, files: ScriptFileOut[]): Promise<void> {
  if (target.kind === 'download') {
    for (const f of files)
      download(f)
    return
  }
  for (const f of files) {
    const handle = await target.dir.getFileHandle(f.name, { create: true })
    const w = await (handle as any).createWritable()
    await w.write(new Blob([f.text], { type: 'application/json' }))
    await w.close()
  }
}

function download(f: ScriptFileOut) {
  const url = URL.createObjectURL(new Blob([f.text], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = f.name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

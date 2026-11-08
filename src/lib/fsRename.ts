import type { FsEntry } from '~/lib/fsWalk'

/** Strip characters illegal in Windows/macOS filenames */
export function sanitizeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control chars is the point
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '').trim()
}

/** Extension including leading dot, e.g. ".funscript" — empty string if none */
export function extOf(name: string): string {
  const m = name.match(/\.[^.]+$/)
  return m ? m[0] : ''
}

async function exists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name)
    return true
  }
  catch {
    return false
  }
}

/**
 * Rename a file in place. Prefers the modern FileSystemHandle.move() (fast, atomic,
 * preserves the handle identity) and falls back to copy-then-delete for browsers
 * that don't support it yet.
 */
export async function renameEntry(entry: FsEntry, newName: string): Promise<FsEntry> {
  if (newName === entry.name)
    return entry
  // move() and the copy below would both replace a file already there. A
  // change of case only is the same file on Windows and macOS: let it through.
  if (newName.toLowerCase() !== entry.name.toLowerCase() && await exists(entry.dirHandle, newName))
    throw new Error(`"${newName}" is already in that folder`)
  const handle: any = entry.fileHandle

  if (typeof handle.move === 'function') {
    await handle.move(newName)
    const file = await handle.getFile()
    return {
      ...entry,
      name: newName,
      relPath: entry.dirRelPath ? `${entry.dirRelPath}/${newName}` : newName,
      file,
    }
  }

  // Fallback: copy bytes into a new handle, then remove the old one.
  const buf = await entry.file.arrayBuffer()
  const newHandle = await entry.dirHandle.getFileHandle(newName, { create: true })
  const writable = await (newHandle as any).createWritable()
  await writable.write(buf)
  await writable.close()
  await entry.dirHandle.removeEntry(entry.name)
  const file = await newHandle.getFile()
  return {
    ...entry,
    name: newName,
    fileHandle: newHandle,
    relPath: entry.dirRelPath ? `${entry.dirRelPath}/${newName}` : newName,
    file,
  }
}

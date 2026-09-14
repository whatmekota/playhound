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

/**
 * Rename a file in place. Prefers the modern FileSystemHandle.move() (fast, atomic,
 * preserves the handle identity) and falls back to copy-then-delete for browsers
 * that don't support it yet.
 */
export async function renameEntry(entry: FsEntry, newName: string): Promise<FsEntry> {
  if (newName === entry.name)
    return entry
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

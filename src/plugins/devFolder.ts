/**
 * Plugin dev mode in the browser: a plugin read from a folder picked with
 * the File System Access API. There is no file watching in a browser, so the
 * folder is looked at about once a second and reloaded when a file in it
 * changed (its size or modified time; see folderSignature).
 *
 * Dependencies and VCS folders (node_modules, .git, anything starting with a
 * dot) are skipped: a plugin is one bundled module, and walking them every
 * second would be slow.
 */

export interface DevFile { path: string, data: Uint8Array }

export const DEV_MAX_FILES = 2000
export const DEV_MAX_BYTES = 64 * 1024 * 1024

/** Names never walked into or read. */
export function skipName(name: string): boolean {
  return name === 'node_modules' || name.startsWith('.')
}

/** One line per file, sorted; it changes when any file is added, removed or saved. */
export function signatureOf(files: { path: string, size: number, lastModified: number }[]): string {
  return files.map(f => `${f.path}|${f.size}|${f.lastModified}`).sort().join('\n')
}

async function listFiles(dir: FileSystemDirectoryHandle, prefix = '', out: { path: string, file: File }[] = []) {
  for await (const entry of (dir as any).values() as AsyncIterable<FileSystemHandle>) {
    if (skipName(entry.name))
      continue
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.kind === 'directory') {
      await listFiles(entry as FileSystemDirectoryHandle, path, out)
    }
    else {
      if (out.length >= DEV_MAX_FILES)
        throw new Error(`More than ${DEV_MAX_FILES} files in the folder`)
      out.push({ path, file: await (entry as FileSystemFileHandle).getFile() })
    }
  }
  return out
}

/** What is in the folder now, without reading the files. */
export async function folderSignature(dir: FileSystemDirectoryHandle): Promise<string> {
  const files = await listFiles(dir)
  return signatureOf(files.map(f => ({ path: f.path, size: f.file.size, lastModified: f.file.lastModified })))
}

/** Every file in the folder, read, with its signature. */
export async function readFolder(dir: FileSystemDirectoryHandle): Promise<{ files: DevFile[], signature: string }> {
  const listed = await listFiles(dir)
  let bytes = 0
  const files: DevFile[] = []
  for (const f of listed) {
    bytes += f.file.size
    if (bytes > DEV_MAX_BYTES)
      throw new Error('More than 64 MB in the folder')
    files.push({ path: f.path, data: new Uint8Array(await f.file.arrayBuffer()) })
  }
  return {
    files,
    signature: signatureOf(listed.map(f => ({ path: f.path, size: f.file.size, lastModified: f.file.lastModified }))),
  }
}

/** Whether the folder can be read without asking; asks only when `ask` (it needs a click). */
export async function canRead(dir: FileSystemDirectoryHandle, ask = false): Promise<boolean> {
  const h = dir as any
  try {
    if (await h.queryPermission?.({ mode: 'read' }) === 'granted')
      return true
    return ask && await h.requestPermission?.({ mode: 'read' }) === 'granted'
  }
  catch {
    return false
  }
}

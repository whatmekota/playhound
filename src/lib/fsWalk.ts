// Recursive directory walker that preserves FileSystemFileHandle/DirectoryHandle
// (unlike browserApi.collectHandleFiles, which discards handles and only keeps File blobs).
// Handles are required for in-place rename via fsRename.ts.

export interface FsEntry {
  name: string
  /** Path relative to the walked root, e.g. "sub/folder/video.mp4" */
  relPath: string
  /** Directory portion of relPath, e.g. "sub/folder" (empty string at root) */
  dirRelPath: string
  dirHandle: FileSystemDirectoryHandle
  fileHandle: FileSystemFileHandle
  file: File
}

export async function walkDirectory(dir: FileSystemDirectoryHandle, relPath = ''): Promise<FsEntry[]> {
  const out: FsEntry[] = []
  for await (const handle of (dir as any).values()) {
    if (handle.kind === 'file') {
      try {
        const file = await handle.getFile()
        out.push({
          name: handle.name,
          relPath: relPath ? `${relPath}/${handle.name}` : handle.name,
          dirRelPath: relPath,
          dirHandle: dir,
          fileHandle: handle,
          file,
        })
      }
      catch {
        // Skip files that can't be read (permission race, deleted mid-scan, etc.)
      }
    }
    else if (handle.kind === 'directory') {
      const childRel = relPath ? `${relPath}/${handle.name}` : handle.name
      try {
        out.push(...await walkDirectory(handle, childRel))
      }
      catch {
        // Skip unreadable subdirectories
      }
    }
  }
  return out
}

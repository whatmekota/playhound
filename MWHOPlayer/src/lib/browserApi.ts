// Browser-native file & serial APIs — replaces the Electron preload bridge

// ── File System Access API ────────────────────────────────────────────────────

export async function openVideoFile(): Promise<File | null> {
  if ('showOpenFilePicker' in window) {
    try {
      const [handle] = await (window as any).showOpenFilePicker({
        types: [{
          description: 'Video Files',
          accept: { 'video/*': ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v', '.wmv', '.flv'] }
        }],
        multiple: false
      })
      return await handle.getFile()
    } catch {
      return null // user cancelled
    }
  }
  // Fallback: classic input
  return inputFilePicker(['video/*', '.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v', '.wmv'])
}

export async function openScriptFiles(): Promise<File[]> {
  if ('showOpenFilePicker' in window) {
    try {
      const handles = await (window as any).showOpenFilePicker({
        types: [{ description: 'Funscript Files', accept: { 'application/json': ['.funscript'] } }],
        multiple: true
      })
      return Promise.all(handles.map((h: any) => h.getFile()))
    } catch {
      return []
    }
  }
  const file = await inputFilePicker(['.funscript'], true)
  return file ? (Array.isArray(file) ? file : [file]) : []
}

/** Open an entire directory and return all files in it — alias for openFolderInput */
export const openDirectory = openFolderInput

/**
 * Open a folder picker and return both the files AND the directory handle
 * (handle can be stored in IDB and reused after refresh).
 */
export async function openFolderWithHandle(): Promise<{ files: File[]; handle: FileSystemDirectoryHandle | null }> {
  if ('showDirectoryPicker' in window) {
    try {
      const dirHandle = await (window as any).showDirectoryPicker({ mode: 'read' })
      const files = await collectHandleFiles(dirHandle)
      return { files, handle: dirHandle }
    } catch {
      return { files: [], handle: null }
    }
  }
  const files = await webkitDirInput()
  return { files, handle: null }
}

/**
 * Re-open files from a persisted FileSystemDirectoryHandle.
 * The browser will prompt the user for permission once per session.
 * Returns null if permission is denied or API not available.
 */
export async function reopenFromHandle(handle: FileSystemDirectoryHandle): Promise<File[] | null> {
  if (!handle || !('queryPermission' in handle)) return null
  try {
    let perm = await (handle as any).queryPermission({ mode: 'read' })
    if (perm !== 'granted') {
      perm = await (handle as any).requestPermission({ mode: 'read' })
    }
    if (perm !== 'granted') return null
    return collectHandleFiles(handle)
  } catch {
    return null
  }
}

/**
 * Open a folder picker.
 * Uses showDirectoryPicker() when available (Chrome/Edge 86+) — no scary "upload" dialog.
 * Falls back to webkitdirectory input only if the modern API is unavailable.
 */
export async function openFolderInput(): Promise<File[]> {
  const { files } = await openFolderWithHandle()
  return files
}

async function collectHandleFiles(dirHandle: any): Promise<File[]> {
  const files: File[] = []
  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'file') {
      files.push(await entry.getFile())
    } else if (entry.kind === 'directory') {
      // recurse one level for sub-folders (e.g. organised libraries)
      try {
        const sub = await collectHandleFiles(entry)
        files.push(...sub)
      } catch {}
    }
  }
  return files
}

function webkitDirInput(): Promise<File[]> {
  return new Promise(resolve => {
    const input = document.createElement('input')
    input.type = 'file'
    ;(input as any).webkitdirectory = true
    input.multiple = true
    input.onchange = () => resolve(Array.from(input.files ?? []))
    input.oncancel = () => resolve([])
    input.click()
  })
}

function inputFilePicker(accept: string[], multiple = false): Promise<File | File[] | null> {
  return new Promise(resolve => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept.join(',')
    input.multiple = multiple
    input.onchange = () => {
      const files = Array.from(input.files ?? [])
      resolve(multiple ? files : (files[0] ?? null))
    }
    input.oncancel = () => resolve(null)
    input.click()
  })
}

// ── Settings via localStorage ─────────────────────────────────────────────────

export const storage = {
  get<T>(key: string): T | null {
    try {
      const raw = localStorage.getItem(key)
      return raw ? JSON.parse(raw) : null
    } catch {
      return null
    }
  },
  set(key: string, value: unknown) {
    localStorage.setItem(key, JSON.stringify(value))
  },
  delete(key: string) {
    localStorage.removeItem(key)
  }
}

// ── Web Serial API ────────────────────────────────────────────────────────────

export const webSerial = {
  supported: 'serial' in navigator,

  async listPorts(): Promise<SerialPort[]> {
    if (!this.supported) return []
    return (navigator as any).serial.getPorts()
  },

  async requestPort(): Promise<SerialPort | null> {
    if (!this.supported) return null
    try {
      return await (navigator as any).serial.requestPort()
    } catch {
      return null
    }
  }
}

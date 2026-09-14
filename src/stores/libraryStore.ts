import type { VideoMeta } from '~/lib/idb'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { AXIS_MAP } from '~/lib/axisMap'

export interface ScriptMatch {
  file: File
  isAlt: boolean
  altName: string // e.g. "Bounce" extracted from "(Bounce)" or " Bounce" suffix
}

/** How the script type is classified — drives badge color in library */
export type ScriptType = 'none' | 'single' | 'multi' | 'merged'

export interface VideoEntry {
  file: File
  name: string
  basename: string
  hasScript: boolean
  scriptCount: number
  scriptFiles: File[]
  scriptMatches: ScriptMatch[]
  thumbnailUrl: string | null
  duration: number | null // seconds, populated on first thumbnail/metadata load
  scriptType: ScriptType
  scriptMeta?: VideoMeta
  userMeta?: VideoMeta
  starred: boolean
}

/**
 * Detect merged multi-axis funscript without full parse.
 * Regular single-axis scripts NEVER contain an "axes" key anywhere.
 * Merged scripts do — either top-level or inside metadata.
 * We check the first 1KB (catches metadata.axes style) and
 * last 1KB (catches top-level axes array that comes after the big actions block).
 */
async function sniffIsMerged(file: File): Promise<boolean> {
  try {
    const headBuf = file.slice(0, 1024)
    const tailBuf = file.slice(Math.max(0, file.size - 1024))
    const [head, tail] = await Promise.all([headBuf.text(), tailBuf.text()])
    return /"axes"\s*:/.test(head) || /"axes"\s*:/.test(tail)
  }
  catch {
    return false
  }
}

export const useLibraryStore = defineStore('library', () => {
  const videos = ref<VideoEntry[]>([])
  const scanning = ref(false)
  const folderName = ref('')
  const totalFiles = ref(0)

  const hasVideos = computed(() => videos.value.length > 0)

  // Persist starred video names across sessions
  // Legacy storage key kept so existing data survives the rename.
  const STARS_KEY = 'mwhoplayer:starred'
  const starredNames = new Set<string>(JSON.parse(localStorage.getItem(STARS_KEY) ?? '[]'))

  function toggleStar(entry: VideoEntry) {
    entry.starred = !entry.starred
    if (entry.starred)
      starredNames.add(entry.name)
    else starredNames.delete(entry.name)
    localStorage.setItem(STARS_KEY, JSON.stringify([...starredNames]))
  }

  /**
   * Process files from folder input in async batches so the UI never freezes.
   * Only File *handles* are stored — no file content is ever read here.
   */
  async function setFiles(files: File[]) {
    scanning.value = true
    totalFiles.value = files.length
    folderName.value = files[0]?.webkitRelativePath?.split('/')[0] ?? 'Folder'

    const videoExts = /\.(?:mp4|mkv|webm|avi|mov|m4v|wmv|flv)$/i

    // Build a name→File map for funscripts only (no content read)
    // Key: lowercase filename, Value: File handle
    const scriptMap = new Map<string, File>()
    for (const f of files) {
      if (f.name.toLowerCase().endsWith('.funscript')) {
        scriptMap.set(f.name.toLowerCase(), f)
      }
    }

    // Collect video files
    const videoFiles = files.filter(f => videoExts.test(f.name))

    // Build entries in chunks of 200 to yield to the event loop between chunks
    const CHUNK = 200
    const entries: VideoEntry[] = []

    for (let i = 0; i < videoFiles.length; i += CHUNK) {
      const chunk = videoFiles.slice(i, i + CHUNK)
      for (const f of chunk) {
        const basename = f.name.replace(/\.[^.]+$/, '').toLowerCase()
        const matches: ScriptMatch[] = []

        for (const [key, sf] of scriptMap) {
          if (!key.startsWith(basename))
            continue
          // Strip ".funscript" and the basename prefix to get the suffix
          const withoutExt = key.slice(0, -'.funscript'.length) // e.g. "video (bounce)" or "video.twist"
          const suffix = withoutExt.slice(basename.length).trim() // e.g. " (bounce)" or ".twist" or ""

          // Clean suffix: strip surrounding parens, dots, spaces, dashes → "bounce", "twist", "r0"
          const altName = suffix.replace(/^[\s\-_.(]+|[\s\-_.)]+$/g, '').trim()

          // A known axis key (twist, r0, surge, l1, etc.) → this is a primary axis script, NOT an alt
          const isAxisScript = altName.length > 0 && altName.toLowerCase() in AXIS_MAP
          const isAlt = suffix.length > 0 && !isAxisScript

          matches.push({ file: sf, isAlt, altName: isAlt ? altName : '' })
        }

        // Sort: primary (exact) first, then alts alphabetically
        matches.sort((a, b) => {
          if (a.isAlt !== b.isAlt)
            return a.isAlt ? 1 : -1
          return a.altName.localeCompare(b.altName)
        })

        entries.push({
          file: f,
          name: f.name,
          basename: f.name.replace(/\.[^.]+$/, ''),
          hasScript: matches.length > 0,
          scriptCount: matches.length,
          scriptFiles: matches.map(m => m.file),
          scriptMatches: matches,
          thumbnailUrl: null,
          duration: null,
          scriptType: matches.length === 0 ? 'none' : matches.length === 1 ? 'single' : 'multi',
          starred: starredNames.has(f.name),
        })
      }
      // Yield to browser between chunks
      await new Promise(r => setTimeout(r, 0))
    }

    entries.sort((a, b) => a.name.localeCompare(b.name))
    videos.value = entries
    scanning.value = false

    // ── Post-scan: sniff single-script entries for merged format ──────────
    // Read tail+head of each .funscript to detect merged multi-axis files.
    // Run in batches to stay non-blocking.
    const singleScriptEntries = entries.filter(
      e => e.scriptType === 'single' && e.scriptMatches.length === 1 && !e.scriptMatches[0].isAlt,
    )
    const SNIFF_BATCH = 50
    for (let i = 0; i < singleScriptEntries.length; i += SNIFF_BATCH) {
      const batch = singleScriptEntries.slice(i, i + SNIFF_BATCH)
      await Promise.all(batch.map(async (entry) => {
        const isMerged = await sniffIsMerged(entry.scriptMatches[0].file)
        if (isMerged) {
          entry.scriptType = 'merged'
          entry.scriptCount = 2 // placeholder; real count set after full parse in App.vue
        }
      }))
      // Yield briefly between batches so UI can update
      await new Promise(r => setTimeout(r, 0))
    }
  }

  function clear() {
    videos.value = []
    folderName.value = ''
    totalFiles.value = 0
  }

  return { videos, scanning, folderName, totalFiles, hasVideos, setFiles, clear, toggleStar }
})

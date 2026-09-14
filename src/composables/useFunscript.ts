import { ref } from 'vue'
import { parseFunscriptContent } from '~/lib/funscriptParser'
import { useScriptStore, type ScriptFile } from '~/stores/scriptStore'
import type { ScriptMatch } from '~/stores/libraryStore'

export function useFunscript() {
  const scriptStore = useScriptStore()
  const loading = ref(false)
  const error = ref<string | null>(null)
  /** Raw metadata from the last parsed funscript (for merged scripts, from the main file) */
  const lastRawMetadata = ref<Record<string, unknown> | null>(null)

  /** Auto-detect using pre-resolved ScriptMatch array (carries isAlt/altName). */
  async function autoDetectFromFiles(videoFile: File, matches: ScriptMatch[]) {
    loading.value = true
    error.value = null
    lastRawMetadata.value = null
    try {
      const results = await parseMatches(matches, videoFile.name)
      scriptStore.setAutoDetected(results)
      return results
    } finally {
      loading.value = false
    }
  }

  /** Load specific funscript File objects manually selected by the user. */
  async function loadScriptFiles(files: File[], videoBasename = '') {
    loading.value = true
    error.value = null
    try {
      const matches: ScriptMatch[] = files.map(f => ({ file: f, isAlt: false, altName: '' }))
      const results = await parseMatches(matches, videoBasename)
      scriptStore.setScripts(results)
      return results
    } finally {
      loading.value = false
    }
  }

  async function parseMatches(matches: ScriptMatch[], videoBasename: string): Promise<ScriptFile[]> {
    const results: ScriptFile[] = []
    // Track which channels already have a primary (non-alt) script enabled,
    // so alt scripts for the same channel are kept disabled.
    const enabledChannels = new Set<string>()

    for (const match of matches) {
      const { file, isAlt, altName } = match
      try {
        const content = await file.text()
        const parsed = parseFunscriptContent(content, file.name, videoBasename)
        // Capture metadata from the first (primary) file
        if (!isAlt && parsed.rawMetadata && !lastRawMetadata.value) {
          lastRawMetadata.value = parsed.rawMetadata
        }
        for (const axis of parsed.axes) {
          // Enable all non-alt axes. For alt scripts, only enable if no primary
          // script for that channel has been registered yet.
          const alreadyHasPrimary = enabledChannels.has(axis.channel)
          const enabled = !isAlt && !alreadyHasPrimary
          if (enabled) enabledChannels.add(axis.channel)

          results.push({
            path: file.name,
            filename: file.name,
            channel: axis.channel,
            axisKey: axis.axisKey,
            label: axis.label,
            enabled,
            isAlt,
            altName,
            offsetMs: 0,
            parsed: axis,
          })
        }
      } catch (e: any) {
        error.value = e.message
        console.warn('Failed to parse', file.name, e)
      }
    }
    return results
  }

  return { autoDetectFromFiles, loadScriptFiles, loading, error, lastRawMetadata }
}

import type { ParsedAxis } from '~/lib/funscriptParser'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export interface ScriptFile {
  path: string
  filename: string
  channel: string
  axisKey: string
  label: string
  enabled: boolean
  isAlt: boolean
  altName: string
  offsetMs: number
  parsed: ParsedAxis
}

export const useScriptStore = defineStore('script', () => {
  const scripts = ref<ScriptFile[]>([])
  const autoDetected = ref(false)

  const activeScripts = computed(() => scripts.value.filter(s => s.enabled))
  const hasScripts = computed(() => scripts.value.length > 0)
  const primaryScript = computed(() =>
    scripts.value.find(s => s.channel === 'L0' && s.enabled && !s.isAlt)
    ?? scripts.value.find(s => s.channel === 'L0' && s.enabled)
    ?? activeScripts.value[0] ?? null,
  )

  function setScripts(newScripts: ScriptFile[]) {
    scripts.value = newScripts
    autoDetected.value = false
  }

  function setAutoDetected(newScripts: ScriptFile[]) {
    scripts.value = newScripts
    autoDetected.value = true
  }

  function toggleScript(path: string, channel: string) {
    const s = scripts.value.find(x => x.path === path && x.channel === channel)
    if (!s)
      return
    if (!s.enabled) {
      scripts.value
        .filter(x => x.channel === channel && !(x.path === path && x.channel === channel))
        .forEach((x) => { x.enabled = false })
    }
    s.enabled = !s.enabled
  }

  function clearScripts() {
    scripts.value = []
    autoDetected.value = false
  }

  return {
    scripts,
    autoDetected,
    activeScripts,
    hasScripts,
    primaryScript,
    setScripts,
    setAutoDetected,
    toggleScript,
    clearScripts,
  }
})

// ── Serial command log ────────────────────────────────────────────────────────
import { ref } from 'vue'

export const serialLog = ref<string[]>([])
const MAX_LOG = 200

export function logCommand(cmd: string) {
  const trimmed = cmd.trim()
  if (!trimmed) return
  serialLog.value.unshift(
    `${new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}  ${trimmed}`
  )
  if (serialLog.value.length > MAX_LOG) serialLog.value.length = MAX_LOG
}

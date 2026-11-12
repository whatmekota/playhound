// ── Serial command log ────────────────────────────────────────────────────────
import { ref } from 'vue'

export const serialLog = ref<string[]>([])
const MAX_LOG = 200

// The time label changes once a second; formatting it for every command (dozens
// a second while a script plays) was a noticeable share of the main thread.
let stampSec = -1
let stamp = ''
function timeLabel(): string {
  const now = Date.now()
  const sec = Math.floor(now / 1000)
  if (sec !== stampSec) {
    stampSec = sec
    const d = new Date(now)
    const two = (n: number) => String(n).padStart(2, '0')
    stamp = `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
  }
  return stamp
}

export function logCommand(cmd: string) {
  const trimmed = cmd.trim()
  if (!trimmed)
    return
  serialLog.value.unshift(`${timeLabel()}  ${trimmed}`)
  if (serialLog.value.length > MAX_LOG)
    serialLog.value.length = MAX_LOG
}

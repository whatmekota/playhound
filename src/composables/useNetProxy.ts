import { useLocalStorage } from '@vueuse/core'
import { ref, watch } from 'vue'
import { KEYS } from '~/lib/persist'
import { STREAM_PROXY } from './useStreams'

/**
 * The proxy for everything playhound fetches from the internet: the EroScripts
 * browser, stream resolving and the video data, yt-dlp, and in the desktop app
 * the window's own requests (forum covers). Settings → Network sets it.
 *
 * It lives in the local proxy server (es-proxy.mjs), which is what does the
 * fetching, so the app tells it on start and on every change. Empty leaves the
 * server on the environment's HTTP(S)_PROXY, if there is one.
 */

export interface NetProxyInfo {
  /** Set here, or null. */
  configured: string | null
  /** HTTP(S)_PROXY of the environment the server runs in, or null. */
  env: string | null
  /** What is actually used. */
  effective: string | null
}

export const netProxy = useLocalStorage<string>(KEYS.netProxy.key, '')

/** What the server reports, or null while it cannot be reached. */
export const netProxyInfo = ref<NetProxyInfo | null>(null)
export const netProxyError = ref<string | null>(null)

async function push(value: string) {
  const res = await fetch(`${STREAM_PROXY}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ proxy: value }),
  })
  const body = await res.json().catch(() => ({}))
  netProxyInfo.value = { configured: body.configured ?? null, env: body.env ?? null, effective: body.effective ?? null }
  netProxyError.value = res.ok ? null : (body.error ?? `The local proxy answered ${res.status}`)
}

/** Ask the server what it uses, without changing it. */
async function read() {
  const res = await fetch(`${STREAM_PROXY}/config`)
  const body = await res.json().catch(() => ({}))
  if (!res.ok)
    throw new Error(body.error ?? `The local proxy answered ${res.status}`)
  netProxyInfo.value = { configured: body.configured ?? null, env: body.env ?? null, effective: body.effective ?? null }
  netProxyError.value = null
}

let started = false

/** Keep the server's proxy in step with the setting. Called once by the shell. */
export function startNetProxySync() {
  if (started)
    return
  started = true
  let timer: ReturnType<typeof setTimeout> | null = null
  const sync = (value: string, attempt = 0) => {
    if (timer)
      clearTimeout(timer)
    push(value).catch(() => {
      // The server may still be starting (from source), or absent (the
      // hosted page): keep trying for a while, then wait for a change.
      netProxyInfo.value = null
      if (attempt < 10)
        timer = setTimeout(() => sync(value, attempt + 1), 3000)
    })
  }
  // On start, an empty setting is not sent: empty means the environment's
  // proxy, which is what the server starts on anyway, and the server is
  // shared, so a second copy of the app (or a fresh profile) with nothing set
  // used to switch everyone's proxy off, the desktop's web pages included.
  // Clearing the field later is still sent.
  let first = true
  watch(netProxy, (v) => {
    const value = v.trim()
    if (first && !value) {
      first = false
      read().catch(() => {
        netProxyInfo.value = null
      })
      return
    }
    first = false
    sync(value)
  }, { immediate: true })
}

/** Ask again, e.g. when Settings opens. Sends the setting only when there is one (see startNetProxySync). */
export function refreshNetProxy() {
  const value = netProxy.value.trim()
  return (value ? push(value) : read()).catch(() => {
    netProxyInfo.value = null
  })
}

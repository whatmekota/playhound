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
  watch(netProxy, v => sync(v.trim()), { immediate: true })
}

/** Ask again, e.g. when Settings opens. */
export function refreshNetProxy() {
  return push(netProxy.value.trim()).catch(() => {
    netProxyInfo.value = null
  })
}

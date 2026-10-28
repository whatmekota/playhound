import type { ResolvedStream, StreamSource } from '~/lib/streamHosts'
import { ref } from 'vue'
import { usePlaybackStore } from '~/stores/playbackStore'

/** es-proxy.mjs: the desktop app runs it, and so do start.bat and `pnpm dev:proxy`. */
export const STREAM_PROXY = 'http://localhost:7071'

export class StreamError extends Error {
  constructor(message: string, readonly code: 'needs-ytdlp' | 'no-proxy' | null = null) {
    super(message)
  }
}

interface YtdlpState {
  installed: boolean
  installing: boolean
  version?: string | null
}

/** Shared yt-dlp state, so one install shows everywhere a link waits for it. */
export const ytdlp = ref<YtdlpState | null>(null)

async function call(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${STREAM_PROXY}${path}`, init)
  }
  catch {
    throw new StreamError('Streaming needs the playhound app (or start.bat) running on this computer', 'no-proxy')
  }
}

/** Turn a link from a post into playable streams, through the proxy. */
export async function resolveStream(url: string): Promise<ResolvedStream> {
  const res = await call(`/resolve?url=${encodeURIComponent(url)}`)
  const body = await res.json().catch(() => ({}))
  if (!res.ok)
    throw new StreamError(body.error ?? `The proxy answered ${res.status}`, body.code === 'needs-ytdlp' ? 'needs-ytdlp' : null)
  return body as ResolvedStream
}

export async function refreshYtdlp() {
  const res = await call('/ytdlp/status')
  ytdlp.value = await res.json()
  return ytdlp.value
}

/** Fetch the official yt-dlp release into playhound's own folder. */
export async function installYtdlp() {
  ytdlp.value = { installed: false, installing: true }
  try {
    const res = await call('/ytdlp/install', { method: 'POST' })
    const body = await res.json().catch(() => ({}))
    if (!res.ok)
      throw new StreamError(body.error ?? `The proxy answered ${res.status}`)
    ytdlp.value = body
  }
  catch (e) {
    ytdlp.value = { installed: false, installing: false }
    throw e
  }
}

/** Play one resolved source. */
export function playSource(title: string, source: StreamSource) {
  return usePlaybackStore().playStream(title, source.url, source.kind)
}

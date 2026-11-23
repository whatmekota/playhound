import type { XrServerState } from '~/lib/browserApi'
import type { DeskMessage, HeadsetMessage, XrDeskState, XrVideo } from '~/lib/xrProtocol'
import type { VideoEntry } from '~/stores/libraryStore'
import type { ExternalSession } from '~/stores/playbackStore'
import { watchDebounced } from '@vueuse/core'
import { computed, onBeforeUnmount, shallowRef, watch } from 'vue'
import { desktop } from '~/lib/browserApi'
import { isVrVideo } from '~/lib/tags'
import { useDeviceStore } from '~/stores/deviceStore'
import { useLibraryStore } from '~/stores/libraryStore'
import { usePlaybackStore } from '~/stores/playbackStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useSafetyStore } from '~/stores/safetyStore'
import { useScriptStore } from '~/stores/scriptStore'
import { useSessionControlStore } from '~/stores/sessionControlStore'

/**
 * The desktop end of the headset player (pages/xr.vue in the headset's
 * browser, served by desktop/xr.mjs): offers the library's videos, and when
 * the headset plays one, follows it as playback in another app, so the
 * device plays the video's scripts to the headset's clock with everything
 * the computer does for a video of its own (latency, tweaks, the knob,
 * edges, panic).
 *
 * The desktop app only: the server is its main process's. Nothing happens
 * in the browser or the Android app.
 */

/** The server's state, shared by the shell (which runs this) and the Headset panel. */
const server = shallowRef<XrServerState | null>(null)
const OWNER = 'headset'
const THUMBS_AT_ONCE = 40

export function useXrServer() {
  const api = desktop?.xr
  return {
    available: !!api,
    state: server,
    start: async (on: boolean) => {
      if (api)
        server.value = await api.start(on)
    },
    newCode: async () => {
      if (api)
        server.value = await api.newCode()
    },
    forget: async () => {
      if (api)
        server.value = await api.forget()
    },
  }
}

/** A library video as the headset lists it, or null for one it can't play (not a file on this computer). */
function videoFor(entry: VideoEntry, path: string, vrViewOf: (name: string, isVr: boolean) => XrVideo['view']): XrVideo | null {
  if (!path || entry.remote || entry.kind === 'audio')
    return null
  return {
    id: entry.name,
    title: entry.basename,
    duration: entry.duration,
    scripted: entry.hasScript,
    multi: entry.scriptType === 'multi',
    starred: entry.starred,
    view: vrViewOf(entry.name, isVrVideo(entry)),
  }
}

async function thumbData(url: string): Promise<string | null> {
  try {
    const blob = await (await fetch(url)).blob()
    return await new Promise((resolve) => {
      const r = new FileReader()
      r.onload = () => resolve(typeof r.result === 'string' ? r.result : null)
      r.onerror = () => resolve(null)
      r.readAsDataURL(blob)
    })
  }
  catch {
    return null
  }
}

export function useXrHost(actions: { edge: () => void, panic: () => void, nudgeIntensity: (d: number) => void }) {
  const api = desktop?.xr
  if (!api)
    return
  const library = useLibraryStore()
  const playback = usePlaybackStore()
  const player = usePlayerStore()
  const scripts = useScriptStore()
  const device = useDeviceStore()
  const safety = useSafetyStore()
  const control = useSessionControlStore()

  const send = (msg: DeskMessage) => api.send(msg)
  const headsets = computed(() => server.value?.headsets ?? 0)
  let session: ExternalSession | null = null

  const offStates = api.onState(s => (server.value = s))
  void api.state().then(s => (server.value = s))

  // ── The videos it may play ───────────────────────────────────────────────
  /** What the headset lists, by id, with where each file is. */
  let listed = new Map<string, { video: XrVideo, entry: VideoEntry }>()
  function offer() {
    const next = new Map<string, { video: XrVideo, entry: VideoEntry }>()
    const media: { id: string, path: string, name: string }[] = []
    for (const entry of library.videos) {
      const path = library.diskPathFor(entry)
      const video = videoFor(entry, path, player.vrViewOf)
      if (!video || next.has(video.id))
        continue
      next.set(video.id, { video, entry })
      media.push({ id: video.id, path, name: entry.name })
    }
    listed = next
    void api!.setMedia(media)
    if (headsets.value)
      send({ type: 'library', videos: [...next.values()].map(v => v.video) })
  }
  // The folders' places on disk arrive a moment after the library: offer again then.
  watchDebounced(() => [server.value?.on, library.videos.length, library.videos, library.rootPaths], () => {
    if (server.value?.on)
      offer()
  }, { debounce: 400, deep: false })

  // ── Following the headset ────────────────────────────────────────────────
  async function play(id: string) {
    const item = listed.get(id)
    if (!item) {
      send({ type: 'refused', id, reason: 'That video is not in the library here any more' })
      return
    }
    const s = await playback.playExternal({
      owner: OWNER,
      label: 'the headset',
      entry: item.entry,
      duration: item.entry.duration ?? undefined,
      onCommand: command => send({ type: 'command', command }),
    })
    if (!s) {
      send({ type: 'refused', id, reason: 'playhound has unsaved script edits open' })
      return
    }
    session = s
    s.onEnd((reason) => {
      if (session === s)
        session = null
      send({ type: 'ended', reason })
    })
    send({ type: 'playing', id, scripts: scripts.activeScripts.length })
    pushState()
  }

  async function sendThumbs(ids: string[]) {
    for (const id of ids.slice(0, THUMBS_AT_ONCE)) {
      const url = listed.get(id)?.entry.thumbnailUrl
      const data = url ? await thumbData(url) : null
      if (data)
        send({ type: 'thumb', id, data })
    }
  }

  const offMessages = api.onMessage((raw: HeadsetMessage) => {
    switch (raw?.type) {
      case 'hello':
        if (server.value?.on)
          offer()
        pushState()
        break
      case 'play':
        if (typeof raw.id === 'string')
          void play(raw.id)
        break
      case 'clock':
        if (session && !session.ended && Number.isFinite(raw.time))
          session.update({ time: raw.time, playing: !!raw.playing, rate: raw.rate, duration: raw.duration })
        break
      case 'stop':
        if (session && !session.ended)
          playback.endExternal('stopped')
        break
      case 'thumbs':
        if (Array.isArray(raw.ids))
          void sendThumbs(raw.ids.filter((x): x is string => typeof x === 'string'))
        break
      case 'view': {
        // Remembered with the desktop player's own choice, so the video opens
        // the same way next time, in the headset and on the screen.
        const item = typeof raw.id === 'string' ? listed.get(raw.id) : null
        const v = raw.view
        if (item && v && typeof v === 'object') {
          player.setVrChoice(item.entry.name, { on: !!v.on, layout: v.layout, format: v.format, eye: v.eye })
          item.video.view = player.vrViewOf(item.entry.name, !!v.on)
        }
        break
      }
      case 'action':
        if (raw.action === 'knobUp')
          actions.nudgeIntensity(0.1)
        else if (raw.action === 'knobDown')
          actions.nudgeIntensity(-0.1)
        else if (raw.action === 'edge')
          actions.edge()
        else if (raw.action === 'panic')
          actions.panic()
        break
    }
  })

  // The headset gone: the device stops with it.
  watch(headsets, (n) => {
    if (!n && session && !session.ended)
      playback.endExternal('stopped')
  })

  // ── The panel in VR ──────────────────────────────────────────────────────
  const deskState = computed<XrDeskState>(() => ({
    knob: control.intensityScale,
    edge: control.settings.enabled ? control.phase : null,
    panicked: safety.panicked,
    scripts: playback.external?.owner === OWNER ? scripts.activeScripts.length : 0,
    device: device.connected,
  }))
  function pushState() {
    if (headsets.value)
      send({ type: 'state', state: deskState.value })
  }
  watch(deskState, pushState)

  onBeforeUnmount(() => {
    offStates()
    offMessages()
  })
}

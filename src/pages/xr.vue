<script setup lang="ts">
import type { DeskMessage, HeadsetMessage, XrDeskState, XrVideo, XrView } from '~/lib/xrProtocol'
import type { XrScene } from '~/lib/xrScene'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { VR_FORMATS, VR_LAYOUTS } from '~/lib/vrFormat'
import { mediaUrl } from '~/lib/xrProtocol'
import { startXrScene, supportsVr } from '~/lib/xrScene'

defineOptions({ name: 'XrPage' })

/**
 * The headset end of the headset player: this page, in a VR headset's
 * browser, served by the desktop app over HTTPS (desktop/xr.mjs). Pick a
 * video, enter VR; the desktop plays its scripts on the device to this
 * page's clock (composables/useXrHost.ts). Paired once with a 6-digit code.
 *
 * Used with a controller's pointer: big targets, nothing that needs
 * hovering, and no text smaller than a headset makes readable.
 */

type Screen = 'checking' | 'pair' | 'library' | 'video'
const screen = ref<Screen>('checking')
/** The video picked, and whether the computer follows it (plays its scripts to this page's clock). */
const current = shallowRef<XrVideo | null>(null)
const following = ref(false)

// ── Pairing ──────────────────────────────────────────────────────────────────
const code = ref('')
const pairing = ref(false)
const pairError = ref('')

async function hello() {
  try {
    const r = await fetch('/xr/hello', { cache: 'no-store' })
    const { paired } = await r.json()
    if (paired) {
      screen.value = 'library'
      connect()
    }
    else {
      screen.value = 'pair'
    }
  }
  catch {
    screen.value = 'pair'
    pairError.value = 'Could not reach playhound on the computer. Is the Headset panel switched on?'
  }
}

function typeDigit(d: string) {
  if (code.value.length < 6)
    code.value += d
  pairError.value = ''
  if (code.value.length === 6)
    void pair()
}

async function pair() {
  pairing.value = true
  try {
    const r = await fetch('/xr/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code.value }) })
    if (r.ok) {
      screen.value = 'library'
      connect()
    }
    else {
      pairError.value = 'That isn\'t the code. Check it in playhound\'s Headset panel; after a few wrong tries it changes.'
      code.value = ''
    }
  }
  catch {
    pairError.value = 'Could not reach playhound on the computer.'
  }
  finally {
    pairing.value = false
  }
}

function onKey(e: KeyboardEvent) {
  if (screen.value !== 'pair' || pairing.value)
    return
  if (/^\d$/.test(e.key))
    typeDigit(e.key)
  else if (e.key === 'Backspace')
    code.value = code.value.slice(0, -1)
}

// ── The line to the computer ─────────────────────────────────────────────────
const online = ref(false)
let ws: WebSocket | null = null
let retry: ReturnType<typeof setTimeout> | null = null
let backoff = 500
let leaving = false

function send(msg: HeadsetMessage) {
  if (ws?.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify(msg))
}

function connect() {
  if (ws || leaving)
    return
  const socket = new WebSocket(`wss://${location.host}/xr/ws`)
  ws = socket
  socket.onopen = () => {
    online.value = true
    backoff = 500
    send({ type: 'hello' })
    // Back after a drop with a video picked: the computer follows it again.
    if (current.value)
      send({ type: 'play', id: current.value.id })
  }
  socket.onmessage = (e) => {
    try {
      onMessage(JSON.parse(String(e.data)))
    }
    catch {}
  }
  socket.onclose = (e) => {
    online.value = false
    ws = null
    following.value = false
    // Forgotten on the computer: pair again.
    if (e.code === 4001) {
      screen.value = 'pair'
      return
    }
    if (!leaving)
      retry = setTimeout(connect, backoff = Math.min(backoff * 2, 8000))
  }
}

// ── The library ──────────────────────────────────────────────────────────────
const videos = shallowRef<XrVideo[]>([])
const thumbs = reactive<Record<string, string>>({})
const query = ref('')
const filter = ref<'all' | 'vr' | 'scripted'>('all')
const shown = computed(() => {
  const q = query.value.trim().toLowerCase()
  return videos.value
    .filter(v => (filter.value === 'vr' ? v.view.on : filter.value === 'scripted' ? v.scripted : true))
    .filter(v => !q || v.title.toLowerCase().includes(q))
})

// Thumbnails as the cards come into view, a few at a time.
const asked = new Set<string>()
let wanted: string[] = []
let askTimer: ReturnType<typeof setTimeout> | null = null
const seen = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const id = (e.target as HTMLElement).dataset.id
    if (e.isIntersecting && id && !asked.has(id)) {
      asked.add(id)
      wanted.push(id)
    }
  }
  if (wanted.length && !askTimer) {
    askTimer = setTimeout(() => {
      send({ type: 'thumbs', ids: wanted })
      wanted = []
      askTimer = null
    }, 200)
  }
}, { rootMargin: '300px' })
function watchCard(el: unknown) {
  if (el instanceof HTMLElement)
    seen.observe(el)
}

function fmt(s: number | null | undefined) {
  if (!s || !Number.isFinite(s))
    return ''
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(Math.floor(s % 60)).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

// ── A video ──────────────────────────────────────────────────────────────────
const view = reactive<XrView>({ on: false, layout: 'sbs', format: 'eq180', eye: 'left' })
const refused = ref('')
const desk = shallowRef<XrDeskState | null>(null)
const videoEl = ref<HTMLVideoElement | null>(null)
const vrOk = ref(false)
const inVr = ref(false)
let scene: XrScene | null = null

function open(v: XrVideo) {
  current.value = v
  Object.assign(view, v.view)
  following.value = false
  refused.value = ''
  screen.value = 'video'
  send({ type: 'play', id: v.id })
}

async function back() {
  await scene?.end()
  videoEl.value?.pause()
  send({ type: 'stop' })
  current.value = null
  following.value = false
  screen.value = 'library'
}

async function enterVr() {
  const v = videoEl.value
  if (!v || !current.value)
    return
  try {
    await v.play().catch(() => {})
    scene = await startXrScene({
      video: v,
      view: { ...view },
      title: current.value.title,
      onAction: action => send({ type: 'action', action }),
      onEnd: () => {
        inVr.value = false
        scene = null
        v.pause()
      },
    })
    scene.setDesk(desk.value)
    inVr.value = true
  }
  catch (e: any) {
    refused.value = `Could not start VR: ${e?.message ?? e}`
  }
}

// Where the video is, for the device: a few times a second and on every change.
let clockTimer: ReturnType<typeof setInterval> | null = null
let buffering = false
function report() {
  const v = videoEl.value
  if (!v || !current.value)
    return
  send({
    type: 'clock',
    time: v.currentTime,
    playing: !v.paused && !v.ended && !buffering,
    rate: v.playbackRate,
    duration: Number.isFinite(v.duration) ? v.duration : undefined,
  })
}
function onWaiting() {
  buffering = true
  report()
}
function onPlaying() {
  buffering = false
  report()
}
watch(current, (c) => {
  if (clockTimer)
    clearInterval(clockTimer)
  clockTimer = c ? setInterval(report, 250) : null
})

function onMessage(msg: DeskMessage) {
  switch (msg?.type) {
    case 'library':
      videos.value = Array.isArray(msg.videos) ? msg.videos : []
      break
    case 'thumb':
      if (typeof msg.data === 'string' && msg.data.startsWith('data:image/'))
        thumbs[msg.id] = msg.data
      break
    case 'playing':
      if (msg.id === current.value?.id) {
        following.value = true
        refused.value = ''
      }
      break
    case 'refused':
      if (msg.id === current.value?.id)
        refused.value = msg.reason
      break
    case 'ended':
      following.value = false
      break
    case 'command': {
      const v = videoEl.value
      const c = msg.command
      if (!v)
        break
      if (c.type === 'play')
        void v.play().catch(() => {})
      else if (c.type === 'pause')
        v.pause()
      else if (c.type === 'seek' && Number.isFinite(c.time))
        v.currentTime = c.time
      else if (c.type === 'rate' && Number.isFinite(c.rate))
        v.playbackRate = c.rate
      break
    }
    case 'state':
      desk.value = msg.state
      scene?.setDesk(msg.state)
      // Panic on the computer: the picture stops too.
      if (msg.state?.panicked)
        videoEl.value?.pause()
      break
  }
}

onMounted(async () => {
  document.title = 'playhound · headset'
  window.addEventListener('keydown', onKey)
  vrOk.value = await supportsVr()
  await hello()
  await nextTick()
})

onBeforeUnmount(() => {
  leaving = true
  window.removeEventListener('keydown', onKey)
  if (retry)
    clearTimeout(retry)
  if (clockTimer)
    clearInterval(clockTimer)
  seen.disconnect()
  void scene?.end()
  ws?.close()
})
</script>

<template>
  <div class="xr text-fg bg-surface-950 flex flex-col min-h-[100dvh] select-none">
    <!-- Lost the computer -->
    <div v-if="screen !== 'pair' && screen !== 'checking' && !online" class="text-[18px] text-warn px-8 py-3 bg-warn/10 flex gap-3 items-center">
      <span class="i-carbon-warning-alt text-[22px]" />
      Can't reach playhound on the computer. Trying again…
    </div>

    <!-- ─── Pairing ─────────────────────────────────────────────────────── -->
    <main v-if="screen === 'checking'" class="center flex-1">
      <span class="text-[22px] text-fg-muted">Connecting…</span>
    </main>

    <main v-else-if="screen === 'pair'" class="p-10 flex flex-1 flex-col gap-6 items-center justify-center">
      <h1 class="text-[34px] font-semibold">
        Pair with playhound
      </h1>
      <p class="text-[20px] text-fg-muted text-center max-w-[640px]">
        Type the code from the Headset panel in playhound on your computer.
      </p>
      <div class="text-[52px] tracking-[0.2em] font-mono font-semibold flex gap-3 h-20 items-center" aria-live="polite">
        <span v-for="i in 6" :key="i" class="text-center border-b-4 w-12" :class="i <= code.length ? 'border-accent' : 'border-fg/20'">{{ code[i - 1] ?? '' }}</span>
      </div>
      <div class="gap-3 grid grid-cols-3">
        <button v-for="d in ['1', '2', '3', '4', '5', '6', '7', '8', '9']" :key="d" type="button" class="key" :disabled="pairing" @click="typeDigit(d)">
          {{ d }}
        </button>
        <button type="button" class="key text-[22px]" :disabled="pairing || !code" @click="code = code.slice(0, -1)">
          ⌫
        </button>
        <button type="button" class="key" :disabled="pairing" @click="typeDigit('0')">
          0
        </button>
        <span />
      </div>
      <p v-if="pairError" class="text-[18px] text-danger text-center max-w-[640px]">
        {{ pairError }}
      </p>
    </main>

    <!-- ─── Library ─────────────────────────────────────────────────────── -->
    <main v-else-if="screen === 'library'" class="px-8 py-6 flex flex-1 flex-col gap-5">
      <header class="flex flex-wrap gap-4 items-center">
        <h1 class="text-[30px] font-semibold mr-auto">
          playhound
        </h1>
        <input v-model="query" type="search" placeholder="Search" class="text-[20px] px-4 border border-edge-strong rounded-xl bg-surface-900 h-14 w-80">
        <div class="flex gap-2">
          <button
            v-for="f in [{ v: 'all', l: 'All' }, { v: 'vr', l: 'VR' }, { v: 'scripted', l: 'Scripted' }] as const"
            :key="f.v"
            type="button"
            class="chip"
            :class="filter === f.v ? 'is-on' : ''"
            @click="filter = f.v"
          >
            {{ f.l }}
          </button>
        </div>
      </header>
      <p v-if="!videos.length" class="text-[20px] text-fg-muted">
        {{ online ? 'No videos here yet: add a folder to the library in playhound on the computer.' : 'Waiting for the computer…' }}
      </p>
      <div class="gap-5 grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))]">
        <button
          v-for="v in shown"
          :key="v.id"
          :ref="watchCard"
          :data-id="v.id"
          type="button"
          class="card-btn"
          @click="open(v)"
        >
          <div class="rounded-xl bg-surface-800 aspect-video relative overflow-hidden">
            <img v-if="thumbs[v.id]" :src="thumbs[v.id]" alt="" class="h-full w-full object-cover">
            <span v-if="v.duration" class="text-[15px] font-mono px-2 py-0.5 rounded-md bg-black/70 bottom-2 right-2 absolute">{{ fmt(v.duration) }}</span>
          </div>
          <span class="text-[19px] font-medium mt-2 text-left line-clamp-2">{{ v.title }}</span>
          <span class="text-[15px] text-fg-muted flex gap-2">
            <span v-if="v.view.on" class="text-accent-300">VR</span>
            <span v-if="v.scripted">{{ v.multi ? 'Multi-axis' : 'Scripted' }}</span>
            <span v-if="v.starred">★</span>
          </span>
        </button>
      </div>
    </main>

    <!-- ─── A video ─────────────────────────────────────────────────────── -->
    <main v-else-if="screen === 'video' && current" class="px-8 py-6 flex flex-1 flex-col gap-5">
      <header class="flex gap-4 items-center">
        <button type="button" class="chip" @click="back">
          ← Library
        </button>
        <h1 class="text-[26px] font-semibold truncate">
          {{ current.title }}
        </h1>
      </header>

      <div class="flex flex-wrap gap-8 items-start">
        <video
          ref="videoEl"
          :src="mediaUrl(current.id)"
          crossorigin="use-credentials"
          preload="metadata"
          playsinline
          class="rounded-xl bg-black max-w-[720px] w-full aspect-video"
          @play="report"
          @pause="report"
          @seeked="report"
          @ratechange="report"
          @ended="report"
          @waiting="onWaiting"
          @playing="onPlaying"
        />

        <div class="flex flex-col gap-5 min-w-[320px]">
          <button type="button" class="primary" :disabled="!vrOk || inVr" @click="enterVr">
            {{ inVr ? 'In VR' : 'Enter VR' }}
          </button>
          <p v-if="!vrOk" class="text-[17px] text-fg-muted max-w-[420px]">
            This browser has no VR: open this page in a VR headset's browser.
          </p>

          <label class="text-[19px] flex gap-3 items-center">
            <input v-model="view.on" type="checkbox" class="h-7 w-7">
            A VR video (else a flat screen in front)
          </label>
          <template v-if="view.on">
            <div class="flex flex-wrap gap-2">
              <button v-for="l in VR_LAYOUTS" :key="l.value" type="button" class="chip" :class="view.layout === l.value ? 'is-on' : ''" @click="view.layout = l.value">
                {{ l.label }}
              </button>
            </div>
            <select v-model="view.format" class="text-[19px] px-3 border border-edge-strong rounded-xl bg-surface-900 h-14">
              <option v-for="f in VR_FORMATS" :key="f.id" :value="f.id">
                {{ f.label }}
              </option>
            </select>
          </template>

          <div class="text-[17px] text-fg-muted flex flex-col gap-1">
            <span v-if="refused" class="text-warn">{{ refused }}</span>
            <span v-else-if="following">The device follows this video{{ desk ? ` · ${desk.scripts ? `${desk.scripts} script${desk.scripts === 1 ? '' : 's'}` : 'no script'}` : '' }}.</span>
            <span v-else>Asking the computer…</span>
            <span v-if="desk?.panicked" class="text-danger">Panic is on in playhound: resume it on the computer.</span>
          </div>
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.key {
  width: 104px;
  height: 84px;
  font-size: 34px;
  font-weight: 600;
  border-radius: 18px;
  background: var(--color-surface-800, #1c1c22);
}
.key:active:not(:disabled) {
  background: var(--color-accent, #d946ef);
}
.chip {
  font-size: 19px;
  padding: 0 20px;
  height: 52px;
  border-radius: 999px;
  border: 1px solid rgb(255 255 255 / 0.15);
}
.chip.is-on {
  border-color: rgb(217 70 239 / 0.7);
  background: rgb(217 70 239 / 0.15);
}
.card-btn {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  border-radius: 16px;
}
.card-btn:hover {
  background: rgb(255 255 255 / 0.05);
}
.primary {
  font-size: 24px;
  font-weight: 600;
  height: 72px;
  border-radius: 18px;
  background: #d946ef;
  color: white;
}
.primary:disabled {
  opacity: 0.4;
}
</style>

<script setup lang="ts">
import type { DeskMessage, HeadsetMessage, XrDeskState, XrVideo, XrView } from '~/lib/xrProtocol'
import type { XrScene } from '~/lib/xrScene'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { VR_FORMATS, VR_LAYOUTS, vrFormat } from '~/lib/vrFormat'
import { deskStatus } from '~/lib/xrPanel'
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
/**
 * VR views set here, by video. The computer saves them too, but a library it
 * sent before it heard (playing a video makes it send one) would still have
 * the old view: these win over it.
 */
const chosen = new Map<string, XrView>()
function withChosen(list: XrVideo[]): XrVideo[] {
  return list.map(v => (chosen.has(v.id) ? { ...v, view: { ...chosen.get(v.id)! } } : v))
}
const thumbs = reactive<Record<string, string>>({})
const query = ref('')
const FILTERS = [{ v: 'all', l: 'All' }, { v: 'vr', l: 'VR' }, { v: 'scripted', l: 'Scripted' }] as const
const filter = ref<(typeof FILTERS)[number]['v']>('all')
const counts = computed(() => ({
  all: videos.value.length,
  vr: videos.value.filter(v => v.view.on).length,
  scripted: videos.value.filter(v => v.scripted).length,
}))
const formatShort = (id: string) => vrFormat(id).short
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
const FORMAT_GROUPS = [
  { label: 'Equirect', formats: VR_FORMATS.filter(f => f.projection === 'equirect') },
  { label: 'Fisheye', formats: VR_FORMATS.filter(f => f.projection === 'fisheye') },
]
const desk = shallowRef<XrDeskState | null>(null)
const videoEl = ref<HTMLVideoElement | null>(null)
const vrOk = ref(false)
const inVr = ref(false)
let scene: XrScene | null = null
/** The line under Enter VR: whether the computer follows, and what it does. */
const status = computed(() => {
  if (refused.value)
    return { text: refused.value, tone: 'warn' as const }
  if (!following.value)
    return { text: 'Asking the computer…', tone: 'off' as const }
  return deskStatus(desk.value)
})

// What's set here is remembered on the computer, for the next time.
let viewTimer: ReturnType<typeof setTimeout> | null = null
watch(view, () => {
  const c = current.value
  if (!c)
    return
  if (viewTimer)
    clearTimeout(viewTimer)
  viewTimer = setTimeout(() => {
    // Only a change made here: opening a video copies its view in too, and
    // the computer's own guess shouldn't be saved as a choice.
    if (current.value?.id !== c.id || JSON.stringify({ ...view }) === JSON.stringify(chosen.get(c.id) ?? c.view))
      return
    chosen.set(c.id, { ...view })
    videos.value = withChosen(videos.value)
    send({ type: 'view', id: c.id, view: { ...view } })
  }, 300)
})

function open(v: XrVideo) {
  current.value = v
  Object.assign(view, chosen.get(v.id) ?? v.view)
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
      videos.value = withChosen(Array.isArray(msg.videos) ? msg.videos : [])
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
  <div class="xr">
    <!-- Lost the computer -->
    <div v-if="screen !== 'pair' && screen !== 'checking' && !online" class="lost" role="status">
      <span class="i-carbon-warning-alt text-[24px]" />
      Can't reach playhound on the computer. Trying again…
    </div>

    <!-- ─── Pairing ─────────────────────────────────────────────────────── -->
    <main v-if="screen === 'checking'" class="center-screen">
      <span class="spinner" aria-hidden="true" />
      <span class="muted text-[22px]">Connecting…</span>
    </main>

    <main v-else-if="screen === 'pair'" class="center-screen">
      <div class="pair-card">
        <span class="brand">playhound</span>
        <h1 class="text-[34px] font-semibold m-0">
          Pair this headset
        </h1>
        <p class="muted text-[20px] m-0 text-center max-w-[520px]">
          Type the code shown in the Headset panel of playhound on your computer.
        </p>
        <div class="digits" aria-live="polite" :aria-label="`${code.length} of 6 digits`">
          <span v-for="i in 6" :key="i" class="digit" :class="{ 'is-filled': i <= code.length, 'is-next': i === code.length + 1 }">{{ code[i - 1] ?? '' }}</span>
        </div>
        <div class="keypad">
          <button v-for="d in ['1', '2', '3', '4', '5', '6', '7', '8', '9']" :key="d" type="button" class="key" :disabled="pairing" @click="typeDigit(d)">
            {{ d }}
          </button>
          <span />
          <button type="button" class="key" :disabled="pairing" @click="typeDigit('0')">
            0
          </button>
          <button type="button" class="key key-soft" aria-label="Delete a digit" :disabled="pairing || !code" @click="code = code.slice(0, -1)">
            <span class="i-carbon-delete text-[30px]" />
          </button>
        </div>
        <p v-if="pairError" class="error">
          {{ pairError }}
        </p>
      </div>
    </main>

    <!-- ─── Library ─────────────────────────────────────────────────────── -->
    <main v-else-if="screen === 'library'" class="page">
      <header class="bar">
        <span class="brand">playhound</span>
        <span class="conn" :class="{ 'is-on': online }">
          <span class="dot" />{{ online ? 'Connected to the computer' : 'Offline' }}
        </span>
      </header>
      <div class="tools">
        <label class="search">
          <span class="i-carbon-search muted text-[22px]" />
          <input v-model="query" type="search" placeholder="Search videos" aria-label="Search videos">
        </label>
        <div class="seg" role="radiogroup" aria-label="Show">
          <button
            v-for="f in FILTERS"
            :key="f.v"
            type="button"
            role="radio"
            class="seg-btn"
            :class="{ 'is-on': filter === f.v }"
            :aria-checked="filter === f.v"
            @click="filter = f.v"
          >
            {{ f.l }}<span class="count">{{ counts[f.v] }}</span>
          </button>
        </div>
      </div>

      <div v-if="!videos.length" class="empty">
        <span class="i-carbon-video muted text-[56px]" />
        <p>{{ online ? 'No videos yet. Add a folder to the library in playhound on the computer.' : 'Waiting for the computer…' }}</p>
      </div>
      <div v-else-if="!shown.length" class="empty">
        <span class="i-carbon-search muted text-[48px]" />
        <p>Nothing here matches.</p>
      </div>
      <div v-else class="cards">
        <button
          v-for="v in shown"
          :key="v.id"
          :ref="watchCard"
          :data-id="v.id"
          type="button"
          class="card-btn"
          @click="open(v)"
        >
          <div class="thumb">
            <img v-if="thumbs[v.id]" :src="thumbs[v.id]" alt="">
            <span v-else class="i-carbon-video thumb-empty" />
            <span v-if="v.view.on" class="badge badge-vr">VR {{ formatShort(v.view.format) }}</span>
            <span v-if="v.duration" class="badge badge-time">{{ fmt(v.duration) }}</span>
            <span class="thumb-play"><span class="i-carbon-play-filled-alt" /></span>
          </div>
          <span class="card-title">{{ v.title }}</span>
          <span class="card-meta">
            <span v-if="v.scripted" class="tag"><span class="i-carbon-activity" />{{ v.multi ? 'Multi-axis' : 'Scripted' }}</span>
            <span v-else class="muted">No script</span>
            <span v-if="v.starred" class="i-carbon-star-filled star" aria-label="Starred" />
          </span>
        </button>
      </div>
    </main>

    <!-- ─── A video ─────────────────────────────────────────────────────── -->
    <main v-else-if="screen === 'video' && current" class="page">
      <header class="bar">
        <button type="button" class="ghost" @click="back">
          <span class="i-carbon-arrow-left text-[24px]" />Library
        </button>
        <h1 class="video-title">
          {{ current.title }}
        </h1>
      </header>

      <div class="video-layout">
        <div class="stage">
          <video
            ref="videoEl"
            :src="mediaUrl(current.id)"
            crossorigin="use-credentials"
            preload="metadata"
            playsinline
            controls
            @play="report"
            @pause="report"
            @seeked="report"
            @ratechange="report"
            @ended="report"
            @waiting="onWaiting"
            @playing="onPlaying"
          />
        </div>

        <aside class="side">
          <button type="button" class="primary" :disabled="!vrOk || inVr" @click="enterVr">
            <svg viewBox="0 0 32 20" class="goggles" aria-hidden="true"><path d="M4 1h24a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-6.5l-2.6-3.2a3 3 0 0 0-4.8 0L10.5 16H4a3 3 0 0 1-3-3V4a3 3 0 0 1 3-3Z" fill="currentColor" /></svg>
            {{ inVr ? 'In VR' : 'Enter VR' }}
          </button>
          <p v-if="!vrOk" class="muted text-[17px] m-0">
            This browser has no VR: open this page in a VR headset's browser.
          </p>

          <div class="status" :class="`tone-${status.tone}`" role="status">
            <span class="dot" />
            <span class="flex-1">{{ status.text }}</span>
            <span v-if="following && desk" class="status-knob">{{ Math.round(desk.knob * 100) }}%</span>
          </div>

          <section class="box">
            <h2>Shown as</h2>
            <div class="seg seg-wide" role="radiogroup" aria-label="Shown as">
              <button type="button" role="radio" class="seg-btn" :class="{ 'is-on': !view.on }" :aria-checked="!view.on" @click="view.on = false">
                <span class="i-carbon-screen" />Flat screen
              </button>
              <button type="button" role="radio" class="seg-btn" :class="{ 'is-on': view.on }" :aria-checked="view.on" @click="view.on = true">
                <span class="i-carbon-rotate-360" />VR video
              </button>
            </div>
            <template v-if="view.on">
              <h3>Layout</h3>
              <div class="seg seg-wide" role="radiogroup" aria-label="Layout">
                <button v-for="l in VR_LAYOUTS" :key="l.value" type="button" role="radio" class="seg-btn" :class="{ 'is-on': view.layout === l.value }" :aria-checked="view.layout === l.value" @click="view.layout = l.value">
                  {{ l.label }}
                </button>
              </div>
              <h3>Projection</h3>
              <div class="formats" role="radiogroup" aria-label="Projection">
                <template v-for="g in FORMAT_GROUPS" :key="g.label">
                  <span class="formats-label">{{ g.label }}</span>
                  <button v-for="f in g.formats" :key="f.id" type="button" role="radio" class="fmt" :class="{ 'is-on': view.format === f.id }" :aria-checked="view.format === f.id" :title="f.label" @click="view.format = f.id">
                    {{ f.fov }}°
                  </button>
                </template>
              </div>
            </template>
            <p class="muted text-[16px] m-0">
              Remembered for this video, here and on the computer.
            </p>
          </section>
        </aside>
      </div>
    </main>
  </div>
</template>

<style scoped>
.xr {
  --r: 18px;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  background: radial-gradient(1200px 600px at 50% -200px, var(--accent-soft), transparent 70%), var(--bg-base);
  color: var(--text);
  user-select: none;
  font-size: 18px;
}
.muted {
  color: var(--text-muted);
}
.brand {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.02em;
  background: linear-gradient(90deg, var(--text), var(--accent-light));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.lost {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 32px;
  font-size: 19px;
  color: var(--warn);
  background: color-mix(in srgb, var(--warn) 12%, transparent);
}
.center-screen {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
  padding: 40px;
}
.spinner {
  width: 44px;
  height: 44px;
  border-radius: 999px;
  border: 4px solid var(--border-strong);
  border-top-color: var(--accent);
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* ── Pairing ── */
.pair-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
  padding: 40px 48px;
  border-radius: 28px;
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg-850) 85%, transparent);
}
.digits {
  display: flex;
  gap: 12px;
  margin: 6px 0;
}
.digit {
  width: 64px;
  height: 80px;
  display: grid;
  place-items: center;
  font:
    600 44px ui-monospace,
    monospace;
  border-radius: 16px;
  background: var(--bg-900);
  border: 2px solid var(--border-strong);
  transition: border-color 0.15s;
}
.digit.is-filled {
  border-color: color-mix(in srgb, var(--accent) 60%, transparent);
}
.digit.is-next {
  border-color: var(--accent);
  box-shadow: 0 0 0 4px var(--accent-soft);
}
.keypad {
  display: grid;
  grid-template-columns: repeat(3, 112px);
  gap: 12px;
}
.key {
  height: 84px;
  display: grid;
  place-items: center;
  font-size: 34px;
  font-weight: 600;
  border-radius: var(--r);
  background: var(--bg-800);
  transition:
    background-color 0.12s,
    transform 0.12s;
}
.key:hover:not(:disabled) {
  background: var(--bg-700);
}
.key:active:not(:disabled) {
  background: var(--accent);
  color: var(--accent-contrast);
  transform: scale(0.96);
}
.key:disabled {
  opacity: 0.4;
}
.key-soft {
  background: transparent;
  border: 1px solid var(--border-strong);
}
.error {
  margin: 0;
  max-width: 520px;
  text-align: center;
  font-size: 18px;
  color: var(--danger);
}

/* ── Pages ── */
.page {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 22px;
  padding: 26px 36px 40px;
  max-width: 1600px;
  width: 100%;
  margin: 0 auto;
  box-sizing: border-box;
}
.bar {
  display: flex;
  align-items: center;
  gap: 18px;
  min-height: 56px;
}
.conn {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 17px;
  color: var(--text-muted);
}
.dot {
  width: 11px;
  height: 11px;
  border-radius: 999px;
  background: var(--text-faint);
  flex-shrink: 0;
}
.conn.is-on .dot {
  background: var(--ok);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--ok) 22%, transparent);
}
.tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
}
.search {
  flex: 1 1 320px;
  max-width: 520px;
  display: flex;
  align-items: center;
  gap: 12px;
  height: 58px;
  padding: 0 18px;
  border-radius: var(--r);
  background: var(--bg-900);
  border: 1px solid var(--border-strong);
}
.search:focus-within {
  border-color: var(--accent);
}
.search input {
  flex: 1;
  min-width: 0;
  height: 100%;
  font-size: 20px;
  color: inherit;
  background: transparent;
  outline: none;
}
.seg {
  display: inline-flex;
  padding: 5px;
  gap: 4px;
  border-radius: calc(var(--r) + 4px);
  background: var(--bg-900);
  border: 1px solid var(--border);
}
.seg-wide {
  display: flex;
}
.seg-wide .seg-btn {
  flex: 1;
  min-width: 0;
  padding: 0 10px;
}
.seg-btn {
  height: 50px;
  padding: 0 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  font-size: 18px;
  font-weight: 500;
  white-space: nowrap;
  color: var(--text-muted);
  border-radius: var(--r);
  transition:
    background-color 0.15s,
    color 0.15s;
}
.seg-btn:hover {
  color: var(--text);
  background: var(--bg-800);
}
.seg-btn.is-on {
  color: var(--text);
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--accent) 70%, transparent);
}
.count {
  font-size: 15px;
  font-variant-numeric: tabular-nums;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--bg-800);
  color: var(--text-muted);
}
.empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 60px 20px;
  text-align: center;
  font-size: 20px;
  color: var(--text-muted);
}

/* ── Cards ── */
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 22px;
}
.card-btn {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 10px 14px;
  text-align: left;
  border-radius: 22px;
  transition: background-color 0.15s;
}
.card-btn:hover {
  background: var(--bg-850);
}
.thumb {
  position: relative;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border-radius: 16px;
  background: var(--bg-800);
  display: grid;
  place-items: center;
}
.thumb img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 0.3s;
}
.card-btn:hover .thumb img {
  transform: scale(1.04);
}
.thumb-empty {
  font-size: 40px;
  color: var(--text-faint);
}
.thumb-play {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 44px;
  color: #fff;
  background: rgb(0 0 0 / 0.35);
  opacity: 0;
  transition: opacity 0.15s;
}
.card-btn:hover .thumb-play {
  opacity: 1;
}
.badge {
  position: absolute;
  padding: 3px 10px;
  border-radius: 9px;
  font-size: 15px;
  font-weight: 600;
  color: #fff;
  background: rgb(0 0 0 / 0.7);
}
.badge-vr {
  top: 10px;
  left: 10px;
  background: color-mix(in srgb, var(--accent) 85%, black);
}
.badge-time {
  right: 10px;
  bottom: 10px;
  font-family: ui-monospace, monospace;
}
.card-title {
  padding: 0 4px;
  font-size: 19px;
  font-weight: 600;
  line-height: 1.3;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.card-meta {
  padding: 0 4px;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 15px;
}
.tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--accent-light);
}
.star {
  margin-left: auto;
  color: var(--warn);
}

/* ── A video ── */
.ghost {
  height: 54px;
  padding: 0 18px 0 12px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 19px;
  font-weight: 500;
  border-radius: var(--r);
  border: 1px solid var(--border-strong);
  flex-shrink: 0;
}
.ghost:hover {
  background: var(--bg-800);
}
.video-title {
  margin: 0;
  font-size: 26px;
  font-weight: 650;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.video-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.7fr) minmax(340px, 1fr);
  gap: 28px;
  align-items: start;
}
@media (max-width: 980px) {
  .video-layout {
    grid-template-columns: 1fr;
  }
}
.stage video {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: 20px;
  background: #000;
  box-shadow: 0 20px 60px rgb(0 0 0 / 0.45);
}
.side {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.primary {
  height: 78px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  font-size: 25px;
  font-weight: 650;
  border-radius: 20px;
  color: var(--accent-contrast);
  background: linear-gradient(135deg, var(--accent), var(--accent-strong));
  box-shadow: 0 10px 30px color-mix(in srgb, var(--accent) 35%, transparent);
  transition:
    transform 0.12s,
    filter 0.12s;
}
.primary:hover:not(:disabled) {
  filter: brightness(1.1);
}
.primary:active:not(:disabled) {
  transform: scale(0.98);
}
.primary:disabled {
  opacity: 0.4;
  box-shadow: none;
}
.goggles {
  width: 38px;
  height: 24px;
}
.status {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 18px;
  font-size: 18px;
  border-radius: var(--r);
  background: var(--bg-850);
  border: 1px solid var(--border);
}
.status.tone-ok .dot {
  background: var(--ok);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--ok) 22%, transparent);
}
.status.tone-warn {
  color: var(--warn);
}
.status.tone-warn .dot {
  background: var(--warn);
}
.status.tone-danger {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 50%, transparent);
}
.status.tone-danger .dot {
  background: var(--danger);
}
.status-knob {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  color: var(--text-muted);
}
.box {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px;
  border-radius: 22px;
  background: var(--bg-850);
  border: 1px solid var(--border);
}
.box h2 {
  margin: 0;
  font-size: 20px;
  font-weight: 650;
}
.box h3 {
  margin: 6px 0 0;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.formats {
  display: grid;
  grid-template-columns: auto repeat(4, 1fr);
  align-items: center;
  gap: 8px;
}
.formats-label {
  padding-right: 6px;
  font-size: 16px;
  color: var(--text-muted);
}
.fmt {
  height: 50px;
  font-size: 18px;
  font-weight: 500;
  border-radius: 14px;
  border: 1px solid var(--border-strong);
  transition: background-color 0.15s;
}
.fmt:hover {
  background: var(--bg-800);
}
.fmt.is-on {
  background: var(--accent-soft);
  border-color: var(--accent);
}
</style>

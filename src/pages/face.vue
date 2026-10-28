<script setup lang="ts">
import type { FaceScreenMsg } from '~/composables/useFaceScreen'
import type { FaceMessage } from '~/lib/faceState'
import { useEventListener, useIdle } from '@vueuse/core'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import KerfusFace from '~/components/face/KerfusFace.vue'
import { FACE_CHANNEL, faceScreenSettings, SCREEN_PING_MS } from '~/composables/useFaceScreen'
import { KERFUS_COLORS } from '~/lib/kerfus'

defineOptions({ name: 'FacePage' })

/**
 * The face, full window, for a second monitor. Fed by the main window over a
 * BroadcastChannel (see useFaceScreen).
 *
 * Getting out has to be obvious on a screen with nothing else on it: moving
 * the mouse shows full-screen and close buttons, Esc leaves full screen and
 * then closes, and the Face panel can close it from the main window.
 */
const cfg = faceScreenSettings()
const msg = shallowRef<FaceMessage | null>(null)
const edging = ref(false)
const lastFrameAt = ref(0)
const now = ref(performance.now())

/** No frame for a few seconds: the main window is closed, or this one was opened on its own. */
const connected = computed(() => lastFrameAt.value > 0 && now.value - lastFrameAt.value < 3000)

let channel: BroadcastChannel | null = null
let ping: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  document.title = 'playhound face'
  channel = new BroadcastChannel(FACE_CHANNEL)
  channel.onmessage = (e: MessageEvent<FaceScreenMsg>) => {
    if (e.data?.type === 'close')
      close()
    if (e.data?.type !== 'frame')
      return
    msg.value = e.data.msg
    edging.value = e.data.edging
    lastFrameAt.value = performance.now()
  }
  channel.postMessage({ type: 'hello' } satisfies FaceScreenMsg)
  ping = setInterval(() => {
    now.value = performance.now()
    channel?.postMessage({ type: 'ping' } satisfies FaceScreenMsg)
  }, SCREEN_PING_MS / 2)
  addEventListener('pagehide', bye)
})
function bye() {
  channel?.postMessage({ type: 'bye' } satisfies FaceScreenMsg)
}
onBeforeUnmount(() => {
  bye()
  if (ping)
    clearInterval(ping)
  channel?.close()
  removeEventListener('pagehide', bye)
})

const fullscreen = ref(false)
useEventListener(document, 'fullscreenchange', () => {
  fullscreen.value = !!document.fullscreenElement
})

function toggleFullscreen() {
  if (document.fullscreenElement)
    void document.exitFullscreen()
  else
    void document.documentElement.requestFullscreen().catch(() => {})
}

function close() {
  bye()
  window.close()
}

// The browser handles Esc in full screen itself; out of it, Esc closes.
useEventListener(window, 'keydown', (e: KeyboardEvent) => {
  if (e.key === 'Escape' && !document.fullscreenElement) {
    close()
  }
  else if (e.key === 'F11' || e.key.toLowerCase() === 'f') {
    e.preventDefault()
    toggleFullscreen()
  }
})

const { idle } = useIdle(2500)
</script>

<template>
  <main class="face-page" :class="{ 'cursor-none': idle }" @dblclick="toggleFullscreen">
    <KerfusFace class="face" :msg="connected ? msg : null" :edging="connected && edging" :color="cfg.color" :led="cfg.led" />
    <div class="controls" :class="{ shown: !idle }" @dblclick.stop>
      <button type="button" :title="fullscreen ? 'Leave full screen (Esc)' : 'Full screen (F)'" @click="toggleFullscreen">
        <span :class="fullscreen ? 'i-carbon-minimize' : 'i-carbon-maximize'" />
      </button>
      <button type="button" title="Close (Esc)" @click="close">
        <span class="i-carbon-close" />
      </button>
    </div>
    <p class="status" :class="{ shown: !connected || !idle }" :style="{ color: KERFUS_COLORS[cfg.color] }">
      {{ connected ? (fullscreen ? 'Esc leaves full screen' : 'double-click for full screen · Esc closes') : 'waiting for playhound' }}
    </p>
  </main>
</template>

<style scoped>
.face-page {
  position: fixed;
  inset: 0;
  background: #000;
  display: flex;
  align-items: center;
  justify-content: center;
  user-select: none;
}
.face {
  width: min(92vw, calc(92vh * 320 / 140));
  height: auto;
}
.controls {
  position: absolute;
  top: 14px;
  right: 14px;
  display: flex;
  gap: 6px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.3s ease;
}
.controls.shown {
  opacity: 1;
  pointer-events: auto;
}
.controls button {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 8px;
  font-size: 18px;
  color: rgb(255 255 255 / 0.75);
  background: rgb(255 255 255 / 0.08);
  transition: background 0.15s ease;
}
.controls button:hover {
  color: #fff;
  background: rgb(255 255 255 / 0.18);
}
.controls button:last-child:hover {
  background: rgb(220 50 70 / 0.7);
}
.status {
  position: absolute;
  bottom: 18px;
  left: 0;
  right: 0;
  text-align: center;
  font:
    500 13px ui-sans-serif,
    system-ui,
    sans-serif;
  letter-spacing: 0.04em;
  opacity: 0;
  transition: opacity 0.4s ease;
}
.status.shown {
  opacity: 0.45;
}
</style>

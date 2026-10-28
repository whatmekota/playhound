<script setup lang="ts">
import type { FaceScreenMsg } from '~/composables/useFaceScreen'
import type { FaceMessage } from '~/lib/faceState'
import { useIdle } from '@vueuse/core'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import KerfusFace from '~/components/face/KerfusFace.vue'
import { FACE_CHANNEL, faceScreenSettings, SCREEN_PING_MS } from '~/composables/useFaceScreen'
import { KERFUS_COLORS } from '~/lib/kerfus'

defineOptions({ name: 'FacePage' })

/**
 * The face, full window, for a second monitor. Fed by the main window over a
 * BroadcastChannel (see useFaceScreen); double-click for full screen.
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

function toggleFullscreen() {
  if (document.fullscreenElement)
    void document.exitFullscreen()
  else
    void document.documentElement.requestFullscreen().catch(() => {})
}

const { idle } = useIdle(2500)
</script>

<template>
  <main class="face-page" :class="{ 'cursor-none': idle }" @dblclick="toggleFullscreen">
    <KerfusFace class="face" :msg="connected ? msg : null" :edging="connected && edging" :color="cfg.color" :led="cfg.led" />
    <p class="status" :class="{ shown: !connected || !idle }" :style="{ color: KERFUS_COLORS[cfg.color] }">
      {{ connected ? 'double-click for full screen' : 'waiting for playhound' }}
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

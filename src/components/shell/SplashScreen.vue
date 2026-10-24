<script setup lang="ts">
import { useLocalStorage } from '@vueuse/core'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useLibraryStore } from '~/stores/libraryStore'
import BrandMark from './BrandMark.vue'

/**
 * The intro.
 *
 * Plays in full once per browser session; a reload in the same session gets a
 * short beat of the mark instead, since sitting through it every time gets old.
 * It waits for the last folder to come back when that is quick, but never
 * holds the app for more than MAX_MS — and any click or key skips it.
 *
 * Off entirely with `?nosplash` (screenshots, shell work) or the setting.
 */

const SEEN_KEY = 'ph-splash-seen'
const MAX_MS = 2200

const library = useLibraryStore()
// Shared with the settings modal; VueUse keeps same-key refs in sync.
const enabled = useLocalStorage('ph:ui.splash', true)

function flag(fn: () => boolean) {
  try { return fn() }
  catch { return false }
}

const skipParam = flag(() => new URLSearchParams(location.search).has('nosplash'))
const quick = flag(() => sessionStorage.getItem(SEEN_KEY) === '1')
const reducedMotion = flag(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
const MIN_MS = quick ? 260 : reducedMotion ? 500 : 1450

const show = ref(enabled.value && !skipParam)
/** 0..1, eased toward where we expect to be; 1 means leaving. */
const progress = ref(0)
const progressMs = ref(0)

const status = computed(() => {
  if (library.restoring)
    return library.savedFolderName ? `Restoring ${library.savedFolderName}…` : 'Restoring library…'
  if (library.scanning)
    return 'Scanning videos…'
  return progress.value >= 1 ? 'Ready' : 'Starting…'
})

let t0 = 0
let minTimer: ReturnType<typeof setTimeout> | null = null
let maxTimer: ReturnType<typeof setTimeout> | null = null
let stopWait: (() => void) | null = null

function setProgress(p: number, ms: number) {
  progressMs.value = ms
  progress.value = p
}

function finish() {
  if (!show.value)
    return
  setProgress(1, 160)
  cleanup()
  // Let the bar land before the fade starts.
  setTimeout(() => (show.value = false), quick ? 0 : 140)
}

function busy() {
  return library.restoring || library.scanning
}

function onMinElapsed() {
  if (quick || !busy()) {
    finish()
    return
  }
  // The folder is coming back; wait for it, up to the cap.
  setProgress(0.94, MAX_MS - (performance.now() - t0))
  stopWait = watch(busy, b => !b && finish())
  maxTimer = setTimeout(finish, Math.max(0, MAX_MS - (performance.now() - t0)))
}

function onKey(e: KeyboardEvent) {
  // The key that skips the intro should not also play, seek or panic.
  e.stopPropagation()
  finish()
}

function cleanup() {
  if (minTimer)
    clearTimeout(minTimer)
  if (maxTimer)
    clearTimeout(maxTimer)
  stopWait?.()
  minTimer = maxTimer = stopWait = null
  window.removeEventListener('keydown', onKey, true)
}

onMounted(() => {
  if (!show.value)
    return
  try { sessionStorage.setItem(SEEN_KEY, '1') }
  catch {}
  t0 = performance.now()
  window.addEventListener('keydown', onKey, true)
  minTimer = setTimeout(onMinElapsed, MIN_MS)
  // Start the bar on the next frame so its transition actually runs.
  void nextTick(() => requestAnimationFrame(() => setProgress(0.82, MIN_MS)))
})

onBeforeUnmount(cleanup)

const WORD = [...'play'].map(c => ({ c, accent: false })).concat([...'hound'].map(c => ({ c, accent: true })))
</script>

<template>
  <Teleport to="body">
    <Transition name="splash">
      <div
        v-if="show"
        class="splash"
        :class="{ 'is-quick': quick }"
        role="presentation"
        @pointerdown="finish"
      >
        <div class="splash-glow" aria-hidden="true" />

        <div class="splash-stage">
          <div class="splash-mark">
            <span class="splash-ring" aria-hidden="true" />
            <span class="splash-ring splash-ring-2" aria-hidden="true" />
            <BrandMark :size="92" :animated="!quick" />
          </div>

          <h1 class="splash-word" aria-label="playhound">
            <span
              v-for="(l, i) in WORD"
              :key="i"
              :class="{ 'is-accent': l.accent }"
              :style="{ animationDelay: `${780 + i * 38}ms` }"
              aria-hidden="true"
            >{{ l.c }}</span>
          </h1>
          <p class="splash-tag">
            Funscript player <span>·</span> Session engine
          </p>
        </div>

        <div class="splash-foot">
          <div class="splash-track">
            <div
              class="splash-fill"
              :style="{ transform: `scaleX(${progress})`, transitionDuration: `${progressMs}ms` }"
            />
          </div>
          <p class="splash-status" aria-live="polite">
            {{ status }}
          </p>
          <p class="splash-skip">
            Click or press any key to skip
          </p>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.splash {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: var(--bg-base);
  color: var(--text);
  cursor: default;
  user-select: none;
  overflow: hidden;
}

/* Accent bloom behind the mark, swelling as the mark completes. */
.splash-glow {
  position: absolute;
  left: 50%;
  top: 46%;
  width: min(760px, 120vw);
  aspect-ratio: 1;
  translate: -50% -50%;
  background: radial-gradient(
    closest-side,
    color-mix(in srgb, var(--accent) 24%, transparent),
    color-mix(in srgb, var(--accent) 7%, transparent) 55%,
    transparent
  );
  animation: sp-glow 1400ms 200ms var(--ease-out) both;
  pointer-events: none;
}

.splash-stage {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-top: -4vh;
}

.splash-mark {
  position: relative;
  display: grid;
  place-items: center;
  filter: drop-shadow(0 14px 32px color-mix(in srgb, var(--accent) 38%, transparent));
}

/* One ripple out of the mark when it lands, like a pulse leaving a speaker. */
.splash-ring {
  position: absolute;
  inset: -6px;
  border-radius: 34px;
  border: 1.5px solid color-mix(in srgb, var(--accent-light) 55%, transparent);
  opacity: 0;
  animation: sp-ring 1300ms 1000ms var(--ease-out) both;
  pointer-events: none;
}
.splash-ring-2 {
  animation-delay: 1180ms;
}

.splash-word {
  margin: 26px 0 0;
  font-size: 34px;
  line-height: 1;
  font-weight: 650;
  letter-spacing: -0.035em;
  display: flex;
}
.splash-word span {
  display: inline-block;
  animation: sp-letter 620ms var(--ease-out) both;
}
.splash-word .is-accent {
  background: linear-gradient(120deg, var(--accent-light), var(--accent));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.splash-tag {
  margin: 12px 0 0;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: var(--text-faint);
  animation: sp-rise 600ms 1150ms var(--ease-out) both;
}
.splash-tag span {
  color: var(--accent);
  margin: 0 0.3em;
}

.splash-foot {
  position: absolute;
  bottom: 9vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  animation: sp-rise 500ms 400ms var(--ease-out) both;
}
.splash-track {
  width: 168px;
  height: 2px;
  border-radius: 9999px;
  background: color-mix(in srgb, var(--text) 9%, transparent);
  overflow: hidden;
}
.splash-fill {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--accent-strong), var(--accent-light));
  transform-origin: left;
  transform: scaleX(0);
  transition-property: transform;
  transition-timing-function: var(--ease-out);
}
.splash-status {
  margin: 0;
  font-size: 11.5px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  min-height: 1.2em;
}
.splash-skip {
  margin: 14px 0 0;
  font-size: 11px;
  color: var(--text-faint);
  animation: sp-rise 500ms 1400ms var(--ease-out) both;
}

/* A reload in the same session: no choreography, just the mark. */
.is-quick .splash-glow,
.is-quick .splash-word span,
.is-quick .splash-tag,
.is-quick .splash-foot,
.is-quick .splash-skip {
  animation: none;
}
.is-quick .splash-ring {
  display: none;
}

/* ── Leave: fade out while the stage drifts toward the viewer ─────────────── */
.splash-leave-active {
  transition: opacity 420ms var(--ease-out);
  pointer-events: none;
}
.splash-leave-active .splash-stage {
  transition:
    transform 420ms var(--ease-out),
    filter 420ms var(--ease-out);
}
.splash-leave-to {
  opacity: 0;
}
.splash-leave-to .splash-stage {
  transform: scale(1.08);
  filter: blur(6px);
}
.is-quick.splash-leave-active {
  transition-duration: 220ms;
}

@keyframes sp-glow {
  from {
    opacity: 0;
    transform: scale(0.6);
  }
}
@keyframes sp-ring {
  0% {
    opacity: 0;
    transform: scale(0.85);
  }
  25% {
    opacity: 0.9;
  }
  100% {
    opacity: 0;
    transform: scale(1.9);
  }
}
@keyframes sp-letter {
  from {
    opacity: 0;
    transform: translateY(0.45em);
    filter: blur(4px);
  }
}
@keyframes sp-rise {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}
</style>

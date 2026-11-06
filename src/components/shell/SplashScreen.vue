<script setup lang="ts">
import type { LogoId } from '~/lib/logos'
import { useLocalStorage } from '@vueuse/core'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import wordmark from '~/assets/brand/wordmark.svg?raw'
import { useLibraryStore } from '~/stores/libraryStore'
import { useThemeStore } from '~/stores/themeStore'

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
const theme = useThemeStore()
/**
 * The wordmark's colours follow the icon picked in Settings → Appearance, so
 * the splash matches the mark in the title bar.
 */
const WORDMARK: Record<LogoId, Record<string, string>> = {
  'sly-grin': { top: '#f7cdfd', mid: '#e05cf5', bot: '#a21caf', rim: '#7e1689', halo: '#fae8ff', icing: '#fdf7ff', icingShade: '#f3cffb', heart: '#ffffff', deco: '#e879f9' },
  'night': { top: '#34303f', mid: '#211d29', bot: '#131117', rim: '#e879f9', halo: '#3a0c45', icing: '#f0a6fb', icingShade: '#c026d3', heart: '#e879f9', deco: '#d946ef' },
  'noir': { top: '#52525b', mid: '#27272a', bot: '#09090b', rim: '#dc2626', halo: '#450a0a', icing: '#f4f4f5', icingShade: '#d4d4d8', heart: '#dc2626', deco: '#ef4444' },
  'crimson': { top: '#ffb4bf', mid: '#f43f5e', bot: '#9f1239', rim: '#6b0a26', halo: '#ffe4e8', icing: '#fff7f8', icingShade: '#ffd0d8', heart: '#ffffff', deco: '#fb7185' },
  'violet': { top: '#ddd6fe', mid: '#8b5cf6', bot: '#4c1d95', rim: '#2e1065', halo: '#ede9fe', icing: '#faf5ff', icingShade: '#ddd6fe', heart: '#ffffff', deco: '#a78bfa' },
  'orange': { top: '#fed7aa', mid: '#f97316', bot: '#be123c', rim: '#881337', halo: '#ffedd5', icing: '#fff7ed', icingShade: '#fed7aa', heart: '#ffffff', deco: '#fdba74' },
  'lime': { top: '#ecfccb', mid: '#a3e635', bot: '#4d7c0f', rim: '#365314', halo: '#f7fee7', icing: '#fefff5', icingShade: '#d9f99d', heart: '#f472b6', deco: '#a3e635' },
}
const wordmarkStyle = computed(() => {
  const c = WORDMARK[theme.logo] ?? WORDMARK['sly-grin']
  return {
    '--wm-top': c.top,
    '--wm-mid': c.mid,
    '--wm-bot': c.bot,
    '--wm-rim': c.rim,
    '--wm-halo': c.halo,
    '--wm-icing': c.icing,
    '--wm-icing-shade': c.icingShade,
    '--wm-heart': c.heart,
    '--wm-deco': c.deco,
    '--wm-glow': theme.logo === 'night' || theme.logo === 'noir' ? c.rim : c.mid,
  }
})
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
</script>

<template>
  <Teleport to="body">
    <Transition name="splash">
      <div
        v-if="show"
        class="splash"
        :class="{ 'is-quick': quick }"
        :style="wordmarkStyle"
        role="presentation"
        @pointerdown="finish"
      >
        <div class="splash-glow" aria-hidden="true" />

        <div class="splash-stage">
          <h1 class="splash-word" aria-label="playhound" v-html="wordmark" />
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
    color-mix(in srgb, var(--wm-glow) 24%, transparent),
    color-mix(in srgb, var(--wm-glow) 7%, transparent) 55%,
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

/*
 * The candy wordmark (src/assets/brand/wordmark.svg, generated by
 * brand/v2/make-wordmark.mjs): coloured from the theme's accent, its letters
 * dropping in one after another.
 */
.splash-word {
  margin: 0;
  width: min(820px, 92vw);
  line-height: 0;
  filter: drop-shadow(0 10px 24px color-mix(in srgb, var(--wm-glow) 38%, transparent));
}
.splash-word :deep(svg) {
  width: 100%;
  height: auto;
  overflow: visible;
}
.splash-word :deep(.wl) {
  animation: sp-drop 620ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
  animation-delay: calc(240ms + var(--i) * 48ms);
}
.splash-word :deep(.wm-deco > g) {
  transform-box: fill-box;
  transform-origin: center;
  animation: sp-twinkle 700ms var(--ease-out) both;
  animation-delay: calc(820ms + var(--d));
}
.splash-word :deep(.wm-heart) {
  transform-box: fill-box;
  transform-origin: center;
  animation: sp-beat 900ms 1100ms ease-in-out 2 both;
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
  color: var(--wm-deco);
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
  background: linear-gradient(90deg, var(--wm-glow), var(--wm-deco));
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
.is-quick .splash-word :deep(.wl),
.is-quick .splash-word :deep(.wm-heart),
.is-quick .splash-word :deep(.wm-deco > g),
.is-quick .splash-tag,
.is-quick .splash-foot,
.is-quick .splash-skip {
  animation: none;
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
@keyframes sp-drop {
  from {
    opacity: 0;
    transform: translateY(-90px);
  }
  55% {
    opacity: 1;
  }
}
@keyframes sp-beat {
  50% {
    transform: scale(1.25);
  }
}
@keyframes sp-twinkle {
  from {
    opacity: 0;
    transform: scale(0.3) rotate(-30deg);
  }
}
@keyframes sp-rise {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}
</style>

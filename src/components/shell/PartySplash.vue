<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import wordmark from '~/assets/brand/wordmark.svg?raw'
import { useOccluder } from '~/lib/occluders'
import { partyOpen } from '~/lib/party'
import { useWordmarkStyle } from '~/lib/wordmarkStyle'
import BrandMark from './BrandMark.vue'

/**
 * The easter egg (five clicks on the logo in Settings → About): the splash's
 * candy wordmark with the title bar's lockup under it, while paws, hearts,
 * stars and little sine waves float up around them. Any click or key closes
 * it; Esc closes it rather than reaching the shell, where it is the panic key.
 */

const wordmarkStyle = useWordmarkStyle()
// A plugin's web page would otherwise sit on top of it.
useOccluder(() => partyOpen.value)

type Kind = 'paw' | 'heart' | 'star' | 'wave'
interface Floater { id: number, kind: Kind, style: Record<string, string> }

const KINDS: Kind[] = ['paw', 'heart', 'star', 'wave', 'heart', 'paw']
const COLOURS = ['var(--wm-deco)', 'var(--wm-mid)', 'var(--wm-icing)', 'var(--wm-top)', 'var(--wm-rim)']
const COUNT = 34

const reducedMotion = (() => {
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches
  }
  catch {
    return false
  }
})()

const floaters = ref<Floater[]>([])

const rand = (a: number, b: number) => a + Math.random() * (b - a)

function scatter() {
  floaters.value = Array.from({ length: COUNT }, (_, id) => {
    const dur = rand(9, 17)
    return {
      id,
      kind: KINDS[id % KINDS.length],
      style: {
        '--x': `${rand(2, 96).toFixed(1)}%`,
        '--y': `${rand(4, 92).toFixed(1)}%`,
        '--size': `${Math.round(rand(14, 42))}px`,
        '--dur': `${dur.toFixed(1)}s`,
        // Already on their way when it opens, not all starting at the bottom.
        '--delay': `${(-rand(0, dur)).toFixed(1)}s`,
        '--sway': `${Math.round(rand(12, 46))}px`,
        '--spin': `${Math.round(rand(-40, 40))}deg`,
        '--colour': COLOURS[id % COLOURS.length],
        '--alpha': rand(0.45, 0.95).toFixed(2),
      },
    }
  })
}

function close() {
  partyOpen.value = false
}

function onKey(e: KeyboardEvent) {
  e.stopPropagation()
  e.preventDefault()
  close()
}

watch(partyOpen, (open) => {
  if (open) {
    scatter()
    window.addEventListener('keydown', onKey, true)
  }
  else {
    window.removeEventListener('keydown', onKey, true)
  }
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))
</script>

<template>
  <Teleport to="body">
    <Transition name="party">
      <div
        v-if="partyOpen"
        class="party"
        :class="{ 'is-still': reducedMotion }"
        :style="wordmarkStyle"
        role="dialog"
        aria-label="playhound"
        @pointerdown="close"
      >
        <svg width="0" height="0" class="absolute" aria-hidden="true">
          <defs>
            <symbol id="ph-party-paw" viewBox="0 0 24 24">
              <ellipse cx="12" cy="16" rx="5.6" ry="4.6" />
              <ellipse cx="5.2" cy="10.2" rx="2.1" ry="2.7" />
              <ellipse cx="9.3" cy="6.2" rx="2.1" ry="2.8" />
              <ellipse cx="14.7" cy="6.2" rx="2.1" ry="2.8" />
              <ellipse cx="18.8" cy="10.2" rx="2.1" ry="2.7" />
            </symbol>
            <symbol id="ph-party-heart" viewBox="0 0 24 24">
              <path d="M12 21s-7.4-4.6-9.4-9.3C1.1 8 3.3 4.4 6.9 4.4c2 0 3.6 1.1 5.1 3 1.5-1.9 3.1-3 5.1-3 3.6 0 5.8 3.6 4.3 7.3C19.4 16.4 12 21 12 21z" />
            </symbol>
            <symbol id="ph-party-star" viewBox="0 0 24 24">
              <path d="M12 2.6l2.8 6 6.5.7-4.9 4.4 1.4 6.4L12 16.8l-5.8 3.3 1.4-6.4-4.9-4.4 6.5-.7z" stroke-linejoin="round" stroke-width="1.4" stroke="currentColor" />
            </symbol>
            <symbol id="ph-party-wave" viewBox="0 0 24 24">
              <path d="M1.5 12c2.6-6.5 5.2-6.5 7 0s4.4 6.5 7 0 4.4-6.5 7 0" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />
            </symbol>
          </defs>
        </svg>

        <div class="party-glow" aria-hidden="true" />

        <div class="party-floaters" aria-hidden="true">
          <div v-for="f in floaters" :key="f.id" class="party-floater" :style="f.style">
            <svg class="party-shape" :class="`is-${f.kind}`"><use :href="`#ph-party-${f.kind}`" /></svg>
          </div>
        </div>

        <div class="party-stage">
          <h1 class="party-word" aria-label="playhound" v-html="wordmark" />
          <div class="party-lockup">
            <BrandMark :size="34" animated />
            <span class="party-name">play<span class="text-accent-300">hound</span></span>
          </div>
          <p class="party-tag">
            funscript player <span>♥</span> device sync <span>♥</span> sessions
          </p>
        </div>

        <p class="party-hint">
          Click or press any key to go back
        </p>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.party {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: var(--bg-base);
  color: var(--text);
  overflow: hidden;
  user-select: none;
  cursor: default;
}

.party-glow {
  position: absolute;
  left: 50%;
  top: 45%;
  width: min(900px, 130vw);
  aspect-ratio: 1;
  translate: -50% -50%;
  background: radial-gradient(
    closest-side,
    color-mix(in srgb, var(--wm-glow) 28%, transparent),
    color-mix(in srgb, var(--wm-glow) 8%, transparent) 55%,
    transparent
  );
  animation: party-breathe 4.8s ease-in-out infinite;
  pointer-events: none;
}

/* ── Floating paws, hearts, stars and waves ───────────────────────────────── */
.party-floaters {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.party-floater {
  position: absolute;
  left: var(--x);
  top: 0;
  width: var(--size);
  height: var(--size);
  opacity: var(--alpha);
  animation: party-rise var(--dur) linear var(--delay) infinite;
}
.party-shape {
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
  color: var(--colour);
  fill: var(--colour);
  filter: drop-shadow(0 2px 6px color-mix(in srgb, var(--colour) 45%, transparent));
  animation: party-sway calc(var(--dur) / 3.2) ease-in-out var(--delay) infinite alternate;
}
.party-shape.is-wave {
  fill: none;
}

/* ── The wordmark and the lockup ──────────────────────────────────────────── */
.party-stage {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-top: -3vh;
}
.party-word {
  margin: 0;
  width: min(820px, 90vw);
  line-height: 0;
  filter: drop-shadow(0 12px 28px color-mix(in srgb, var(--wm-glow) 42%, transparent));
}
.party-word :deep(svg) {
  width: 100%;
  height: auto;
  overflow: visible;
}
/* Each letter drops in, then they bob in a wave. */
.party-word :deep(.wl) {
  animation:
    party-drop 620ms cubic-bezier(0.34, 1.56, 0.64, 1) both,
    party-bob 2.6s ease-in-out infinite;
  animation-delay: calc(var(--i) * 48ms), calc(700ms + var(--i) * 110ms);
}
.party-word :deep(.wm-deco > g) {
  transform-box: fill-box;
  transform-origin: center;
  animation: party-twinkle 1.8s ease-in-out infinite;
  animation-delay: calc(400ms + var(--d));
}
.party-word :deep(.wm-heart) {
  transform-box: fill-box;
  transform-origin: center;
  animation: party-beat 1.1s 600ms ease-in-out infinite;
}

.party-lockup {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 26px;
  animation: party-rise-in 600ms 500ms var(--ease-out) both;
}
.party-name {
  font-size: 26px;
  font-weight: 600;
  letter-spacing: -0.03em;
}
.party-tag {
  margin: 14px 0 0;
  font-family: 'Fredoka', var(--font-sans, sans-serif);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  animation: party-rise-in 600ms 700ms var(--ease-out) both;
}
.party-tag span {
  color: var(--wm-deco);
  margin: 0 0.35em;
}
.party-hint {
  position: absolute;
  bottom: 6vh;
  margin: 0;
  font-size: 11px;
  color: var(--text-faint);
  animation: party-rise-in 500ms 1200ms var(--ease-out) both;
}

/* Reduced motion: everything in place, nothing moving. */
.is-still .party-floater {
  top: var(--y);
  animation: none;
}
.is-still .party-shape,
.is-still .party-glow,
.is-still .party-word :deep(.wl),
.is-still .party-word :deep(.wm-deco > g),
.is-still .party-word :deep(.wm-heart),
.is-still .party-lockup,
.is-still .party-tag,
.is-still .party-hint {
  animation: none;
}

.party-enter-active,
.party-leave-active {
  transition: opacity 360ms var(--ease-out);
}
.party-enter-from,
.party-leave-to {
  opacity: 0;
}

@keyframes party-rise {
  from {
    transform: translateY(108vh) rotate(0deg);
  }
  to {
    transform: translateY(-14vh) rotate(var(--spin));
  }
}
@keyframes party-sway {
  from {
    transform: translateX(calc(var(--sway) * -1)) rotate(-12deg);
  }
  to {
    transform: translateX(var(--sway)) rotate(12deg);
  }
}
@keyframes party-breathe {
  50% {
    transform: scale(1.08);
    opacity: 0.85;
  }
}
@keyframes party-drop {
  from {
    opacity: 0;
    transform: translateY(-90px);
  }
  55% {
    opacity: 1;
  }
}
@keyframes party-bob {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-9px);
  }
}
@keyframes party-twinkle {
  0%,
  100% {
    transform: scale(1) rotate(0deg);
    opacity: 1;
  }
  50% {
    transform: scale(0.7) rotate(18deg);
    opacity: 0.6;
  }
}
@keyframes party-beat {
  0%,
  100% {
    transform: scale(1);
  }
  30% {
    transform: scale(1.28);
  }
  60% {
    transform: scale(1.05);
  }
}
@keyframes party-rise-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}
</style>

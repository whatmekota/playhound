<script setup lang="ts">
import { onMounted, ref } from 'vue'

const visible = ref(true)
const gone = ref(false)

// ?nosplash skips the intro — useful when grabbing screenshots or iterating on
// the shell, where sitting through the animation every reload gets old.
if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('nosplash')) {
  visible.value = false
  gone.value = true
}

/**
 * Bars for the logo mark: an amplitude envelope that swells toward the middle,
 * so it reads as both an audio waveform and a stroke meter — the two things
 * this app drives. Deterministic, so the mark never renders differently.
 */
const BARS = Array.from({ length: 27 }, (_, i) => {
  const t = i / 26
  const envelope = Math.sin(Math.PI * t) ** 0.7
  const detail = 0.62 + 0.38 * Math.abs(Math.sin(t * Math.PI * 6.5))
  return Math.max(0.08, envelope * detail)
})

onMounted(() => {
  setTimeout(() => {
    visible.value = false
    setTimeout(() => {
      gone.value = true
    }, 500)
  }, 1500)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="splash">
      <div v-if="!gone && visible" class="splash-root">
        <div class="splash-bg" />

        <div class="splash-logo">
          <div class="splash-mark">
            <div class="splash-bars">
              <span
                v-for="(h, i) in BARS"
                :key="i"
                class="splash-bar-tick"
                :style="{
                  height: `${h * 100}%`,
                  animationDelay: `${i * 26}ms`,
                }"
              />
            </div>
            <span class="splash-axis" />
          </div>

          <div class="splash-title">
            play<span>hound</span>
          </div>
          <div class="splash-sub">
            Session engine &middot; Funscript player
          </div>
        </div>

        <div class="splash-bar-wrap">
          <div class="splash-bar" />
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.splash-root {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: var(--bg-base, #0a0a0a);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 30px;
}

.splash-bg {
  position: absolute;
  inset: 0;
  background: radial-gradient(
    ellipse 55% 45% at 50% 50%,
    color-mix(in srgb, var(--accent) 14%, transparent) 0%,
    transparent 70%
  );
  animation: pulse-bg 2.2s ease-in-out infinite alternate;
}

@keyframes pulse-bg {
  from {
    opacity: 0.45;
  }
  to {
    opacity: 1;
  }
}

.splash-logo {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  animation: logo-in 0.6s cubic-bezier(0.16, 1, 0.3, 1) both;
}

@keyframes logo-in {
  from {
    opacity: 0;
    transform: translateY(14px) scale(0.96);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

/* ── Mark ─────────────────────────────────────────────────────────────────── */
.splash-mark {
  position: relative;
  width: 132px;
  height: 132px;
  border-radius: 30px;
  border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
  background: color-mix(in srgb, var(--accent) 7%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--accent) 12%, transparent),
    0 12px 40px -12px color-mix(in srgb, var(--accent) 55%, transparent);
}

.splash-bars {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  width: 88px;
  height: 64px;
}

.splash-bar-tick {
  flex: 1;
  border-radius: 9999px;
  background: linear-gradient(to bottom, var(--accent-light, #e879f9), var(--accent, #c026d3));
  transform-origin: center;
  animation: tick-in 0.5s cubic-bezier(0.16, 1, 0.3, 1) both;
}

@keyframes tick-in {
  from {
    transform: scaleY(0.12);
    opacity: 0;
  }
  to {
    transform: scaleY(1);
    opacity: 1;
  }
}

/* Stroke axis: the vertical line the device actually moves along. */
.splash-axis {
  position: absolute;
  top: 22px;
  bottom: 22px;
  width: 1px;
  background: linear-gradient(to bottom, transparent, color-mix(in srgb, var(--accent) 55%, transparent), transparent);
  animation: axis-sweep 1.6s 0.3s cubic-bezier(0.4, 0, 0.2, 1) infinite;
}

@keyframes axis-sweep {
  0% {
    transform: translateY(-30%);
    opacity: 0;
  }
  35% {
    opacity: 1;
  }
  100% {
    transform: translateY(30%);
    opacity: 0;
  }
}

/* ── Wordmark ─────────────────────────────────────────────────────────────── */
.splash-title {
  font-family: 'Inter', system-ui, sans-serif;
  font-size: 25px;
  font-weight: 700;
  letter-spacing: 0.18em;
  color: var(--text, #fff);
  animation: logo-in 0.6s 0.12s cubic-bezier(0.16, 1, 0.3, 1) both;
}
.splash-title span {
  color: var(--accent-light, #e879f9);
}

.splash-sub {
  font-size: 10px;
  letter-spacing: 0.26em;
  text-transform: uppercase;
  color: var(--text-faint, rgba(255, 255, 255, 0.3));
  animation: logo-in 0.6s 0.24s cubic-bezier(0.16, 1, 0.3, 1) both;
}

/* ── Loading bar ──────────────────────────────────────────────────────────── */
.splash-bar-wrap {
  width: 172px;
  height: 2px;
  background: color-mix(in srgb, var(--text) 8%, transparent);
  border-radius: 9999px;
  overflow: hidden;
  animation: logo-in 0.4s 0.4s both;
}

.splash-bar {
  height: 100%;
  width: 0%;
  background: linear-gradient(90deg, var(--accent), var(--accent-light));
  border-radius: 9999px;
  animation: bar-fill 1.2s 0.3s cubic-bezier(0.4, 0, 0.2, 1) forwards;
}

@keyframes bar-fill {
  from {
    width: 0%;
  }
  to {
    width: 100%;
  }
}

.splash-enter-active {
  transition: opacity 0.25s;
}
.splash-leave-active {
  transition: opacity 0.5s ease;
}
.splash-enter-from,
.splash-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .splash-axis,
  .splash-bg {
    animation: none;
  }
}
</style>

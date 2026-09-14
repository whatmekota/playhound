<script setup lang="ts">
import { onMounted, ref } from 'vue'

const visible = ref(true)
const gone = ref(false)

onMounted(() => {
  // Hold for 1.8s then fade out
  setTimeout(() => {
    visible.value = false
    setTimeout(() => { gone.value = true }, 600)
  }, 1800)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="splash">
      <div
        v-if="!gone && visible"
        class="splash-root"
      >
        <!-- animated background radial glow -->
        <div class="splash-bg" />

        <!-- logo mark -->
        <div class="splash-logo">
          <!-- Womb tattoo SVG in #FF0057 -->
          <svg class="splash-svg" viewBox="0 0 680 680" xmlns="http://www.w3.org/2000/svg">
            <rect width="680" height="680" rx="120" fill="#0d0005" />
            <rect width="680" height="680" rx="120" fill="none" stroke="#ff0057" stroke-width="8" />

            <g stroke-linecap="square" stroke-linejoin="miter">

              <!-- M - bold and vivid -->
              <path d="M 150,540 L 150,170 L 340,380 L 530,170 L 530,540" fill="none" stroke="#ff0057" stroke-width="52" stroke-opacity="1" />

              <!-- Waveform - subtle/ghost -->
              <polyline
                fill="none" stroke="#ff0057" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" stroke-opacity="0.25" points="
    60,340
    105,340
    115,270
    130,400
    148,295
    163,375
    180,310
    196,360
    212,285
    230,395
    248,260
    268,420
    288,240
    308,430
    328,255
    340,340
    352,255
    372,430
    392,240
    412,420
    432,260
    450,395
    468,310
    484,360
    500,295
    517,375
    532,305
    548,400
    562,270
    575,340
    620,340
  "
              />

            </g>
          </svg>
          <div class="splash-title">
            MWHO<span>PLAYER</span>
          </div>
          <div class="splash-sub">
            Funscript Player
          </div>
        </div>

        <!-- loading bar -->
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
  background: #080808;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 28px;
}

.splash-bg {
  position: absolute;
  inset: 0;
  background: radial-gradient(ellipse 60% 50% at 50% 50%, rgba(255, 0, 87, 0.12) 0%, transparent 70%);
  animation: pulse-bg 2s ease-in-out infinite alternate;
}

@keyframes pulse-bg {
  from {
    opacity: 0.5;
  }
  to {
    opacity: 1;
  }
}

.splash-logo {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  animation: logo-in 0.7s cubic-bezier(0.16, 1, 0.3, 1) both;
}

@keyframes logo-in {
  from {
    opacity: 0;
    transform: translateY(20px) scale(0.9);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.splash-svg {
  width: 80px;
  height: 80px;
  filter: drop-shadow(0 0 18px rgba(255, 0, 87, 0.6));
  animation: glow-pulse 1.5s ease-in-out infinite alternate;
}

@keyframes glow-pulse {
  from {
    filter: drop-shadow(0 0 12px rgba(255, 0, 87, 0.5));
  }
  to {
    filter: drop-shadow(0 0 28px rgba(255, 0, 87, 0.9));
  }
}

.splash-title {
  font-family: 'Inter', system-ui, sans-serif;
  font-size: 22px;
  font-weight: 800;
  letter-spacing: 0.2em;
  color: rgba(255, 255, 255, 0.9);
  animation: logo-in 0.7s 0.15s cubic-bezier(0.16, 1, 0.3, 1) both;
}
.splash-title span {
  color: #ff0057;
}

.splash-sub {
  font-size: 11px;
  letter-spacing: 0.3em;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.3);
  animation: logo-in 0.7s 0.3s cubic-bezier(0.16, 1, 0.3, 1) both;
}

.splash-bar-wrap {
  width: 180px;
  height: 2px;
  background: rgba(255, 255, 255, 0.08);
  border-radius: 9999px;
  overflow: hidden;
  animation: logo-in 0.5s 0.5s both;
}

.splash-bar {
  height: 100%;
  width: 0%;
  background: linear-gradient(90deg, #ff0057, #ff4d87);
  border-radius: 9999px;
  animation: bar-fill 1.4s 0.4s cubic-bezier(0.4, 0, 0.2, 1) forwards;
}

@keyframes bar-fill {
  from {
    width: 0%;
  }
  to {
    width: 100%;
  }
}

/* Exit transition */
.splash-enter-active {
  transition: opacity 0.3s;
}
.splash-leave-active {
  transition: opacity 0.6s ease;
}
.splash-enter-from,
.splash-leave-to {
  opacity: 0;
}
</style>

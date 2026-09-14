<script setup lang="ts">
import type { RemoteAction, RemoteState } from '~/composables/useRemoteLink'
import { computed, onMounted, ref } from 'vue'
import { useRemoteLink } from '~/composables/useRemoteLink'

defineOptions({ name: 'RemotePage' })

const route = useRoute()
const room = computed(() => String(route.query.room ?? ''))

const state = ref<RemoteState | null>(null)

const link = useRemoteLink('remote', () => room.value, (msg) => {
  if (msg?.type === 'state')
    state.value = msg.state
})

function send(action: RemoteAction) {
  link.send({ type: 'cmd', action })
  // Haptic confirmation matters here: this gets used without looking.
  navigator.vibrate?.(action === 'panic' ? 60 : 15)
}

onMounted(() => {
  if (room.value)
    link.connect()
  link.send({ type: 'hello' })
})

const hostOnline = computed(() => link.peers.value.hosts > 0)
</script>

<template>
  <div class="text-fg bg-surface-950 flex flex-col max-w-full min-h-screen w-full select-none overflow-x-hidden">
    <!-- Status -->
    <header class="px-4 py-3 border-b border-edge flex shrink-0 gap-2 items-center">
      <span
        class="rounded-full shrink-0 h-2 w-2"
        :class="link.connected.value && hostOnline ? 'bg-emerald-400' : 'bg-amber-400'"
      />
      <span class="text-xs text-fg-muted">
        {{ !room ? 'No room in link' : link.connected.value ? (hostOnline ? 'Connected' : 'Waiting for desktop') : 'Connecting…' }}
      </span>
      <span class="text-[13px] tracking-tight font-bold ml-auto">
        play<span class="text-accent-400">hound</span>
      </span>
    </header>

    <div v-if="!room" class="p-6 text-center flex-1 grid place-items-center">
      <p class="text-sm text-fg-muted">
        Open the Remote panel on the desktop and use the link it shows.
      </p>
    </div>

    <template v-else>
      <!-- Now playing -->
      <div class="px-4 py-4 border-b border-edge shrink-0">
        <p class="text-sm truncate" :class="state?.title ? 'text-fg' : 'text-fg-faint'">
          {{ state?.title || 'Nothing playing' }}
        </p>
        <div class="text-[11px] text-fg-faint font-mono mt-1 flex gap-3 items-center">
          <span>{{ state?.playing ? 'playing' : 'paused' }}</span>
          <span v-if="state">· {{ (state.intensity * 100).toFixed(0) }}%</span>
          <span v-if="state?.motion">· {{ state.spm.toFixed(0) }} spm</span>
        </div>
      </div>

      <!-- Panic: biggest target, always reachable -->
      <div class="p-4 shrink-0">
        <button
          class="text-sm font-semibold rounded-2xl h-16 w-full transition-colors"
          :class="state?.panicked
            ? 'bg-emerald-500/20 text-emerald-300'
            : 'bg-red-500/15 text-red-300 active:bg-red-500/30'"
          @click="send('panic')"
        >
          {{ state?.panicked ? 'Resume' : 'Panic — stop everything' }}
        </button>
      </div>

      <!-- Transport -->
      <div class="px-4 shrink-0 gap-2.5 grid grid-cols-3">
        <button class="rc-btn" @click="send('prev')">
          <div class="i-carbon-skip-back text-xl" />
          <span>Prev</span>
        </button>
        <button class="rc-btn rc-primary" @click="send('togglePlay')">
          <div :class="state?.playing ? 'i-carbon-pause-filled' : 'i-carbon-play-filled-alt'" class="text-xl" />
          <span>{{ state?.playing ? 'Pause' : 'Play' }}</span>
        </button>
        <button class="rc-btn" @click="send('next')">
          <div class="i-carbon-skip-forward text-xl" />
          <span>Next</span>
        </button>
      </div>

      <div class="px-4 pt-2.5 shrink-0 gap-2.5 grid grid-cols-3">
        <button class="rc-btn" @click="send('random')">
          <div class="i-carbon-shuffle text-xl" />
          <span>Random</span>
        </button>
        <button
          class="rc-btn" :class="state?.motion ? 'text-emerald-300' : ''"
          @click="send('motionToggle')"
        >
          <div class="i-carbon-wave-height text-xl" />
          <span>Motion</span>
        </button>
        <button
          class="rc-btn" :class="state?.audio ? 'text-teal-300' : ''"
          @click="send('audioToggle')"
        >
          <div class="i-carbon-headphones text-xl" />
          <span>Audio</span>
        </button>
      </div>

      <!-- Intensity -->
      <div class="mt-2 p-4">
        <p class="label mb-2">
          Intensity
        </p>
        <div class="gap-2.5 grid grid-cols-2">
          <button class="rc-btn h-14" @click="send('intensityDown')">
            <div class="i-carbon-subtract text-xl" />
          </button>
          <button class="rc-btn h-14" @click="send('intensityUp')">
            <div class="i-carbon-add text-xl" />
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.rc-btn {
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 4.5rem;
  border-radius: 1rem;
  font-size: 11px;
  background: var(--bg-800);
  color: var(--text-muted);
  transition: background-color 0.12s;
}
.rc-btn:active {
  background: var(--bg-700);
}
.rc-primary {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  color: var(--text);
}
</style>

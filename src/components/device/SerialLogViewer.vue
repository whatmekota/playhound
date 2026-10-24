<script setup lang="ts">
import { computed, ref } from 'vue'
import { toast } from '~/composables/useToast'
import { serialLog } from '~/lib/serialLog'

/**
 * The raw command stream, newest first.
 *
 * Lives inside the Device inspector. The log moves at frame rate while
 * anything is playing, which makes a line impossible to read, so it can be
 * frozen on a snapshot without stopping the logging underneath.
 */

/** Rendering all 200 lines at 30 Hz is wasted work; nobody reads that far down live. */
const VISIBLE = 120

const frozen = ref<string[] | null>(null)
const lines = computed(() => (frozen.value ?? serialLog.value).slice(0, VISIBLE))

function toggleFreeze() {
  frozen.value = frozen.value ? null : [...serialLog.value]
}

function clear() {
  serialLog.value = []
  frozen.value = null
}

async function copy() {
  try {
    await navigator.clipboard.writeText([...(frozen.value ?? serialLog.value)].reverse().join('\n'))
    toast.success('Log copied', { key: 'serial-log' })
  }
  catch {
    toast.error('Could not copy the log', { key: 'serial-log' })
  }
}

/** Split "HH:MM:SS  L05000I40" into time and command for colouring. */
function parts(line: string) {
  return { time: line.slice(0, 8), cmd: line.slice(8).trim() }
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <div class="flex gap-1 items-center">
      <span class="text-[11.5px] text-fg-faint num">
        {{ serialLog.length }} {{ serialLog.length === 1 ? 'command' : 'commands' }}
      </span>
      <span v-if="frozen" class="text-[11px] text-warn font-medium ml-1.5 flex gap-1 items-center">
        <span class="i-carbon-pause-filled text-[11px]" />
        Frozen
      </span>
      <div class="ml-auto flex gap-0.5 items-center">
        <UiIconButton
          :icon="frozen ? 'i-carbon-play' : 'i-carbon-pause'"
          :label="frozen ? 'Follow live' : 'Freeze to read'"
          :active="!!frozen"
          size="xs"
          @click="toggleFreeze"
        />
        <UiIconButton icon="i-carbon-copy" label="Copy log" size="xs" :disabled="!serialLog.length" @click="copy" />
        <UiIconButton icon="i-carbon-erase" label="Clear" size="xs" :disabled="!serialLog.length" @click="clear" />
      </div>
    </div>

    <div class="font-mono py-1.5 scroll-y rounded-[var(--radius-md)] bg-surface-950/70 h-56 ring-1 ring-edge">
      <div v-if="!lines.length" class="text-center flex flex-col gap-1.5 h-full items-center justify-center">
        <span class="i-carbon-terminal text-[20px] text-fg-faint" />
        <span class="text-[12px] text-fg-faint font-sans">Nothing sent yet</span>
        <span class="hint font-sans">Play a script or press Test to see commands here</span>
      </div>
      <div
        v-for="(line, i) in lines"
        :key="i"
        class="text-[11px] leading-[18px] px-2.5 flex gap-2.5 whitespace-nowrap hover:bg-fg/5"
      >
        <span class="text-fg-faint shrink-0">{{ parts(line).time }}</span>
        <span class="truncate" :class="parts(line).cmd.startsWith('[BP]') ? 'text-info' : 'text-accent-300'">{{ parts(line).cmd }}</span>
      </div>
    </div>
  </div>
</template>

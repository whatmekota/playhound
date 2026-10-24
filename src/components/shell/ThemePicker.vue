<script setup lang="ts">
import { ref } from 'vue'
import { THEMES, useThemeStore } from '~/stores/themeStore'

const theme = useThemeStore()
const open = ref(false)
const root = ref<HTMLElement | null>(null)

onClickOutside(root, () => {
  open.value = false
})

/** Swatch colours per theme, as literal hex so they render regardless of the
 *  active theme's variables. Order: background, surface, accent. */
const SWATCHES: Record<string, [string, string, string]> = {
  dark: ['#0a0a0a', '#1e1e1e', '#c026d3'],
  light: ['#f4f4f5', '#e2e2e5', '#7c3aed'],
  catppuccin: ['#1e1e2e', '#313244', '#cba6f7'],
  dracula: ['#282a36', '#44475a', '#bd93f9'],
}

function pick(id: typeof THEMES[number]['id']) {
  theme.apply(id)
  open.value = false
}
</script>

<template>
  <div ref="root" class="relative">
    <button
      class="btn-icon"
      :class="open ? 'bg-fg/10 text-fg' : ''"
      title="Theme"
      :aria-expanded="open"
      aria-haspopup="true"
      @click="open = !open"
    >
      <span class="border border-edge rounded-full flex gap-px h-3.5 w-3.5 overflow-hidden">
        <span
          v-for="(c, i) in SWATCHES[theme.current] ?? SWATCHES.dark"
          :key="i"
          class="flex-1"
          :style="{ background: c }"
        />
      </span>
    </button>

    <Transition
      enter-active-class="transition duration-100 ease-out"
      enter-from-class="opacity-0 -translate-y-1"
      leave-active-class="transition duration-75 ease-in"
      leave-to-class="opacity-0"
    >
      <div
        v-if="open"
        class="panel mt-1.5 p-1 w-40 shadow-black/40 shadow-xl right-0 top-full absolute z-50"
      >
        <button
          v-for="t in THEMES"
          :key="t.id"
          class="text-xs px-2 py-1.5 rounded-lg flex gap-2 w-full transition-colors items-center"
          :class="theme.current === t.id
            ? 'bg-accent-500/15 text-accent-400'
            : 'text-fg-muted hover:bg-fg/8 hover:text-fg'"
          @click="pick(t.id)"
        >
          <span class="border border-edge rounded flex shrink-0 gap-px h-3.5 w-6 overflow-hidden">
            <span
              v-for="(c, i) in SWATCHES[t.id] ?? SWATCHES.dark"
              :key="i"
              class="flex-1"
              :style="{ background: c }"
            />
          </span>
          <span class="text-left flex-1">{{ t.label }}</span>
          <div v-if="theme.current === t.id" class="i-carbon-checkmark text-[11px] shrink-0" />
        </button>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiInput from '~/components/ui/UiInput.vue'
import UiKbd from '~/components/ui/UiKbd.vue'
import UiModal from '~/components/ui/UiModal.vue'
import { HOTKEY_GROUPS } from '~/lib/hotkeys'
import { useUiStore } from '~/stores/uiStore'

/**
 * The cheat sheet. Rendered from HOTKEY_GROUPS, the same list the shell
 * dispatches from, so it cannot fall out of date.
 */
const ui = useUiStore()
const filter = ref('')

watch(() => ui.shortcutsOpen, (open) => {
  if (open)
    filter.value = ''
})

const GROUP_ICON: Record<string, string> = {
  Playback: 'i-carbon-play-filled-alt',
  Navigate: 'i-carbon-compass',
  Library: 'i-carbon-video-chat',
  Audio: 'i-carbon-volume-up',
  Speed: 'i-carbon-meter',
  Safety: 'i-carbon-warning-hex',
  Help: 'i-carbon-help',
}

type Part = { kind: 'key', text: string } | { kind: 'sep', text: string }

/** "Shift + ← / →" → keycaps with the joiners between them. */
function parse(keys: string): Part[] {
  return keys
    .split(/\s+(\+|\/|or)\s+/)
    .filter(Boolean)
    .map((t, i): Part => (i % 2 ? { kind: 'sep', text: t } : { kind: 'key', text: t.trim() }))
}

const groups = computed(() => {
  const q = filter.value.trim().toLowerCase()
  return HOTKEY_GROUPS
    .map(g => ({
      ...g,
      icon: GROUP_ICON[g.title] ?? 'i-carbon-keyboard',
      keys: g.keys
        .filter(k => !q || k.label.toLowerCase().includes(q) || k.keys.toLowerCase().includes(q) || g.title.toLowerCase().includes(q))
        .map(k => ({ ...k, parts: parse(k.keys) })),
    }))
    .filter(g => g.keys.length)
})

function openPalette() {
  ui.shortcutsOpen = false
  ui.paletteOpen = true
}
</script>

<template>
  <UiModal
    v-model:open="ui.shortcutsOpen"
    title="Keyboard shortcuts"
    subtitle="Keys are ignored while you type in a field — except Ctrl K."
    icon="i-carbon-keyboard"
    width="820px"
  >
    <div class="flex flex-col gap-4">
      <UiInput
        v-model="filter"
        icon="i-carbon-search"
        placeholder="Filter shortcuts…"
        size="md"
        clearable
      />

      <div v-if="groups.length" class="gap-3 columns-1 lg:columns-3 sm:columns-2">
        <section
          v-for="(g, gi) in groups"
          :key="g.title"
          class="mb-3 p-3 card animate-rise break-inside-avoid"
          :class="g.title === 'Safety' ? '!border-danger/30 !bg-danger/6' : ''"
          :style="{ animationDelay: `${gi * 35}ms` }"
        >
          <header class="mb-2 flex gap-2 items-center">
            <span :class="[g.icon, g.title === 'Safety' ? 'text-danger' : 'text-accent-300']" class="text-[14px]" />
            <span class="eyebrow">{{ g.title }}</span>
          </header>
          <div class="flex flex-col">
            <div
              v-for="k in g.keys"
              :key="k.keys"
              class="py-1.5 border-t border-edge flex gap-3 items-center justify-between first:border-t-0"
            >
              <span class="text-[12.5px] text-fg-muted leading-snug">{{ k.label }}</span>
              <span class="flex shrink-0 gap-1 items-center">
                <template v-for="(p, pi) in k.parts" :key="pi">
                  <UiKbd v-if="p.kind === 'key'">{{ p.text }}</UiKbd>
                  <span v-else class="text-[10.5px] text-fg-faint">{{ p.text }}</span>
                </template>
              </span>
            </div>
          </div>
        </section>
      </div>

      <p v-else class="hint py-8 text-center">
        No shortcut matches “{{ filter }}”.
      </p>
    </div>

    <template #footer>
      <span class="hint mr-auto">
        Press <UiKbd>?</UiKbd> anywhere to bring this back.
      </span>
      <UiButton icon="i-carbon-search" @click="openPalette">
        Command palette
      </UiButton>
    </template>
  </UiModal>
</template>

<script setup lang="ts">
import type { ViewId } from '~/lib/views'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { VIEW_GROUPS } from '~/lib/views'
import { usePlaybackStore } from '~/stores/playbackStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useUiStore } from '~/stores/uiStore'
import BrandMark from './BrandMark.vue'

const emit = defineEmits<{ open: [] }>()
const ui = useUiStore()
const player = usePlayerStore()
const playback = usePlaybackStore()

const listEl = ref<HTMLElement | null>(null)
const indicator = ref({ top: 0, height: 0, show: false })

function measure() {
  const el = listEl.value?.querySelector<HTMLElement>(`[data-view="${ui.view}"]`)
  if (!el) {
    indicator.value.show = false
    return
  }
  indicator.value = { top: el.offsetTop, height: el.offsetHeight, show: true }
}
onMounted(() => {
  measure()
  document.fonts?.ready.then(measure)
})
watch(() => [ui.view, ui.navExpanded], () => nextTick(measure))

/** The player icon shows a live equaliser while something is playing. */
const playing = computed(() => player.isPlaying)

function go(id: ViewId) {
  ui.openView(id)
}
</script>

<template>
  <nav
    class="border-r border-edge bg-surface-900 flex shrink-0 flex-col select-none transition-[width] duration-300 ease-[var(--ease-out)] relative z-20"
    :style="{ width: ui.navExpanded ? '196px' : 'var(--nav-w)' }"
    aria-label="Views"
  >
    <!-- Brand -->
    <div class="px-3.5 flex shrink-0 gap-2.5 h-14 items-center overflow-hidden">
      <BrandMark :size="30" />
      <span
        class="text-[15px] tracking-[-0.02em] font-semibold whitespace-nowrap transition-opacity duration-200"
        :class="ui.navExpanded ? 'opacity-100' : 'opacity-0'"
      >play<span class="text-accent-300">hound</span></span>
    </div>

    <!-- Views -->
    <div ref="listEl" class="px-2.5 pb-2 scroll-y flex flex-1 flex-col gap-0.5 relative overflow-x-hidden">
      <span
        class="rounded-[var(--radius-md)] bg-fg/8 transition-all duration-300 ease-[var(--ease-out)] left-2.5 right-2.5 absolute"
        :style="{ top: `${indicator.top}px`, height: `${indicator.height}px`, opacity: indicator.show ? 1 : 0 }"
      />
      <template v-for="(group, gi) in VIEW_GROUPS" :key="group.id">
        <div
          class="text-[10px] tracking-[0.08em] font-semibold px-2 whitespace-nowrap uppercase transition-all duration-200 overflow-hidden"
          :class="[gi === 0 ? 'mt-0' : 'mt-3', ui.navExpanded ? 'text-fg-faint h-5 opacity-100' : 'h-0 opacity-0']"
        >
          {{ group.label }}
        </div>
        <div v-if="gi > 0 && !ui.navExpanded" class="mx-2 my-1.5 divider-y" />
        <button
          v-for="item in group.items"
          :key="item.id"
          v-tip="ui.navExpanded ? undefined : { text: item.label, kbd: item.kbd, placement: 'right' }"
          :data-view="item.id"
          type="button"
          class="group px-2.5 focusable rounded-[var(--radius-md)] flex shrink-0 gap-3 h-10 transition-colors items-center relative z-1"
          :class="ui.view === item.id ? 'text-fg' : 'text-fg-muted hover:text-fg hover:bg-fg/4'"
          :aria-current="ui.view === item.id ? 'page' : undefined"
          @click="go(item.id)"
        >
          <span class="center shrink-0 h-5 w-5 relative">
            <span
              v-if="item.id === 'player' && playing && ui.view !== 'player'"
              class="flex gap-[2px] h-3.5 items-end"
              aria-hidden="true"
            >
              <span v-for="b in 3" :key="b" class="rounded-full bg-accent h-full w-[3px] origin-bottom [animation:ph-eq_.9s_ease-in-out_infinite]" :style="{ animationDelay: `${b * 0.18}s` }" />
            </span>
            <span v-else :class="[item.icon, ui.view === item.id ? 'text-accent-300' : '']" class="text-[18px] transition-transform duration-200 group-active:scale-90" />
          </span>
          <span
            class="text-[13px] font-medium whitespace-nowrap transition-opacity duration-200"
            :class="ui.navExpanded ? 'opacity-100' : 'opacity-0'"
          >{{ item.label }}</span>
        </button>
      </template>
    </div>

    <!-- Actions -->
    <div class="px-2.5 py-2.5 border-t border-edge flex shrink-0 flex-col gap-0.5">
      <button
        v-for="a in [
          { icon: 'i-carbon-search', label: 'Search & commands', kbd: 'Ctrl K', run: () => (ui.paletteOpen = true) },
          { icon: 'i-carbon-document-add', label: 'Open a video', kbd: undefined, run: () => emit('open') },
          { icon: 'i-carbon-shuffle', label: 'Play something random', kbd: 'R', run: () => playback.random() },
          { icon: 'i-carbon-settings', label: 'Settings', kbd: undefined, run: () => (ui.settingsOpen = true) },
        ]"
        :key="a.label"
        v-tip="ui.navExpanded ? undefined : { text: a.label, kbd: a.kbd, placement: 'right' }"
        type="button"
        class="text-fg-muted px-2.5 focusable rounded-[var(--radius-md)] flex shrink-0 gap-3 h-9 transition-colors items-center hover:text-fg hover:bg-fg/6"
        @click="a.run()"
      >
        <span :class="a.icon" class="text-[17px] shrink-0 w-5" />
        <span class="text-[12.5px] whitespace-nowrap transition-opacity duration-200" :class="ui.navExpanded ? 'opacity-100' : 'opacity-0'">{{ a.label }}</span>
      </button>
      <button
        v-tip="ui.navExpanded ? undefined : { text: 'Expand', placement: 'right' }"
        type="button"
        class="text-fg-faint px-2.5 focusable rounded-[var(--radius-md)] flex shrink-0 gap-3 h-8 transition-colors items-center hover:text-fg hover:bg-fg/6"
        :aria-label="ui.navExpanded ? 'Collapse sidebar' : 'Expand sidebar'"
        @click="ui.navExpanded = !ui.navExpanded"
      >
        <span class="i-carbon-side-panel-open text-[16px] shrink-0 w-5 transition-transform duration-300" :class="ui.navExpanded ? 'rotate-180' : ''" />
        <span class="text-[12px] whitespace-nowrap transition-opacity duration-200" :class="ui.navExpanded ? 'opacity-100' : 'opacity-0'">Collapse</span>
      </button>
    </div>
  </nav>
</template>

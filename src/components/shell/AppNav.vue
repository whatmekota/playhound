<script setup lang="ts">
import type { ViewId } from '~/lib/views'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { offeredHere } from '~/lib/android/features'
import { desktop } from '~/lib/browserApi'
import { MOD_KEY } from '~/lib/platform'
import { VIEW_GROUPS } from '~/lib/views'
import { usePlaybackStore } from '~/stores/playbackStore'
import { usePlayerStore } from '~/stores/playerStore'
import { usePluginStore } from '~/stores/pluginStore'
import { useUiStore } from '~/stores/uiStore'
import BrandMark from './BrandMark.vue'

const emit = defineEmits<{ open: [] }>()
const ui = useUiStore()
const player = usePlayerStore()
const playback = usePlaybackStore()
const pluginStore = usePluginStore()
/** What this build offers (the Android app leaves a few views out for now). */
const groups = VIEW_GROUPS.map(g => ({ ...g, items: g.items.filter(i => offeredHere(i.id)) })).filter(g => g.items.length)
/** The desktop title bar already carries the brand. */
const showBrand = !desktop?.window

const listEl = ref<HTMLElement | null>(null)
const indicator = ref({ top: 0, height: 0, show: false })

/** The nav item for what the stage shows: a view id, or `plugin:<id>` for a plugin's page. */
const current = computed(() => (ui.view === 'plugin' ? `plugin:${ui.pluginView}` : ui.view))

function measure() {
  const el = listEl.value?.querySelector<HTMLElement>(`[data-view="${current.value}"]`)
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
watch([current, () => pluginStore.pages.length], () => nextTick(measure))

// Expanding or collapsing animates the group headings' height for 200ms and
// the nav's width for 300ms, which moves every item after a single
// measurement: keep measuring each frame until it has all settled.
let followUntil = 0
function follow() {
  measure()
  if (performance.now() < followUntil)
    requestAnimationFrame(follow)
}
watch(() => ui.navExpanded, () => {
  const running = performance.now() < followUntil
  followUntil = performance.now() + 450
  if (!running)
    requestAnimationFrame(follow)
})

/** The player icon shows a live equaliser while something is playing. */
const playing = computed(() => player.isPlaying)

function go(id: ViewId) {
  ui.openView(id)
}

const pageTitle = (p: (typeof pluginStore.pages)[number]) => p.page?.title || p.manifest.name
</script>

<template>
  <nav
    class="border-r border-edge bg-surface-900 flex shrink-0 flex-col select-none transition-[width] duration-300 ease-[var(--ease-out)] relative z-20"
    :style="{ width: ui.navExpanded ? '196px' : 'var(--nav-w)' }"
    aria-label="Views"
  >
    <!-- Brand -->
    <div v-if="showBrand" class="px-3.5 flex shrink-0 gap-2.5 h-14 items-center overflow-hidden">
      <BrandMark :size="30" />
      <span
        class="text-[15px] tracking-[-0.02em] font-semibold whitespace-nowrap transition-opacity duration-200"
        :class="ui.navExpanded ? 'opacity-100' : 'opacity-0'"
      >play<span class="text-accent-300">hound</span></span>
    </div>

    <!-- Views -->
    <div ref="listEl" class="px-2.5 pb-2 scroll-y flex flex-1 flex-col gap-0.5 relative overflow-x-hidden" :class="showBrand ? '' : 'pt-2.5'">
      <span
        class="rounded-[var(--radius-md)] bg-fg/8 transition-all duration-300 ease-[var(--ease-out)] left-2.5 right-2.5 absolute"
        :style="{ top: `${indicator.top}px`, height: `${indicator.height}px`, opacity: indicator.show ? 1 : 0 }"
      />
      <template v-for="(group, gi) in groups" :key="group.id">
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

      <!-- Plugins' pages, each with the plugin's own icon -->
      <template v-if="pluginStore.pages.length">
        <div
          class="text-[10px] tracking-[0.08em] font-semibold mt-3 px-2 whitespace-nowrap uppercase transition-all duration-200 overflow-hidden"
          :class="ui.navExpanded ? 'text-fg-faint h-5 opacity-100' : 'h-0 opacity-0'"
        >
          Plugins
        </div>
        <div v-if="!ui.navExpanded" class="mx-2 my-1.5 divider-y" />
        <button
          v-for="p in pluginStore.pages"
          :key="p.manifest.id"
          v-tip="ui.navExpanded ? undefined : { text: pageTitle(p), placement: 'right' }"
          :data-view="`plugin:${p.manifest.id}`"
          type="button"
          class="group px-2.5 focusable rounded-[var(--radius-md)] flex shrink-0 gap-3 h-10 transition-colors items-center relative z-1"
          :class="current === `plugin:${p.manifest.id}` ? 'text-fg' : 'text-fg-muted hover:text-fg hover:bg-fg/4'"
          :aria-current="current === `plugin:${p.manifest.id}` ? 'page' : undefined"
          @click="ui.openPluginView(p.manifest.id)"
        >
          <span class="center shrink-0 h-5 w-5">
            <span v-if="p.page?.icon" class="plugin-icon text-[18px] transition-transform duration-200 group-active:scale-90" :class="current === `plugin:${p.manifest.id}` ? 'text-accent-300' : ''" v-html="p.page.icon" />
            <span v-else class="i-carbon-application text-[18px] transition-transform duration-200 group-active:scale-90" :class="current === `plugin:${p.manifest.id}` ? 'text-accent-300' : ''" />
          </span>
          <span
            class="text-[13px] font-medium whitespace-nowrap transition-opacity duration-200"
            :class="ui.navExpanded ? 'opacity-100' : 'opacity-0'"
          >{{ pageTitle(p) }}</span>
        </button>
      </template>
    </div>

    <!-- Actions -->
    <div class="px-2.5 py-2.5 border-t border-edge flex shrink-0 flex-col gap-0.5 overflow-x-hidden">
      <button
        v-for="a in [
          { icon: 'i-carbon-search', label: 'Search & commands', kbd: `${MOD_KEY} K`, run: () => (ui.paletteOpen = true) },
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

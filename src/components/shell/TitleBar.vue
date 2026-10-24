<script setup lang="ts">
import type { DesktopWindowState } from '~/lib/browserApi'
import { useEventListener, useWindowFocus } from '@vueuse/core'
import { computed, onBeforeUnmount, ref } from 'vue'
import UiKbd from '~/components/ui/UiKbd.vue'
import { desktop } from '~/lib/browserApi'
import { findView } from '~/lib/views'
import { usePlaybackStore } from '~/stores/playbackStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useUiStore } from '~/stores/uiStore'
import BrandMark from './BrandMark.vue'

/**
 * The desktop app's title bar. The window is frameless (desktop/main.mjs), so
 * this is the only thing to drag it by and the only place its caption buttons
 * live. Never rendered in a browser — the shell mounts it only when the
 * preload hands us window controls.
 *
 * Everything not interactive is an app-region drag area, which Windows treats
 * as a real caption: dragging, Aero Snap, double-click to maximise and the
 * right-click system menu all come from the OS, not from here. The flip side
 * is that drag areas swallow mouse events, so anything clickable or hoverable
 * has to be marked no-drag.
 */

const win = desktop?.window ?? null
const ui = useUiStore()
const player = usePlayerStore()
const playback = usePlaybackStore()

const state = ref<DesktopWindowState>(win?.state() ?? { maximized: false, fullScreen: false })
const off = win?.onStateChange((s) => {
  state.value = s
})
onBeforeUnmount(() => off?.())

// The video player's fullscreen also puts the window into OS fullscreen, but
// track the element too so the bar is gone on the very first frame.
const htmlFullscreen = ref(!!document.fullscreenElement)
useEventListener(document, 'fullscreenchange', () => {
  htmlFullscreen.value = !!document.fullscreenElement
})
const hidden = computed(() => state.value.fullScreen || htmlFullscreen.value)

/** Native title bars dim when the window loses focus; so does this one. */
const focused = useWindowFocus()

const hasTrack = computed(() => !!player.videoUrl)
const title = computed(() => {
  if (playback.currentEntry)
    return playback.currentEntry.basename
  const name = player.videoPath?.split(/[\\/]/).pop() ?? ''
  return name.replace(/\.[^.]+$/, '')
})
const viewDef = computed(() => findView(ui.view))
</script>

<template>
  <header
    v-if="win && !hidden"
    class="titlebar app-drag border-b border-edge bg-surface-900 shrink-0 grid grid-cols-[1fr_auto_1fr] h-[34px] select-none items-center relative z-30"
    :class="{ 'is-blurred': !focused }"
  >
    <!-- Windows resolves a drag region before its resize border, so without
         these the top and left edges of the bar could not be grabbed to
         resize. Maximised windows do not resize, so the bar drags edge to edge. -->
    <template v-if="!state.maximized">
      <span class="app-no-drag h-[5px] left-0 right-0 top-0 absolute" aria-hidden="true" />
      <span class="app-no-drag w-[5px] bottom-0 left-0 top-0 absolute" aria-hidden="true" />
    </template>

    <!-- Brand, lined up over the nav's icon column -->
    <div class="fade-blur pl-[21px] flex gap-2 min-w-0 items-center">
      <BrandMark :size="18" />
      <span class="text-[12.5px] tracking-[-0.02em] font-semibold whitespace-nowrap">play<span class="text-accent-300">hound</span></span>
      <span
        v-if="desktop?.dev"
        class="text-[9.5px] text-warn tracking-[0.08em] font-semibold px-1.5 rounded-[var(--radius-xs)] bg-warn/14 center h-4 uppercase"
      >dev</span>
    </div>

    <!-- Context: what is playing (or which view is open), and search -->
    <div class="fade-blur flex gap-2 min-w-0 items-center justify-center">
      <component
        :is="hasTrack && !ui.onPlayer ? 'button' : 'div'"
        class="text-[12px] px-2 rounded-[var(--radius-sm)] flex gap-2 h-6 min-w-0 items-center"
        :class="hasTrack && !ui.onPlayer ? 'app-no-drag focusable text-fg-muted transition-colors hover:text-fg hover:bg-fg/6' : 'text-fg-muted'"
        v-bind="hasTrack && !ui.onPlayer ? { 'type': 'button', 'aria-label': `Open the player: ${title}` } : {}"
        @click="hasTrack && !ui.onPlayer && ui.openView('player')"
      >
        <template v-if="hasTrack">
          <span class="center shrink-0 h-3.5 w-3.5" aria-hidden="true">
            <span v-if="player.isPlaying" class="flex gap-[2px] h-[11px] items-end">
              <span
                v-for="b in 3"
                :key="b"
                class="rounded-full bg-accent h-full w-[2px] origin-bottom [animation:ph-eq_.9s_ease-in-out_infinite]"
                :style="{ animationDelay: `${b * 0.18}s` }"
              />
            </span>
            <span v-else class="i-carbon-pause-filled text-[11px] text-fg-faint" />
          </span>
          <span class="max-w-[min(38vw,460px)] truncate" :class="player.isPlaying ? 'text-fg' : ''">{{ title }}</span>
        </template>
        <template v-else-if="viewDef">
          <span :class="viewDef.icon" class="text-[13px] text-fg-faint shrink-0" aria-hidden="true" />
          <span class="truncate">{{ viewDef.label }}</span>
        </template>
      </component>

      <button
        type="button"
        class="app-no-drag text-[11.5px] text-fg-faint pl-2 pr-1 focusable border border-edge rounded-full bg-surface-850 flex shrink-0 gap-1.5 h-[22px] transition-colors items-center hover:text-fg-muted hover:border-edge-strong hover:bg-surface-800"
        aria-label="Search and commands"
        @click="ui.paletteOpen = true"
      >
        <span class="i-carbon-search text-[11px]" aria-hidden="true" />
        <span>Search</span>
        <UiKbd class="!text-[10px] !px-1 !h-4 !min-w-4">
          Ctrl K
        </UiKbd>
      </button>
    </div>

    <!-- Caption buttons, in the Windows layout. Out of the tab order like the
         native ones: Alt+F4 and Win+arrows cover the keyboard. -->
    <div class="flex h-full justify-end">
      <button
        v-tip="{ text: 'Minimise', placement: 'bottom' }"
        type="button"
        tabindex="-1"
        class="caption app-no-drag text-fg-muted center h-full w-[46px] transition-colors hover:text-fg active:bg-fg/12 hover:bg-fg/8"
        aria-label="Minimise"
        @click="win?.minimize()"
      >
        <span class="i-carbon-subtract-large text-[14px]" aria-hidden="true" />
      </button>
      <button
        v-tip="{ text: state.maximized ? 'Restore down' : 'Maximise', placement: 'bottom' }"
        type="button"
        tabindex="-1"
        class="caption app-no-drag text-fg-muted center h-full w-[46px] transition-colors hover:text-fg active:bg-fg/12 hover:bg-fg/8"
        :aria-label="state.maximized ? 'Restore down' : 'Maximise'"
        @click="win?.toggleMaximize()"
      >
        <span v-if="state.maximized" class="i-carbon-copy text-[12px] -scale-x-100" aria-hidden="true" />
        <span v-else class="i-carbon-checkbox text-[12.5px]" aria-hidden="true" />
      </button>
      <!-- White on red whatever the theme, as on every Windows close button. -->
      <button
        v-tip="{ text: 'Close', placement: 'bottom' }"
        type="button"
        tabindex="-1"
        class="caption app-no-drag text-fg-muted center h-full w-[46px] transition-colors hover:text-white active:bg-danger/80 hover:bg-danger"
        aria-label="Close"
        @click="win?.close()"
      >
        <span class="i-carbon-close-large text-[14px]" aria-hidden="true" />
      </button>
    </div>
  </header>
</template>

<style scoped>
.app-drag {
  -webkit-app-region: drag;
  app-region: drag;
}

.app-no-drag {
  -webkit-app-region: no-drag;
  app-region: no-drag;
}

/* Like a native caption: content steps back while another window has focus,
   the caption buttons stay as they are. */
.fade-blur {
  transition: opacity var(--dur) var(--ease-out);
}
.is-blurred .fade-blur {
  opacity: 0.55;
}

/* Hover colour arrives quickly and leaves a touch slower, like Windows 11. */
.caption {
  transition-duration: 90ms;
}
.caption:not(:hover) {
  transition-duration: 200ms;
}
</style>

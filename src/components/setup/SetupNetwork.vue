<script setup lang="ts">
import { ref } from 'vue'
import ProxySettings from '~/components/shell/ProxySettings.vue'
import { netProxy } from '~/composables/useNetProxy'

/**
 * The setup's network step: connect directly, as most people do, or through
 * a proxy (Settings → Network's own card). The proxy applies with its Apply
 * button; going back to Direct and on with Next clears it.
 */
const viaProxy = ref(!!netProxy.value.trim())

defineExpose({
  commit() {
    if (!viaProxy.value && netProxy.value.trim())
      netProxy.value = ''
  },
})
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="gap-2.5 grid grid-cols-2" role="radiogroup" aria-label="How to connect">
      <button
        v-for="o in [
          { proxy: false, icon: 'i-carbon-arrow-right', title: 'Directly', sub: 'What most people need' },
          { proxy: true, icon: 'i-carbon-network-3', title: 'Through a proxy', sub: 'When sites are blocked' },
        ]"
        :key="String(o.proxy)"
        type="button"
        role="radio"
        :aria-checked="viaProxy === o.proxy"
        class="p-3 text-left focusable rounded-[var(--radius-lg)] flex gap-2.5 transition-[box-shadow,background-color] duration-200 items-center"
        :class="viaProxy === o.proxy ? 'ring-2 ring-accent bg-accent-soft' : 'ring-1 ring-edge-strong hover:ring-fg/25'"
        @click="viaProxy = o.proxy"
      >
        <span :class="[o.icon, viaProxy === o.proxy ? 'text-accent-300' : 'text-fg-muted']" class="text-[18px] shrink-0" />
        <span class="flex flex-col gap-0.5 min-w-0">
          <span class="text-[13px] text-fg font-medium">{{ o.title }}</span>
          <span class="hint">{{ o.sub }}</span>
        </span>
      </button>
    </div>

    <ProxySettings v-if="viaProxy" />
    <p v-else class="hint m-0">
      If EroScripts or a file host won't load later, Settings → Network takes an HTTP proxy that gets you through.
    </p>
  </div>
</template>

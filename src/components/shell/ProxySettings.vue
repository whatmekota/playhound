<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiInput from '~/components/ui/UiInput.vue'
import { netProxy, netProxyError, netProxyInfo, refreshNetProxy } from '~/composables/useNetProxy'
import { isAndroidApp } from '~/lib/platform'

/**
 * The network proxy: what it is for, the address, and what is used now.
 * Settings → Network and the first-run setup's network step are both this.
 */

// Edited as a draft and applied on Enter or the button, so the server is not
// handed every half-typed address on the way.
const proxyDraft = ref(netProxy.value)
onMounted(() => {
  proxyDraft.value = netProxy.value
  void refreshNetProxy()
})
function applyProxy() {
  netProxy.value = proxyDraft.value.trim()
  proxyDraft.value = netProxy.value
}
const proxyStatus = computed(() => {
  const info = netProxyInfo.value
  if (!info)
    return { tone: 'muted', text: isAndroidApp ? 'The network bridge of the app is not answering.' : 'The local proxy is not running, so there is nothing to apply this to. It runs with the desktop app, start.bat or pnpm dev:proxy.' }
  if (netProxyError.value)
    return { tone: 'danger', text: netProxyError.value }
  if (info.configured)
    return { tone: 'ok', text: `Using ${info.configured}` }
  if (info.env)
    return { tone: 'ok', text: `Using ${info.env}, from HTTPS_PROXY on this computer` }
  return { tone: 'muted', text: 'Connecting directly, no proxy' }
})
</script>

<template>
  <div class="p-4 card flex flex-col gap-3">
    <div class="flex flex-col gap-1">
      <span class="text-[13px] text-fg font-medium">Proxy</span>
      <span v-if="isAndroidApp" class="hint">
        For the EroScripts browser and streaming. Some of these sites are blocked on some networks, and
        an HTTP proxy gets you through (no user name and password). Leave it empty to connect directly.
      </span>
      <span v-else class="hint">
        For the EroScripts browser, streaming and yt-dlp. Some of these sites are blocked on some
        networks, and an HTTP proxy gets you through. Leave it empty to use HTTPS_PROXY from this
        computer, if it has one.
      </span>
    </div>
    <div class="flex gap-2 items-center">
      <UiInput v-model="proxyDraft" class="flex-1" placeholder="http://127.0.0.1:8080" mono clearable @enter="applyProxy" />
      <UiButton variant="primary" :disabled="proxyDraft.trim() === netProxy" @click="applyProxy">
        Apply
      </UiButton>
    </div>
    <p class="text-[12px] flex gap-1.5 items-start" :class="proxyStatus.tone === 'danger' ? 'text-danger' : proxyStatus.tone === 'ok' ? 'text-fg-muted' : 'text-fg-faint'">
      <span class="text-[14px] mt-px shrink-0" :class="proxyStatus.tone === 'danger' ? 'i-carbon-warning-alt' : proxyStatus.tone === 'ok' ? 'i-carbon-checkmark-outline text-ok' : 'i-carbon-information'" />
      {{ proxyStatus.text }}
    </p>
  </div>
</template>

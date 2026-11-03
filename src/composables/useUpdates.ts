import type { UpdateState } from '~/lib/browserApi'
import { computed, ref, watch } from 'vue'
import { desktop } from '~/lib/browserApi'
import { toast } from './useToast'

/**
 * The desktop app's updates (desktop/updater.mjs), for the title bar and
 * Settings → Updates. Null state in a browser, which is always up to date.
 */

const api = desktop?.updates ?? null
const state = ref<UpdateState | null>(api?.state() ?? null)
api?.onState(s => (state.value = s))

let started = false

/** Say so once when an update is ready or out. Once, from the shell. */
export function startUpdates() {
  if (started || !api)
    return
  started = true
  watch(() => [state.value?.status, state.value?.version] as const, ([status, version]) => {
    if (status === 'ready') {
      toast(`playhound ${version} is ready`, {
        detail: 'Installs when you quit, or restart now from the title bar',
        icon: 'i-carbon-renew',
        duration: 8000,
        key: 'update',
      })
    }
    else if (status === 'available') {
      toast(`playhound ${version} is out`, {
        detail: 'Download it from the link in the title bar',
        icon: 'i-carbon-download',
        duration: 8000,
        key: 'update',
      })
    }
  })
}

export function useUpdates() {
  return {
    supported: !!api,
    state,
    /** Something for the title bar to offer: a restart, or a download. */
    offer: computed(() => state.value?.status === 'ready' || state.value?.status === 'available'),
    check: () => api?.check(),
    install: () => api?.install(),
    setAuto: (on: boolean) => api?.setAuto(on),
    download: () => {
      if (state.value?.url)
        window.open(state.value.url, '_blank', 'noopener')
    },
  }
}

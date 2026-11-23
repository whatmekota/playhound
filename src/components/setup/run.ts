import { reactive } from 'vue'

/**
 * What one go through the setup did that the stores don't say, for its
 * summary at the end. Started afresh each time the setup opens.
 */
export const setupRun = reactive({
  /** The kind of device picked, as its card names it; null for none yet. */
  device: null as string | null,
  /** Plugins the setup installed, by name. */
  installed: [] as string[],
})

export function resetSetupRun() {
  setupRun.device = null
  setupRun.installed = []
}

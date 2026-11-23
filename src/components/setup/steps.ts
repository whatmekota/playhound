import type { Component } from 'vue'
import type { StepLike } from '~/lib/setup'
import { netProxy, netProxyInfo } from '~/composables/useNetProxy'
import { usePrivacyLock } from '~/composables/usePrivacyLock'
import { desktop } from '~/lib/browserApi'
import { presetOf } from '~/lib/edging'
import { isAndroidApp } from '~/lib/platform'
import { useMotionStore } from '~/stores/motionStore'
import { useSessionControlStore } from '~/stores/sessionControlStore'
import { setupRun } from './run'
import SetupDevice from './SetupDevice.vue'
import SetupEdges from './SetupEdges.vue'
import SetupNetwork from './SetupNetwork.vue'
import SetupPlugins from './SetupPlugins.vue'
import SetupPrivacy from './SetupPrivacy.vue'
import SetupSpeed from './SetupSpeed.vue'

/**
 * The first-run setup's steps, in order. Each is a component in this folder
 * that the setup shows under the step's title, and each can be skipped.
 *
 * A step component may expose (defineExpose):
 * - `commit()`: what Next does before moving on, e.g. saving a choice kept
 *   as a draft so that Skip leaves the setting as it was. May be async; the
 *   setup waits, with the buttons held. Returning false stays on the step.
 * - `busy`: the step is working on its own; the buttons wait for it.
 * - `primary`: the Next button's own words ("Install 2").
 * - `ready`: false while there is nothing to go on with (no device
 *   connected yet); Skip is then the only way on.
 * and may emit `next` to move on by itself (the device step's "No device yet").
 */
export interface SetupStep extends StepLike {
  id: string
  title: string
  icon: string
  /** One line under the title: what this step is for. */
  lede: string
  component: Component
  /** What it is set to now, for the summary at the end. */
  summary: () => string
}

export const SETUP_STEPS: SetupStep[] = [
  {
    id: 'device',
    title: 'Your device',
    icon: 'i-carbon-plug',
    lede: 'Pick what you have, connect it and try a stroke.',
    component: SetupDevice,
    summary: () => setupRun.device ?? 'None yet',
  },
  {
    id: 'speed',
    title: 'Speed limit',
    icon: 'i-carbon-meter',
    lede: 'The fastest playhound will ever move the device by itself.',
    component: SetupSpeed,
    summary: () => `${useMotionStore().maxSpm} strokes a minute at most`,
  },
  {
    id: 'edges',
    title: 'Edges',
    icon: 'i-carbon-hourglass',
    lede: 'A way to back off when you get close, then build up again.',
    component: SetupEdges,
    summary: () => {
      const s = useSessionControlStore().settings
      return s.enabled ? `On: ${presetOf(s)?.label ?? 'your own'}` : 'Off'
    },
  },
  {
    id: 'network',
    title: 'Network',
    icon: 'i-carbon-network-3',
    lede: 'Only if EroScripts or a file host is blocked where you are.',
    component: SetupNetwork,
    // A proxy only does something where the app fetches for itself: the
    // desktop app, the Android app, or a browser with the local proxy running.
    available: () => !!desktop || isAndroidApp || netProxyInfo.value !== null,
    summary: () => (netProxy.value.trim() ? `Through ${netProxy.value.trim()}` : 'Direct'),
  },
  {
    id: 'privacy',
    title: 'Privacy lock',
    icon: 'i-carbon-locked',
    lede: 'A PIN that opens playhound, so nobody nearby wanders in.',
    component: SetupPrivacy,
    summary: () => (usePrivacyLock().enabled.value ? 'A PIN opens playhound' : 'No lock'),
  },
  {
    id: 'plugins',
    title: 'Plugins',
    icon: 'i-carbon-application',
    lede: 'Official extras, made alongside playhound. Tick the ones you want.',
    component: SetupPlugins,
    summary: () => (setupRun.installed.length ? `Installed ${setupRun.installed.join(', ')}` : 'None installed'),
  },
]

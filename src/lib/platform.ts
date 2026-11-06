import { desktop } from './browserApi'

/**
 * Which keyboard the shortcuts are written for. The handlers already take
 * Ctrl or ⌘ alike (ctrlKey || metaKey); this only changes how they are shown.
 * The desktop app knows its platform; a browser goes by what it reports.
 */
function detectMac(): boolean {
  if (desktop?.platform)
    return desktop.platform === 'darwin'
  if (typeof navigator === 'undefined')
    return false
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  return /mac|iphone|ipad|ipod/i.test(nav.userAgentData?.platform || nav.platform || nav.userAgent || '')
}

export const isMac = detectMac()

/** The modifier key as a keycap: ⌘ on a Mac, Ctrl elsewhere. */
export const MOD_KEY = isMac ? '⌘' : 'Ctrl'

/** "Ctrl + K" → "⌘ + K" on a Mac; unchanged elsewhere. */
export function keyLabel(keys: string): string {
  return isMac ? keys.replace(/\bCtrl\b/g, '⌘') : keys
}

import type { LogoId } from '~/lib/logos'
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { DEFAULT_LOGO, isLogoId, logoUrl } from '~/lib/logos'
import { KEYS } from '~/lib/persist'

export type ThemeId = 'dark' | 'light' | 'catppuccin' | 'dracula'

export interface Theme {
  id: ThemeId
  label: string
}

export const THEMES: Theme[] = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'catppuccin', label: 'Catppuccin' },
  { id: 'dracula', label: 'Dracula' },
]

export const useThemeStore = defineStore('theme', () => {
  const current = ref<ThemeId>((localStorage.getItem(KEYS.theme.key) as ThemeId) ?? 'dark')

  function apply(id: ThemeId) {
    current.value = id
    document.documentElement.setAttribute('data-theme', id)
    localStorage.setItem(KEYS.theme.key, id)
    // Keep the browser chrome (title bar on installed apps, mobile toolbar) and
    // the pre-paint background from index.html in step with the theme.
    try {
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg-base').trim()
      if (bg) {
        document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg)
        document.documentElement.style.backgroundColor = bg
      }
    }
    catch {}
  }

  // Apply on init
  apply(current.value)

  watch(current, apply)

  // ── Logo ────────────────────────────────────────────────────────────────
  // Stored raw (not JSON) so index.html can read it before first paint and
  // point the favicon at the right file without a flash of the default.
  const stored = localStorage.getItem(KEYS.logo.key)
  const logo = ref<LogoId>(isLogoId(stored) ? stored : DEFAULT_LOGO)
  const logoTongue = ref(localStorage.getItem(KEYS.logoTongue.key) === '1')

  function syncFavicon() {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (link)
      link.href = logoUrl(logo.value, logoTongue.value)
  }

  function setLogo(id: LogoId) {
    logo.value = id
    localStorage.setItem(KEYS.logo.key, id)
    syncFavicon()
  }

  function setLogoTongue(on: boolean) {
    logoTongue.value = on
    localStorage.setItem(KEYS.logoTongue.key, on ? '1' : '0')
    syncFavicon()
  }
  syncFavicon()

  return { current, apply, THEMES, logo, setLogo, logoTongue, setLogoTongue }
})

import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
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

  return { current, apply, THEMES }
})

import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

export type ThemeId = 'dark' | 'light' | 'catppuccin' | 'dracula'

export interface Theme {
  id: ThemeId
  label: string
}

export const THEMES: Theme[] = [
  { id: 'dark',       label: 'Dark' },
  { id: 'light',      label: 'Light' },
  { id: 'catppuccin', label: 'Catppuccin' },
  { id: 'dracula',    label: 'Dracula' },
]

export const useThemeStore = defineStore('theme', () => {
  const current = ref<ThemeId>((localStorage.getItem('theme') as ThemeId) ?? 'dark')

  function apply(id: ThemeId) {
    current.value = id
    document.documentElement.setAttribute('data-theme', id)
    localStorage.setItem('theme', id)
  }

  // Apply on init
  apply(current.value)

  watch(current, apply)

  return { current, apply, THEMES }
})

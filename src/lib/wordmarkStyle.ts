import type { LogoId } from '~/lib/logos'
import { computed } from 'vue'
import { useThemeStore } from '~/stores/themeStore'

/**
 * The candy wordmark's colours (src/assets/brand/wordmark.svg reads them as
 * CSS variables), one set per icon colouring in Settings → Appearance, so the
 * splash and the party screen match the mark in the title bar.
 */
export const WORDMARK: Record<LogoId, Record<string, string>> = {
  'sly-grin': { top: '#f7cdfd', mid: '#e05cf5', bot: '#a21caf', rim: '#7e1689', halo: '#fae8ff', icing: '#fdf7ff', icingShade: '#f3cffb', heart: '#ffffff', deco: '#e879f9' },
  'night': { top: '#34303f', mid: '#211d29', bot: '#131117', rim: '#e879f9', halo: '#3a0c45', icing: '#f0a6fb', icingShade: '#c026d3', heart: '#e879f9', deco: '#d946ef' },
  'noir': { top: '#52525b', mid: '#27272a', bot: '#09090b', rim: '#dc2626', halo: '#450a0a', icing: '#f4f4f5', icingShade: '#d4d4d8', heart: '#dc2626', deco: '#ef4444' },
  'crimson': { top: '#ffb4bf', mid: '#f43f5e', bot: '#9f1239', rim: '#6b0a26', halo: '#ffe4e8', icing: '#fff7f8', icingShade: '#ffd0d8', heart: '#ffffff', deco: '#fb7185' },
  'violet': { top: '#ddd6fe', mid: '#8b5cf6', bot: '#4c1d95', rim: '#2e1065', halo: '#ede9fe', icing: '#faf5ff', icingShade: '#ddd6fe', heart: '#ffffff', deco: '#a78bfa' },
  'orange': { top: '#fed7aa', mid: '#f97316', bot: '#be123c', rim: '#881337', halo: '#ffedd5', icing: '#fff7ed', icingShade: '#fed7aa', heart: '#ffffff', deco: '#fdba74' },
  'lime': { top: '#ecfccb', mid: '#a3e635', bot: '#4d7c0f', rim: '#365314', halo: '#f7fee7', icing: '#fefff5', icingShade: '#d9f99d', heart: '#f472b6', deco: '#a3e635' },
}

/** The wordmark's CSS variables for the picked icon colouring. */
export function useWordmarkStyle() {
  const theme = useThemeStore()
  return computed(() => {
    const c = WORDMARK[theme.logo] ?? WORDMARK['sly-grin']
    return {
      '--wm-top': c.top,
      '--wm-mid': c.mid,
      '--wm-bot': c.bot,
      '--wm-rim': c.rim,
      '--wm-halo': c.halo,
      '--wm-icing': c.icing,
      '--wm-icing-shade': c.icingShade,
      '--wm-heart': c.heart,
      '--wm-deco': c.deco,
      '--wm-glow': theme.logo === 'night' || theme.logo === 'noir' ? c.rim : c.mid,
    }
  })
}

import {
  defineConfig,
  presetAttributify,
  presetIcons,
  presetWebFonts,
  presetWind4,
  transformerDirectives,
  transformerVariantGroup,
} from 'unocss'

export default defineConfig({
  shortcuts: [
    ['btn', 'px-4 py-1 rounded inline-block bg-teal-600 text-white cursor-pointer hover:bg-teal-700 disabled:cursor-default disabled:bg-gray-600 disabled:opacity-50'],
    ['icon-btn', 'text-[0.9em] inline-block cursor-pointer select-none opacity-75 transition duration-200 ease-in-out hover:opacity-100 hover:text-teal-600'],
  ],
  theme: {
    colors: {
      // Bound to the CSS custom properties declared in src/styles/main.css so
      // every [data-theme] (dark / light / catppuccin / dracula) reskins these
      // utilities without regenerating any CSS.
      surface: {
        50: 'var(--surface-50)',
        100: 'var(--surface-100)',
        200: 'var(--surface-200)',
        700: 'var(--bg-700)',
        800: 'var(--bg-800)',
        850: 'var(--bg-850)',
        900: 'var(--bg-900)',
        950: 'var(--bg-base)',
      },
      accent: {
        400: 'var(--accent-light)',
        500: 'var(--accent)',
        600: 'var(--accent)',
      },
      fg: {
        DEFAULT: 'var(--text)',
        muted: 'var(--text-muted)',
        faint: 'var(--text-faint)',
      },
      edge: 'var(--border)',
    },
  },
  presets: [
    presetWind4(),
    presetAttributify(),
    presetIcons({
      scale: 1.2,
      warn: true,
    }),
    presetWebFonts({
      fonts: {
        sans: 'DM Sans',
        serif: 'DM Serif Display',
        mono: 'DM Mono',
      },
    }),
  ],
  transformers: [
    // @apply / @screen, used by the component layer in src/styles/main.css
    transformerDirectives(),
    transformerVariantGroup(),
  ],
})

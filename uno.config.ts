import {
  defineConfig,
  presetAttributify,
  presetIcons,
  presetWebFonts,
  presetWind4,
  transformerDirectives,
  transformerVariantGroup,
} from 'unocss'
import { ALL_VIEWS } from './src/lib/views'

export default defineConfig({
  // Menus, registries and toasts name their icons in plain .ts files. Those go
  // through Vite's transform like any module, so letting the extractor see
  // them is enough; without it each such icon needed a safelist entry or a
  // comment in some .vue file to exist at all.
  content: {
    pipeline: {
      include: [
        /\.(?:vue|[jt]sx|html)(?:$|\?)/,
        /src[\\/].*\.ts(?:$|\?)/,
      ],
    },
  },

  // UnoCSS only extracts classes from files in the transform pipeline
  // (.vue/.jsx/.html), so icons named in a plain .ts registry are dropped
  // unless they are safelisted here.
  safelist: [
    ...ALL_VIEWS.map(v => v.icon),
    // Toast and menu icons are passed around as strings from .ts files.
    'i-carbon-checkmark-filled',
    'i-carbon-warning-filled',
    'i-carbon-error-filled',
    'i-carbon-information-filled',
    'i-carbon-play-filled-alt',
    'i-carbon-list-boxes',
    'i-carbon-list',
    'i-carbon-shuffle',
    'i-carbon-repeat',
    'i-carbon-repeat-one',
    'i-carbon-restart',
    'i-carbon-folder',
    'i-carbon-star',
    'i-carbon-star-filled',
    'i-carbon-bookmark',
    'i-carbon-add',
    'i-carbon-trash-can',
  ],

  // The safelist is computed when this config is evaluated, so a registry edit
  // needs the config to be re-read.
  configDeps: ['src/lib/views.ts'],

  theme: {
    colors: {
      // Bound to the CSS custom properties in src/styles/main.css, so every
      // [data-theme] reskins these utilities without regenerating any CSS.
      surface: {
        50: 'var(--surface-50)',
        100: 'var(--surface-100)',
        200: 'var(--surface-200)',
        600: 'var(--bg-600)',
        700: 'var(--bg-700)',
        800: 'var(--bg-800)',
        850: 'var(--bg-850)',
        900: 'var(--bg-900)',
        950: 'var(--bg-base)',
      },
      accent: {
        DEFAULT: 'var(--accent)',
        300: 'var(--accent-light)',
        400: 'var(--accent-light)',
        500: 'var(--accent)',
        600: 'var(--accent-strong)',
        soft: 'var(--accent-soft)',
        contrast: 'var(--accent-contrast)',
      },
      fg: {
        DEFAULT: 'var(--text)',
        muted: 'var(--text-muted)',
        faint: 'var(--text-faint)',
      },
      edge: {
        DEFAULT: 'var(--border)',
        strong: 'var(--border-strong)',
      },
      ok: 'var(--ok)',
      warn: 'var(--warn)',
      danger: 'var(--danger)',
      info: 'var(--info)',
    },
  },

  shortcuts: [
    // ─── Surfaces ───────────────────────────────────────────────────────────
    // A raised card on the panel background.
    ['card', 'rounded-[var(--radius-lg)] border border-edge bg-surface-850'],
    // Slightly lifted inner well, for grouped controls inside a card.
    ['well', 'rounded-[var(--radius-md)] bg-surface-800/70'],
    // Floating layer: popovers, menus, toasts.
    ['pop', 'rounded-[var(--radius-md)] bg-surface-850 shadow-[var(--shadow-pop)]'],
    // Frosted overlay chrome over video.
    ['glass', 'bg-[var(--glass)] backdrop-blur-xl backdrop-saturate-150'],
    ['divider-x', 'w-px h-4 bg-edge-strong shrink-0'],
    ['divider-y', 'h-px w-full bg-edge shrink-0'],

    // ─── Typography ─────────────────────────────────────────────────────────
    ['eyebrow', 'text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-faint'],
    ['label', 'text-[12px] font-medium text-fg-muted'],
    ['hint', 'text-[11.5px] text-fg-faint leading-snug'],
    ['num', 'font-mono tabular-nums'],
    ['h-view', 'text-[19px] font-semibold tracking-[-0.01em] text-fg'],

    // ─── Interaction ────────────────────────────────────────────────────────
    ['focusable', 'outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-0'],
    ['pressable', 'transition-[transform,background-color,color,box-shadow,opacity] duration-150 active:scale-[0.97]'],
    ['hoverable', 'transition-colors duration-150 hover:bg-fg/6'],

    // ─── Animation utilities (keyframes live in main.css) ──────────────────
    ['animate-fade-in', '[animation:ph-fade-in_var(--dur)_var(--ease-out)_both]'],
    ['animate-rise', '[animation:ph-rise_var(--dur-slow)_var(--ease-out)_both]'],
    ['animate-scale-in', '[animation:ph-scale-in_var(--dur)_var(--ease-out)_both]'],
    ['animate-pulse-dot', '[animation:ph-pulse-dot_1.8s_ease-out_infinite]'],

    // ─── Layout helpers ─────────────────────────────────────────────────────
    ['scroll-y', 'min-h-0 overflow-y-auto overscroll-contain'],
    ['center', 'flex items-center justify-center'],
  ],

  presets: [
    presetWind4(),
    presetAttributify(),
    presetIcons({
      scale: 1.2,
      warn: true,
    }),
    presetWebFonts({
      fonts: {
        sans: 'Geist:400,500,600,700',
        mono: 'Geist Mono:400,500',
      },
    }),
  ],

  transformers: [
    transformerDirectives(),
    transformerVariantGroup(),
  ],
})

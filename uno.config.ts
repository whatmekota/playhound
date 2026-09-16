import {
  defineConfig,
  presetAttributify,
  presetIcons,
  presetWebFonts,
  presetWind4,
  transformerDirectives,
  transformerVariantGroup,
} from 'unocss'
import { ALL_PANELS } from './src/lib/panels'

export default defineConfig({
  // UnoCSS only extracts classes from files in the transform pipeline
  // (.vue/.jsx/.html), so anything named in a plain .ts file is dropped — which
  // is how the panel rail lost all thirteen of its icons. content.filesystem
  // does not cover it either, so the registry feeds the safelist directly and
  // stays the single source of truth.
  safelist: ALL_PANELS.flatMap(p => [p.icon, p.accent]),

  // The safelist is computed when this config is evaluated, so editing the
  // registry alone left a stale list in the running dev server and a new
  // panel's icon simply did not exist until a restart.
  configDeps: ['src/lib/panels.ts'],

  theme: {
    colors: {
      // Bound to the CSS custom properties in src/styles/main.css, so every
      // [data-theme] (dark / light / catppuccin / dracula) reskins these
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

  shortcuts: [
    // ─── Buttons ────────────────────────────────────────────────────────────
    // These were previously plain CSS classes composed with @apply, which
    // UnoCSS drops silently (@apply only resolves utilities and shortcuts).
    // As shortcuts they compose properly and stay usable from templates.
    ['btn', 'inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-accent-500/50 disabled:opacity-40 disabled:pointer-events-none'],
    ['btn-primary', 'btn bg-accent-500 text-white hover:brightness-115'],
    ['btn-ghost', 'btn bg-transparent text-fg-muted hover:bg-fg/10 hover:text-fg'],
    ['btn-danger', 'btn bg-red-700 text-white hover:bg-red-600'],
    ['btn-subtle', 'btn bg-fg/5 text-fg-muted hover:bg-fg/10 hover:text-fg'],
    // Square icon-only button, sized to line up with the rail
    ['btn-icon', 'inline-flex items-center justify-center w-7 h-7 rounded-lg text-fg-muted transition-colors outline-none hover:bg-fg/10 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent-500/50 disabled:opacity-40 disabled:pointer-events-none'],

    // ─── Surfaces ───────────────────────────────────────────────────────────
    ['panel', 'rounded-xl border border-edge bg-surface-850'],
    ['card', 'rounded-lg border border-edge bg-surface-800'],
    ['divider-x', 'w-px h-4 bg-fg/10 shrink-0'],
    ['divider-y', 'h-px w-full bg-fg/10 shrink-0'],

    // ─── Typography ─────────────────────────────────────────────────────────
    ['label', 'text-[10px] font-semibold uppercase tracking-wider text-fg-faint'],
    ['hint', 'text-[10px] text-fg-faint leading-snug'],
    ['mono-sm', 'font-mono text-[11px] text-fg-muted'],

    // ─── Form controls ──────────────────────────────────────────────────────
    ['input', 'rounded-lg px-3 py-1.5 text-sm bg-surface-900 border border-edge text-fg outline-none transition-colors focus:border-accent-500 focus-visible:ring-2 focus-visible:ring-accent-500/30'],

    // ─── Panel chrome ───────────────────────────────────────────────────────
    ['panel-header', 'shrink-0 h-8 px-2.5 flex items-center gap-2 border-b border-edge bg-surface-850'],
    ['panel-title', 'text-[11px] font-semibold uppercase tracking-wider text-fg-muted'],
    ['panel-body', 'flex-1 min-h-0 overflow-y-auto'],

    // Focus ring used by non-button interactive elements
    ['focusable', 'outline-none focus-visible:ring-2 focus-visible:ring-accent-500/50'],
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
        sans: 'DM Sans',
        serif: 'DM Serif Display',
        mono: 'DM Mono',
      },
    }),
  ],

  transformers: [
    transformerDirectives(),
    transformerVariantGroup(),
  ],
})

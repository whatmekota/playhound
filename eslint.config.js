import antfu from '@antfu/eslint-config'

export default antfu(
  {
    unocss: true,
    formatters: true,
    pnpm: true,
  },
  {
    rules: {
      // The player half of this codebase uses single-line guards throughout
      // (`if (!x) return`, `clearTimeout(t); t = null`). Splitting ~140 of them
      // would be churn with no readability gain.
      'style/max-statements-per-line': 'off',
    },
  },
  {
    // Dev-only CORS proxy run from a terminal; its logging is the interface.
    files: ['es-proxy.mjs'],
    rules: {
      'no-console': 'off',
    },
  },
)

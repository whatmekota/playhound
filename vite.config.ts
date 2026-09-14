/// <reference types="vitest" />

import path from 'node:path'
import Vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { defineConfig } from 'vitest/config'
import { VueRouterAutoImports } from 'vue-router/unplugin'
import VueRouter from 'vue-router/vite'

export default defineConfig({
  resolve: {
    alias: {
      '~/': `${path.resolve(__dirname, 'src')}/`,
    },
  },

  build: {
    // three (the 180-degree SBS viewer) pushes the vendor chunk past the default warning
    chunkSizeWarningLimit: 10000,
  },

  server: {
    proxy: {
      // EroScripts + Pixeldrain fetches are served by es-proxy.mjs (pnpm dev:proxy)
      '/es-proxy': {
        target: 'http://localhost:7071',
        changeOrigin: true,
        rewrite: p => p.replace(/^\/es-proxy/, ''),
      },
    },
  },

  plugins: [
    // https://github.com/vuejs/router/pull/2603
    VueRouter({
      dts: 'src/typed-router.d.ts',
    }),

    // defineOptions / defineModel / props destructure are all native in Vue 3.5,
    // so the former unplugin-vue-macros wrapper is no longer needed.
    Vue({
      script: {
        propsDestructure: true,
      },
    }),

    // https://github.com/antfu/unplugin-auto-import
    AutoImport({
      imports: [
        'vue',
        '@vueuse/core',
        VueRouterAutoImports,
        {
          'vue-router/auto': ['useLink'],
          'pinia': ['defineStore', 'storeToRefs'],
        },
      ],
      dts: true,
      dirs: [
        './src/composables',
      ],
      vueTemplate: true,
    }),

    // https://github.com/antfu/vite-plugin-components
    Components({
      dts: true,
    }),

    // https://github.com/antfu/unocss
    // see uno.config.ts for config
    UnoCSS(),
  ],

  // https://github.com/vitest-dev/vitest
  test: {
    environment: 'jsdom',
  },
})

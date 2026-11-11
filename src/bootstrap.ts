import { createPinia } from 'pinia'
import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import { routes } from 'vue-router/auto-routes'
import App from './App.vue'
import { vTip } from './directives/tip'
import { devPhoneLayout } from './lib/android/detect'
import { isAndroidApp } from './lib/platform'

export function mount() {
  // Development: the phone layout in a desktop browser (?phone), styled the same.
  if (devPhoneLayout)
    document.documentElement.classList.add('ph-android')
  if (isAndroidApp) {
    // Phone styles (styles/android.css) key off this, from the first paint.
    document.documentElement.classList.add('ph-android')
    // The page's errors, kept for a crash report (Settings → Android app).
    void import('./lib/android/crashReport').then(m => m.installErrorLog())
    // The media server streams library files; start it before the library
    // folders come back, so the first thumbnails need not wait for it.
    void import('./lib/android/folders')
      .then(m => m.ensureMediaServer())
      .catch(err => console.error('[android] media server', err))
  }

  const app = createApp(App)
  const router = createRouter({
    routes,
    history: createWebHistory(import.meta.env.BASE_URL),
  })

  app.use(createPinia())
  app.use(router)
  app.directive('tip', vTip)
  app.mount('#app')
}

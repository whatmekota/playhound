import { createPinia } from 'pinia'
import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import { routes } from 'vue-router/auto-routes'
import App from './App.vue'
import { vTip } from './directives/tip'

export function mount() {
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

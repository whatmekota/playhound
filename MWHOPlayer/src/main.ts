import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './assets/main.css'

const pinia = createPinia()
const isPopOut = window.location.hash === '#popout'
const app = createApp(isPopOut ? PopOutViewer : App)
app.use(pinia)
app.mount('#app')

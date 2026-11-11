import { isAndroidApp } from './lib/android/detect'
import { runMigrations } from './lib/persist'

import './styles/main.css'
// Only under html.ph-android: nothing in it applies in a browser or the desktop app.
import './styles/android.css'
import 'uno.css'

// Storage has to be in its current layout before any store module loads, and
// several read their keys at import time — so the app itself is imported only
// once migrations have run.
runMigrations()
if (isAndroidApp) {
  // Bluetooth and USB serial through native plugins, on navigator before
  // anything that looks for them there is imported.
  void import('./lib/android/shims')
    .then(m => m.installNativeShims())
    .catch(err => console.error('[android] device shims', err))
    .then(() => import('./bootstrap'))
    .then(m => m.mount())
}
else {
  void import('./bootstrap').then(m => m.mount())
}

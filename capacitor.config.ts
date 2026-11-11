import type { CapacitorConfig } from '@capacitor/cli'
import process from 'node:process'

/**
 * The Android app (android/). It loads the built app (`pnpm build` → dist/),
 * or, with CAP_SERVER_URL set when syncing, a dev server on the LAN for live
 * reload: `CAP_SERVER_URL=http://192.168.1.20:7140 pnpm mobile:sync`.
 */
const devServer = process.env.CAP_SERVER_URL

const config: CapacitorConfig = {
  appId: 'io.github.whatmekota.playhound',
  appName: 'playhound',
  webDir: 'dist',
  server: {
    // http://localhost rather than Capacitor's default https: localhost is
    // still a secure context, and an http page may open plain ws:// and
    // http:// links to devices on the LAN (TCode over WebSocket, the media
    // server in the Folders plugin), which an https page may not.
    androidScheme: 'http',
    ...(devServer ? { url: devServer, cleartext: true } : {}),
  },
  // WebView debugging (chrome://inspect) is left to Capacitor's default: on
  // in debug builds, off in release builds (pnpm mobile:release).
}

export default config

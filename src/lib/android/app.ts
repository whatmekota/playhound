import type { PluginListenerHandle } from '@capacitor/core'
import { registerPlugin } from '@capacitor/core'

/**
 * The app itself, through PhApp (android/…/app/AppPlugin.kt): its version
 * and build, Android's share sheet, and installing an update.
 */

export interface AppInfo {
  version: string
  code: number
  /** A debug build: signed with the toolchain's key, so a release build cannot update it. */
  debug: boolean
  sdk: number
}

interface PhAppPlugin {
  info: () => Promise<AppInfo>
  share: (o: { name: string, mime: string, data: string, title?: string }) => Promise<void>
  downloadUpdate: (o: { url: string, name: string, sha256?: string | null }) => Promise<{ path: string, size: number }>
  cancelUpdate: () => Promise<void>
  canInstall: () => Promise<{ allowed: boolean }>
  installUpdate: (o: { path: string }) => Promise<{ started?: boolean, needsPermission?: boolean }>
  addListener: (event: 'updateProgress', cb: (e: { received: number, total: number }) => void) => Promise<PluginListenerHandle>
}

export const PhApp = registerPlugin<PhAppPlugin>('PhApp')

let info: Promise<AppInfo> | null = null

export function appInfo(): Promise<AppInfo> {
  info ??= PhApp.info().catch((err) => {
    info = null
    throw err
  })
  return info
}

/** A Blob as base64, for the bridge (which carries strings). */
export async function base64Of(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** Android's share sheet for a file: post it, send it, save it where the user likes. */
export async function shareFile(blob: Blob, name: string, title = 'Share'): Promise<void> {
  await PhApp.share({ name, mime: blob.type || 'application/octet-stream', data: await base64Of(blob), title })
}

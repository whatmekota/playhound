import { useDeviceStore } from '@/stores/deviceStore'
import { useThemeStore } from '@/stores/themeStore'
import { usePlayerStore } from '@/stores/playerStore'
import { storage } from '@/lib/browserApi'

const GOON_VERSION = 1

export function useSettings() {
  const deviceStore = useDeviceStore()

  function save() {
    storage.set('deviceConfig', deviceStore.serialize())
  }

  function load() {
    const data = storage.get('deviceConfig')
    deviceStore.deserialize(data)
  }

  /** Collect ALL app settings into a single object */
  function exportAll(): object {
    const playerStore = usePlayerStore()
    const themeStore = useThemeStore()
    return {
      _version: GOON_VERSION,
      _app: 'MWHOPlayer',
      _exportedAt: new Date().toISOString(),
      device: deviceStore.serialize(),
      player: {
        volume: playerStore.volume,
        isMuted: playerStore.isMuted,
        playbackSpeed: playerStore.playbackSpeed,
      },
      theme: themeStore.current,
    }
  }

  /** Download settings as a .goon file */
  function downloadGoon() {
    const data = exportAll()
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `mwhoplayer-settings-${new Date().toISOString().slice(0, 10)}.goon`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  /** Import settings from a .goon file (opens file picker) */
  function importGoon(): Promise<void> {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = '.goon,application/json'
      input.onchange = async () => {
        const file = input.files?.[0]
        if (!file) { resolve(); return }
        try {
          const text = await file.text()
          const data = JSON.parse(text)
          if (data._app !== 'MWHOPlayer') throw new Error('Not a MWHOPlayer settings file')

          // Apply all sections
          if (data.device) deviceStore.deserialize(data.device)
          if (data.player) {
            const playerStore = usePlayerStore()
            if (typeof data.player.volume === 'number') playerStore.volume = data.player.volume
            if (typeof data.player.isMuted === 'boolean') playerStore.isMuted = data.player.isMuted
            if (typeof data.player.playbackSpeed === 'number') playerStore.playbackSpeed = data.player.playbackSpeed
          }
          if (data.theme) {
            const themeStore = useThemeStore()
            themeStore.apply(data.theme)
          }

          save()
          resolve()
        } catch (e: any) {
          reject(new Error(e?.message ?? 'Failed to import settings'))
        }
      }
      input.click()
    })
  }

  return { save, load, downloadGoon, importGoon, exportAll }
}

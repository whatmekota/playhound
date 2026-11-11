import type { Ref } from 'vue'
import type { PhoneEmuPlacement } from '~/lib/emuPlacement'
import { useLocalStorage } from '@vueuse/core'
import { effectScope } from 'vue'
import { PHONE_EMU_DEFAULT } from '~/lib/emuPlacement'
import { KEYS } from '~/lib/persist'

let placement: Ref<PhoneEmuPlacement> | null = null

/**
 * The emulator's place on a phone (lib/emuPlacement.ts), shared by the window
 * and the shell, which makes room for it when it is docked. Remembered.
 */
export function useEmulatorPhone(): Ref<PhoneEmuPlacement> {
  placement ??= effectScope(true).run(() =>
    useLocalStorage<PhoneEmuPlacement>(KEYS.emulatorPhone.key, { ...PHONE_EMU_DEFAULT }, { mergeDefaults: true }))!
  return placement
}

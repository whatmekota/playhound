import { computed } from 'vue'
import { useDeviceStore } from '~/stores/deviceStore'
import { useButtplug } from './useButtplug'
import { useHandy } from './useHandy'

/**
 * Whether anything is connected to take the motion: a TCode device (serial,
 * Bluetooth, WebSocket), a toy through Intiface, or a Handy. `device.connected`
 * on its own only covers the first.
 */
export function useAnyDevice() {
  const device = useDeviceStore()
  const bp = useButtplug()
  const handy = useHandy()
  return computed(() => device.connected || bp.connected.value || handy.connected.value)
}

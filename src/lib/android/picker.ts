import { reactive, shallowRef } from 'vue'

/**
 * The Android app's device picker: the sheet that stands in for the
 * browser's Bluetooth and USB choosers (components/shell/AndroidDevices.vue
 * draws it). The Bluetooth and USB shims (ble.ts, serial.ts) open one per
 * requestDevice / requestPort and drive it; the sheet only shows what is in
 * the view and passes taps back.
 */

export interface PickerItem {
  id: string
  name: string
  detail: string
  /** Waiting on Android for this one (a permission dialog, a connection). */
  busy?: boolean
}

export interface PickerView {
  kind: 'bluetooth' | 'usb'
  title: string
  /**
   * - list: the devices found (and still looking, while `scanning`)
   * - ask: an explanation before Android's own dialog, with a button for it
   * - blocked: something to fix first (Bluetooth off, permission refused)
   */
  stage: 'list' | 'ask' | 'blocked'
  /** For ask and blocked. */
  message: string
  /** The main button's label, null for none. */
  action: string | null
  /** A second, quieter button ("Try again"). */
  secondary: string | null
  items: PickerItem[]
  scanning: boolean
  /** Under the list: what to do when nothing shows up. */
  note: string | null
  /** A problem with the last tap, shown in red. */
  error: string | null
}

export interface PickerHandlers {
  choose: (id: string) => void
  action?: () => void
  secondary?: () => void
  rescan?: () => void
  cancel: () => void
}

export interface PickerSession {
  view: PickerView
  on: PickerHandlers
}

/** The sheet showing now, if any. */
export const activePicker = shallowRef<PickerSession | null>(null)

/** Open the sheet. One at a time: a new one cancels the one before. */
export function openPicker(init: Partial<PickerView> & Pick<PickerView, 'kind' | 'title'>, on: PickerHandlers): PickerSession {
  const prev = activePicker.value
  const session: PickerSession = {
    view: reactive<PickerView>({
      stage: 'list',
      message: '',
      action: null,
      secondary: null,
      items: [],
      scanning: false,
      note: null,
      error: null,
      ...init,
    }),
    on,
  }
  activePicker.value = session
  prev?.on.cancel()
  return session
}

/** Close the sheet, if it is still this one's. */
export function closePicker(session: PickerSession) {
  if (activePicker.value === session)
    activePicker.value = null
}

/** Put an item in the list, or update it where it is. */
export function upsertItem(view: PickerView, item: PickerItem) {
  const i = view.items.findIndex(x => x.id === item.id)
  if (i < 0)
    view.items.push(item)
  else if (view.items[i]!.name !== item.name || view.items[i]!.detail !== item.detail)
    view.items[i] = { ...view.items[i], ...item }
}

import { describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'

// The Android app, with the app plugin's Back hand-off faked: `back()` is the phone's button.
const { listeners, setBackHandler } = vi.hoisted(() => ({
  listeners: [] as (() => void)[],
  setBackHandler: vi.fn(async (_o: { on: boolean }) => {}),
}))
vi.mock('~/lib/android/detect', () => ({ isAndroidApp: true, devPhoneLayout: false }))
vi.mock('~/lib/android/app', () => ({
  PhApp: {
    setBackHandler,
    addListener: vi.fn(async (_event: string, cb: () => void) => {
      listeners.push(cb)
      return { remove: async () => {} }
    }),
  },
}))

const { useAndroidBack } = await import('../src/lib/android/back')
const back = () => listeners.forEach(cb => cb())

describe('the phone\'s Back', () => {
  it('closes the last thing opened, then the one under it, then leaves Back to the app', async () => {
    const panel = ref(false)
    const dialog = ref(false)
    const scope = effectScope()
    scope.run(() => {
      useAndroidBack(() => panel.value, () => (panel.value = false))
      useAndroidBack(() => dialog.value, () => (dialog.value = false))
    })
    expect(setBackHandler).not.toHaveBeenCalled()
    panel.value = true
    await nextTick()
    dialog.value = true
    await nextTick()
    expect(setBackHandler).toHaveBeenLastCalledWith({ on: true })

    back()
    await nextTick()
    expect(dialog.value).toBe(false)
    expect(panel.value).toBe(true)
    back()
    await nextTick()
    expect(panel.value).toBe(false)
    expect(setBackHandler).toHaveBeenLastCalledWith({ on: false })
    scope.stop()
  })

  it('gives Back up when the component goes away while still open', () => {
    setBackHandler.mockClear()
    const open = ref(true)
    const scope = effectScope()
    scope.run(() => useAndroidBack(() => open.value, () => (open.value = false)))
    expect(setBackHandler).toHaveBeenLastCalledWith({ on: true })
    scope.stop()
    expect(setBackHandler).toHaveBeenLastCalledWith({ on: false })
    expect(open.value).toBe(true)
  })
})

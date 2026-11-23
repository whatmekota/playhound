import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'
import { startPrivacyLock } from '~/composables/usePrivacyLock'
import { KEYS } from '~/lib/persist'
import { awayLongEnough, hashPin, relockDelayMs, verifyPin } from '~/lib/privacyLock'
import { usePrivacyStore } from '~/stores/privacyStore'
import { useSafetyStore } from '~/stores/safetyStore'

// A low count keeps the tests quick; the real one is in each record anyway.
const FAST = 1000

describe('the PIN', () => {
  it('is kept as a salted hash, never the digits, and known again', async () => {
    const rec = await hashPin('482915', FAST)
    expect(JSON.stringify(rec)).not.toContain('482915')
    expect(rec).toMatchObject({ v: 1, iterations: FAST, digits: 6 })
    expect(await verifyPin('482915', rec)).toBe(true)
    expect(await verifyPin('482916', rec)).toBe(false)
    expect((await hashPin('482915', FAST)).salt).not.toBe(rec.salt)
  })

  it('is 4 to 8 digits and nothing else', async () => {
    for (const bad of ['123', '123456789', '12a4', ''])
      await expect(hashPin(bad, FAST)).rejects.toThrow()
  })
})

describe('locking again after time away', () => {
  it('locks at once, or after the minutes chosen; a picker of the app\'s own gets a minute', () => {
    expect(relockDelayMs(0)).toBe(0)
    expect(relockDelayMs(5)).toBe(300_000)
    expect(relockDelayMs(0, true)).toBe(60_000)
    expect(awayLongEnough(0, 59_999, 1)).toBe(false)
    expect(awayLongEnough(0, 60_000, 1)).toBe(true)
  })

  describe('in the shell', () => {
    let hidden = false
    const setHidden = (h: boolean) => {
      hidden = h
      document.dispatchEvent(new Event('visibilitychange'))
    }

    beforeEach(async () => {
      localStorage.clear()
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
      hidden = false
      localStorage.setItem(KEYS.privacyPin.key, JSON.stringify(await hashPin('2580', FAST)))
      localStorage.setItem(KEYS.privacyRelock.key, '1')
      setActivePinia(createPinia())
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    })
    afterEach(() => vi.useRealTimers())

    /** Starts locked; unlocked here, with panic standing in for the real one. */
    async function start() {
      const safety = useSafetyStore()
      const panic = vi.fn(() => (safety.panicked = true))
      const release = vi.fn(() => (safety.panicked = false))
      effectScope().run(() => startPrivacyLock({ panic, release }))
      const privacy = usePrivacyStore()
      expect(privacy.locked).toBe(true)
      expect(await privacy.unlock('2580')).toBe('ok')
      expect(release).toHaveBeenCalledOnce()
      panic.mockClear()
      return { privacy, panic }
    }

    it('locks, through panic, after the chosen time out of sight and not before', async () => {
      const { privacy, panic } = await start()
      setHidden(true)
      vi.advanceTimersByTime(59_000)
      expect(privacy.locked).toBe(false)
      vi.advanceTimersByTime(1_000)
      expect(privacy.locked).toBe(true)
      expect(panic).toHaveBeenCalledOnce()
    })

    it('checks the time again on coming back, for a phone that slept through the timer', async () => {
      const { privacy } = await start()
      setHidden(true)
      vi.setSystemTime(Date.now() + 5 * 60_000)
      setHidden(false)
      await nextTick()
      expect(privacy.locked).toBe(true)
    })
  })
})

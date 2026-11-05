import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { CEILING_MAX, CEILING_MAX_UNLOCKED, useMotionStore } from '../src/stores/motionStore'

describe('speed ceiling unlock', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('tops out at the normal maximum until unlocked', () => {
    const m = useMotionStore()
    expect(m.ceilingUnlocked).toBe(false)
    expect(m.ceilingTop).toBe(CEILING_MAX)
    m.ceilingUnlocked = true
    expect(m.ceilingTop).toBe(CEILING_MAX_UNLOCKED)
  })

  it('pulls the ceiling back inside the normal range when locked again', async () => {
    const m = useMotionStore()
    m.ceilingUnlocked = true
    m.maxSpm = 360
    m.ceilingUnlocked = false
    await nextTick()
    expect(m.maxSpm).toBe(CEILING_MAX)
  })

  it('never loads a ceiling past what is unlocked', () => {
    const m = useMotionStore()
    m.deserialize({ maxSpm: 380 })
    expect(m.maxSpm).toBe(CEILING_MAX)
    m.deserialize({ maxSpm: 380, ceilingUnlocked: true })
    expect(m.maxSpm).toBe(380)
    m.deserialize({ maxSpm: 900, ceilingUnlocked: true })
    expect(m.maxSpm).toBe(CEILING_MAX_UNLOCKED)
  })

  it('saves the unlock with the rest', () => {
    const m = useMotionStore()
    m.ceilingUnlocked = true
    expect(m.serialize().ceilingUnlocked).toBe(true)
  })
})

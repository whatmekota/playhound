import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { usePlayerStore } from '~/stores/playerStore'

describe('player VR view', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('opens for a VR video and closes for a flat one by itself', () => {
    const p = usePlayerStore()
    p.setVideo('scene_180_LR.mp4', 'blob:a')
    expect(p.sbs180).toBe(true)
    p.setVideo('flat.mp4', 'blob:b')
    expect(p.sbs180).toBe(false)
    p.setVideo('flat.mp4', 'blob:b')
    p.applyVr(true)
    expect(p.sbs180).toBe(true)
  })

  it('remembers what the user set for each video', () => {
    const p = usePlayerStore()
    p.setVideo('scene_180_LR.mp4', 'blob:a')
    p.sbs180 = false
    p.setVideo('flat.mp4', 'blob:b')
    p.sbs180 = true
    p.vrEye = 'right'
    p.setVideo('scene_180_LR.mp4', 'blob:a')
    expect(p.sbs180).toBe(false)
    p.vrEye = 'left'
    p.setVideo('flat.mp4', 'blob:b')
    expect(p.sbs180).toBe(true)
    expect(p.vrEye).toBe('right')
  })

  it('leaves the view alone with auto off', () => {
    const p = usePlayerStore()
    p.vrAuto = false
    p.setVideo('scene_180_LR.mp4', 'blob:a')
    expect(p.sbs180).toBe(false)
  })
})

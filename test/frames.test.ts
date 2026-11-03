import { afterEach, describe, expect, it, vi } from 'vitest'
import { cancelFrame, requestFrame, setFrameSource } from '~/lib/frames'

/** A window whose frames run only when told to. */
function fakeWindow() {
  let seq = 0
  const queued = new Map<number, () => void>()
  return {
    closed: false,
    requestAnimationFrame: (cb: () => void) => {
      queued.set(++seq, cb)
      return seq
    },
    cancelAnimationFrame: (id: number) => void queued.delete(id),
    paint() {
      const cbs = [...queued.values()]
      queued.clear()
      for (const cb of cbs)
        cb()
    },
    get pending() {
      return queued.size
    },
  }
}

describe('requestFrame', () => {
  afterEach(() => {
    setFrameSource(null)
    vi.restoreAllMocks()
  })

  function mainWindow() {
    const main = fakeWindow()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(main.requestAnimationFrame as any)
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(main.cancelAnimationFrame)
    return main
  }

  it('runs on the main window alone when nothing is popped out', () => {
    const main = mainWindow()
    const cb = vi.fn()
    requestFrame(cb)
    main.paint()
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('runs once, on whichever window paints first', () => {
    const main = mainWindow()
    const pop = fakeWindow()
    setFrameSource(pop as unknown as Window)
    const cb = vi.fn()
    requestFrame(cb)
    pop.paint()
    expect(cb).toHaveBeenCalledTimes(1)
    // The main window's request was withdrawn.
    expect(main.pending).toBe(0)
    main.paint()
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('keeps going on the pop-out while the main window does not paint', () => {
    mainWindow()
    const pop = fakeWindow()
    setFrameSource(pop as unknown as Window)
    let n = 0
    const loop = () => {
      n++
      requestFrame(loop)
    }
    requestFrame(loop)
    for (let i = 0; i < 5; i++)
      pop.paint()
    expect(n).toBe(5)
  })

  it('skips a closed pop-out and cancels on both windows', () => {
    const main = mainWindow()
    const pop = fakeWindow()
    pop.closed = true
    setFrameSource(pop as unknown as Window)
    const cb = vi.fn()
    const id = requestFrame(cb)
    expect(pop.pending).toBe(0)
    cancelFrame(id)
    main.paint()
    expect(cb).not.toHaveBeenCalled()
  })
})

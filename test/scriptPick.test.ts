import { afterEach, describe, expect, it, vi } from 'vitest'
import { openScriptFiles, scriptInputAccept, splitPickedScripts } from '../src/lib/browserApi'

describe('picking scripts by hand', () => {
  it('filters by .funscript on desktop, not on Android', () => {
    expect(scriptInputAccept('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/140.0')).toEqual(['.funscript'])
    expect(scriptInputAccept('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/140.0 Mobile Safari/537.36')).toEqual([])
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('does not use the typed picker on Android, which greys .funscript files out', () => {
    const typed = vi.fn(async () => [])
    vi.stubGlobal('showOpenFilePicker', typed)
    const ua = vi.spyOn(navigator, 'userAgent', 'get')
    ua.mockReturnValue('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/140.0 Mobile Safari/537.36')
    void openScriptFiles()
    expect(typed).not.toHaveBeenCalled()
    ua.mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0')
    void openScriptFiles()
    expect(typed).toHaveBeenCalledTimes(1)
  })

  it('keeps funscripts and refuses the rest', () => {
    const picked = [{ name: 'a.funscript' }, { name: 'b.roll.FUNSCRIPT' }, { name: 'c.mp4' }, { name: 'funscript.txt' }]
    const { scripts, refused } = splitPickedScripts(picked)
    expect(scripts.map(f => f.name)).toEqual(['a.funscript', 'b.roll.FUNSCRIPT'])
    expect(refused.map(f => f.name)).toEqual(['c.mp4', 'funscript.txt'])
  })
})

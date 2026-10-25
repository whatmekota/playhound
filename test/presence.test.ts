import { describe, expect, it } from 'vitest'
import { buildActivity, DEFAULT_PRESENCE, isClientId, renderTemplate } from '../src/lib/presence'

const on = { ...DEFAULT_PRESENCE, enabled: true, clientId: '123456789012345678' }
const times = { sessionStart: 1_000, videoStart: 5_000 }

describe('renderTemplate', () => {
  it('fills placeholders', () => {
    expect(renderTemplate('{{title}} · {{spm}} spm', { title: 'Clip', spm: 71.4 })).toBe('Clip · 71 spm')
  })

  it('drops a chunk whose placeholder has nothing to say, separator and all', () => {
    expect(renderTemplate('{{spm}} spm · {{bpm}} bpm', { spm: 71 })).toBe('71 spm')
    expect(renderTemplate('{{spm}} spm · {{bpm}} bpm', { bpm: 141 })).toBe('141 bpm')
    expect(renderTemplate('{{title}} | {{chapter}} | {{edges}} edges', { title: 'A', edges: 2 })).toBe('A | 2 edges')
  })

  it('keeps plain text and tidies whitespace', () => {
    expect(renderTemplate('  Vibing   to  {{bpm}} bpm ', { bpm: 128 })).toBe('Vibing to 128 bpm')
    expect(renderTemplate('Just chilling', {})).toBe('Just chilling')
  })

  it('treats zero as nothing for numbers', () => {
    expect(renderTemplate('{{edges}} edges', { edges: 0 })).toBe('')
  })

  it('caps the length at Discord\'s 128', () => {
    expect(renderTemplate('{{title}}', { title: 'x'.repeat(300) }).length).toBe(128)
  })

  it('ignores unknown placeholders by dropping their chunk', () => {
    expect(renderTemplate('{{nope}} · fine', {})).toBe('fine')
  })
})

describe('buildActivity', () => {
  it('is null while off, or without an application id', () => {
    expect(buildActivity(DEFAULT_PRESENCE, {}, times)).toBeNull()
    expect(buildActivity({ ...on, clientId: '' }, {}, times)).toBeNull()
  })

  it('minimal mode says nothing about what is playing', () => {
    const a = buildActivity(on, { title: 'Secret', spm: 80, state: 'Playing' }, times)!
    expect(a.details).toBeUndefined()
    expect(a.state).toBeUndefined()
    expect(JSON.stringify(a)).not.toContain('Secret')
    expect(a.startTimestamp).toBe(1_000)
    expect(a.largeImageKey).toBe('logo')
  })

  it('custom mode renders both lines', () => {
    const a = buildActivity({ ...on, mode: 'custom', details: '{{title}}', state: '{{spm}} spm' }, { title: 'Clip', spm: 70 }, times)!
    expect(a.details).toBe('Clip')
    expect(a.state).toBe('70 spm')
  })

  it('leaves out lines Discord would reject', () => {
    const a = buildActivity({ ...on, mode: 'custom', details: '{{title}}', state: 'x' }, {}, times)!
    expect(a.details).toBeUndefined()
    expect(a.state).toBeUndefined()
  })

  it('times the video when asked, and nothing when paused', () => {
    expect(buildActivity({ ...on, timer: 'video' }, {}, times)!.startTimestamp).toBe(5_000)
    expect(buildActivity({ ...on, timer: 'video' }, {}, { ...times, videoStart: null })!.startTimestamp).toBeUndefined()
    expect(buildActivity({ ...on, timer: 'none' }, {}, times)!.startTimestamp).toBeUndefined()
  })

  it('can hide itself while idle', () => {
    expect(buildActivity({ ...on, hideWhenIdle: true }, { state: 'Idle' }, times)).toBeNull()
    expect(buildActivity({ ...on, hideWhenIdle: true }, { state: 'Playing' }, times)).not.toBeNull()
  })
})

describe('isClientId', () => {
  it('accepts snowflakes only', () => {
    expect(isClientId('123456789012345678')).toBe(true)
    expect(isClientId('abc')).toBe(false)
    expect(isClientId('12345')).toBe(false)
  })
})

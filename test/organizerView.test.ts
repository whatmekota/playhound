import type { FsEntry } from '../src/lib/fsWalk'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import OrganizerView from '../src/components/views/OrganizerView.vue'
import { buildPairs, useOrganizerStore } from '../src/stores/organizerStore'

function entry(relPath: string, modified = 0): FsEntry {
  const i = relPath.lastIndexOf('/')
  const name = relPath.slice(i + 1)
  return { name, relPath, dirRelPath: i < 0 ? '' : relPath.slice(0, i), dirHandle: {} as any, fileHandle: {} as any, file: new File(['x'], name, { lastModified: modified }) }
}

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  // jsdom has no layout, so no ResizeObserver; the segmented control measures with one.
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as any
})

function setup() {
  const organizer = useOrganizerStore()
  organizer.rootHandle = { name: 'Videos' } as any
  organizer.rootName = 'Videos'
  organizer.writable = true
  organizer.pairs = buildPairs([
    entry('Old clip.mp4', 1000),
    entry('Old clip.funscript', 1000),
    entry('Newer clip.mp4', 9000),
    entry('Alice video.mp4', 5000),
    entry('alice script.funscript', 5000),
  ])
  return mount(OrganizerView, { attachTo: document.body, global: { directives: { tip: {} } } })
}

describe('organizer view', () => {
  it('keeps every character typed into the rename box', async () => {
    const w = setup()
    const name = w.findAll('span').find(s => s.text() === 'Old clip')!
    await name.trigger('dblclick')
    const input = w.get<HTMLInputElement>('input[aria-label="New name"]')
    expect(document.activeElement).toBe(input.element)
    // Type the way a person does: one character at a time, each a render.
    let typed = ''
    for (const ch of 'Fresh name') {
      typed += ch
      input.element.value = typed
      await input.trigger('input')
      await nextTick()
      // The box must not select everything again after each key.
      expect(input.element.selectionStart).toBe(input.element.selectionEnd)
    }
    await input.trigger('keydown', { key: 'Enter' })
    expect(w.text()).toContain('Fresh name')
    expect(w.text()).toContain('1 rename planned')
    w.unmount()
  })

  it('sorts newest first as one list', async () => {
    const w = setup()
    await w.get('select').setValue('Newest first')
    const order = ['Newer clip', 'Alice video', 'Old clip'].map(n => w.text().indexOf(n))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    w.unmount()
  })
})

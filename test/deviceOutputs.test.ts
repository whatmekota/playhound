import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import EstimSection from '~/components/device/EstimSection.vue'
import TcodeNetLink from '~/components/device/TcodeNetLink.vue'
import { useEstim } from '~/composables/useEstim'
import { KEYS } from '~/lib/persist'
import { useSafetyStore } from '~/stores/safetyStore'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as any
})

const opts = { attachTo: document.body, global: { directives: { tip: {} } } }

/** The section starts closed; open it like a click on its header would. */
async function openSection() {
  const w = mount(EstimSection, opts)
  await w.find('header').trigger('click')
  await nextTick()
  return w
}

describe('e-stim audio section', () => {
  it('says what it is and how to stay safe', async () => {
    const w = await openSection()
    const text = w.text()
    expect(text).toContain('Experimental')
    expect(text).toContain('tell us how it works with your box')
    expect(text).toContain('18+')
    expect(text).toMatch(/Never above the waist/)
    expect(text).toMatch(/Start low/)
    w.unmount()
  })

  it('starts off, and Start does nothing without an output', async () => {
    const w = await openSection()
    const estim = useEstim()
    expect(estim.armed.value).toBe(false)
    expect(estim.running.value).toBe(false)
    const start = w.findAll('button').find(b => b.text() === 'Start')!
    expect(start.attributes('disabled')).toBeDefined()
    expect(await estim.start()).toBe(false)
    expect(estim.armed.value).toBe(false)
    w.unmount()
  })

  it('refuses to start while panicked', async () => {
    const estim = useEstim()
    useSafetyStore().panicked = true
    expect(await estim.start()).toBe(false)
    expect(estim.error.value).toMatch(/Panic/)
    expect(estim.armed.value).toBe(false)
  })

  it('remembers the volume, never whether it was on', async () => {
    const estim = useEstim()
    estim.setCeiling(0.4)
    estim.setVolume(0.3)
    await nextTick()
    const saved = JSON.parse(localStorage.getItem(KEYS.estim.key) ?? '{}')
    expect(saved.volume).toBeCloseTo(0.3)
    expect(saved.ceiling).toBeCloseTo(0.4)
    expect(Object.keys(saved)).not.toContain('armed')
    // The volume can't be set above the limit.
    estim.setVolume(0.9)
    expect(estim.settings.value.volume).toBeCloseTo(0.4)
    estim.setCeiling(0.2)
    expect(estim.settings.value.volume).toBeCloseTo(0.2)
  })
})

describe('tCode network link', () => {
  it('offers the presets and fills in their address', async () => {
    const w = mount(TcodeNetLink, opts)
    const select = w.find('select')
    const labels = select.findAll('option').map(o => o.text())
    expect(labels).toEqual(['ESP32 OSR (UDP)', 'ESP32 OSR (WebSocket)', 'restim (WebSocket)', 'restim (UDP)', 'Custom'])
    // No desktop app here: UDP presets are there but can't be picked.
    expect(select.findAll('option')[0].attributes('disabled')).toBeDefined()
    select.element.selectedIndex = 2
    await select.trigger('change')
    await nextTick()
    expect((w.find('input').element as HTMLInputElement).value).toBe('ws://localhost:12346/tcode')
    w.unmount()
  })
})

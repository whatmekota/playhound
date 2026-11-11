import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalUuid, lookingFor, matchesRequest, signalWords } from '~/lib/android/bleMatch'
import { intifaceUrl, phoneIntifaceField } from '~/lib/android/intiface'
import { activePicker, closePicker, openPicker, upsertItem } from '~/lib/android/picker'
import { fromBase64, toBase64, usbLabel } from '~/lib/android/serial'
import { androidMajor, mediaTitle, sessionSummary } from '~/lib/android/session'
import { cancelFrame, requestFrame, setFrameTimer } from '~/lib/frames'

const HANDY = '77834d26-40f7-11ee-be56-0242ac120002'
const HR = '0000180d-0000-1000-8000-00805f9b34fb'

describe('canonicalUuid', () => {
  it('reads what Web Bluetooth accepts', () => {
    expect(canonicalUuid('heart_rate')).toBe(HR)
    expect(canonicalUuid('heart_rate_measurement')).toBe('00002a37-0000-1000-8000-00805f9b34fb')
    expect(canonicalUuid(0x180D)).toBe(HR)
    expect(canonicalUuid('180d')).toBe(HR)
    expect(canonicalUuid('0x180D')).toBe(HR)
    expect(canonicalUuid(HANDY.toUpperCase())).toBe(HANDY)
    expect(() => canonicalUuid('not-a-uuid')).toThrow(TypeError)
  })
})

describe('matchesRequest', () => {
  // What lib/handyBle.ts asks for.
  const handy = { filters: [{ services: [HANDY] }, { namePrefix: 'OHD_' }], optionalServices: [HANDY] }

  it('lets a device through on any one filter', () => {
    expect(matchesRequest({ name: 'OHD_hw4_1234' }, handy)).toBe(true)
    expect(matchesRequest({ name: 'Something', uuids: [HANDY] }, handy)).toBe(true)
    expect(matchesRequest({ name: 'Polar H10', uuids: [HR] }, handy)).toBe(false)
    expect(matchesRequest({}, handy)).toBe(false)
  })

  it('needs every service a filter names, and its name too', () => {
    const opts = { filters: [{ services: ['heart_rate', 'battery_service'], namePrefix: 'Polar' }] }
    expect(matchesRequest({ name: 'Polar H10', uuids: [HR, canonicalUuid('battery_service')] }, opts)).toBe(true)
    expect(matchesRequest({ name: 'Polar H10', uuids: [HR] }, opts)).toBe(false)
    expect(matchesRequest({ name: 'Garmin', uuids: [HR, canonicalUuid('battery_service')] }, opts)).toBe(false)
  })

  it('takes everything with acceptAllDevices, nothing with an empty filter', () => {
    expect(matchesRequest({}, { acceptAllDevices: true })).toBe(true)
    expect(matchesRequest({ name: 'x' }, { filters: [{}] })).toBe(false)
  })
})

describe('lookingFor', () => {
  it('names the picker after what is wanted', () => {
    expect(lookingFor({ filters: [{ services: [HANDY] }, { namePrefix: 'OHD_' }] }).title).toBe('Choose your Handy')
    expect(lookingFor({ filters: [{ services: ['heart_rate'] }] }).title).toBe('Choose a heart-rate monitor')
    expect(lookingFor({ acceptAllDevices: true }).title).toBe('Choose a Bluetooth device')
  })

  it('puts the signal in words', () => {
    expect(signalWords(-50)).toBe('Strong signal')
    expect(signalWords(-90)).toMatch(/closer/)
    expect(signalWords(undefined)).toBe('')
  })
})

describe('sessionSummary', () => {
  const idle = { mediaPlaying: false, mediaName: null, otherPlaying: false, connected: [], network: false }

  it('runs while anything is connected or playing, and not otherwise', () => {
    expect(sessionSummary(idle).active).toBe(false)
    expect(sessionSummary({ ...idle, mediaName: 'clip' }).active).toBe(false)
    expect(sessionSummary({ ...idle, connected: ['OSR (USB)'] })).toMatchObject({ active: true, playing: false })
    expect(sessionSummary({ ...idle, otherPlaying: true })).toMatchObject({ active: true, playing: true })
  })

  it('says what plays and what is connected', () => {
    const s = sessionSummary({ ...idle, mediaPlaying: true, mediaName: 'clip', connected: ['Handy (WiFi)', 'Intiface'], network: true })
    expect(s).toEqual({ active: true, playing: true, network: true, title: 'clip', text: 'Playing · Handy (WiFi), Intiface' })
    expect(sessionSummary({ ...idle, mediaName: 'clip', connected: ['OSR (USB)'] }).text).toBe('Paused · OSR (USB)')
    expect(sessionSummary({ ...idle, mediaPlaying: true }).text).toBe('Playing · No device connected')
  })

  it('holds the Wi-Fi lock only while active', () => {
    expect(sessionSummary({ ...idle, network: true }).network).toBe(false)
  })

  it('reads names and versions', () => {
    expect(mediaTitle('Videos/sub/My clip.mp4')).toBe('My clip')
    expect(mediaTitle('C:\\v\\a.b.mkv')).toBe('a.b')
    expect(mediaTitle(null)).toBeNull()
    expect(androidMajor('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/131')).toBe(14)
    expect(androidMajor('Mozilla/5.0 (Windows NT 10.0)')).toBe(0)
  })
})

describe('intifaceUrl', () => {
  it('fills in the scheme and the port', () => {
    expect(intifaceUrl('192.168.1.20')).toEqual({ url: 'ws://192.168.1.20:12345', problem: null })
    expect(intifaceUrl(' pc.local:12000 ').url).toBe('ws://pc.local:12000')
    expect(intifaceUrl('ws://192.168.1.20:12345').url).toBe('ws://192.168.1.20:12345')
    expect(intifaceUrl('http://10.0.0.5').url).toBe('ws://10.0.0.5:12345')
  })

  it('says why an address will not do on a phone', () => {
    expect(intifaceUrl('').problem).toMatch(/address of the PC/)
    expect(intifaceUrl('ws://localhost:12345').problem).toMatch(/phone itself/)
    expect(intifaceUrl('127.0.0.1').problem).toMatch(/phone itself/)
    expect(intifaceUrl('ftp://pc').problem).toMatch(/ws:\/\//)
  })

  it('reads the desktop default as an empty field', () => {
    expect(phoneIntifaceField('ws://localhost:12345')).toBe('')
    expect(phoneIntifaceField('ws://192.168.1.20:12345')).toBe('ws://192.168.1.20:12345')
  })
})

describe('usb', () => {
  it('round-trips bytes through base64', () => {
    const bytes = new TextEncoder().encode('L05000I600\nR05000I600\n')
    expect(Array.from(fromBase64(toBase64(bytes)))).toEqual(Array.from(bytes))
  })

  it('labels a device from what Android says about it', () => {
    expect(usbLabel({ product: 'CP2102 USB to UART', manufacturer: 'Silicon Labs', driver: 'CP210x', vendorId: 0x10C4, productId: 0xEA60 }))
      .toEqual({ name: 'CP2102 USB to UART', detail: 'Silicon Labs · CP210x · 10c4:ea60' })
    expect(usbLabel({ driver: 'CH34x', vendorId: 0x1A86, productId: 0x7523 }).name).toBe('CH34x serial device')
  })
})

describe('picker', () => {
  it('keeps one sheet open, cancelling the one before', () => {
    const cancelA = vi.fn()
    const a = openPicker({ kind: 'usb', title: 'A' }, { choose: () => {}, cancel: cancelA })
    const b = openPicker({ kind: 'bluetooth', title: 'B' }, { choose: () => {}, cancel: () => {} })
    expect(cancelA).toHaveBeenCalledOnce()
    expect(activePicker.value).toBe(b)
    closePicker(a)
    expect(activePicker.value).toBe(b)
    upsertItem(b.view, { id: '1', name: 'x', detail: '' })
    upsertItem(b.view, { id: '1', name: 'y', detail: '' })
    expect(b.view.items).toEqual([{ id: '1', name: 'y', detail: '' }])
    closePicker(b)
    expect(activePicker.value).toBeNull()
  })
})

describe('frames by timer', () => {
  afterEach(() => {
    setFrameTimer(null)
    vi.useRealTimers()
  })

  it('also runs a frame from a timer when asked, once', () => {
    vi.useFakeTimers()
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1)
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
    const cb = vi.fn()
    requestFrame(cb)
    vi.advanceTimersByTime(100)
    expect(cb).not.toHaveBeenCalled()

    setFrameTimer(30)
    requestFrame(cb)
    vi.advanceTimersByTime(31)
    expect(cb).toHaveBeenCalledOnce()

    const id = requestFrame(cb)
    cancelFrame(id)
    vi.advanceTimersByTime(100)
    expect(cb).toHaveBeenCalledOnce()
    raf.mockRestore()
  })
})

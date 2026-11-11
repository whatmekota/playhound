/**
 * The pure half of the Android app's Web Bluetooth (android/ble.ts): UUIDs
 * the way Web Bluetooth names them, which scanned devices a requestDevice
 * filter lets through, and what the picker is called.
 */

const BASE = '-0000-1000-8000-00805f9b34fb'

/** The GATT names the app uses, and a few common ones (Web Bluetooth's own list is longer). */
const NAMES: Record<string, number> = {
  generic_access: 0x1800,
  device_information: 0x180A,
  battery_service: 0x180F,
  heart_rate: 0x180D,
  heart_rate_measurement: 0x2A37,
  body_sensor_location: 0x2A38,
  heart_rate_control_point: 0x2A39,
  battery_level: 0x2A19,
  manufacturer_name_string: 0x2A29,
  model_number_string: 0x2A24,
  firmware_revision_string: 0x2A26,
}

/**
 * A full lowercase 128-bit UUID, as the native plugin wants it, from what
 * Web Bluetooth accepts: a number (0x180D), a GATT name ('heart_rate'), a
 * 16- or 32-bit hex string, or a 128-bit one in any case.
 */
export function canonicalUuid(u: string | number): string {
  if (typeof u === 'number')
    return `${(u >>> 0).toString(16).padStart(8, '0')}${BASE}`
  const s = u.trim().toLowerCase()
  if (s in NAMES)
    return canonicalUuid(NAMES[s]!)
  if (/^(?:0x)?[0-9a-f]{4}$|^(?:0x)?[0-9a-f]{8}$/.test(s))
    return canonicalUuid(Number.parseInt(s.replace(/^0x/, ''), 16))
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s))
    return s
  throw new TypeError(`Not a Bluetooth UUID or GATT name: ${u}`)
}

/** What a scan reports about a device, as far as filtering goes. */
export interface ScannedDevice {
  name?: string
  /** Advertised service UUIDs, canonical. */
  uuids?: string[]
}

export interface ScanFilter {
  services?: (string | number)[]
  name?: string
  namePrefix?: string
}

export interface RequestOptions {
  filters?: ScanFilter[]
  acceptAllDevices?: boolean
  optionalServices?: (string | number)[]
}

/** Web Bluetooth's rule: any one filter matches, and a filter matches when all it asks for is there. */
export function matchesRequest(d: ScannedDevice, opts: RequestOptions): boolean {
  if (opts.acceptAllDevices)
    return true
  const uuids = new Set((d.uuids ?? []).map(u => u.toLowerCase()))
  return (opts.filters ?? []).some((f) => {
    if (f.name !== undefined && d.name !== f.name)
      return false
    if (f.namePrefix !== undefined && !(d.name ?? '').startsWith(f.namePrefix))
      return false
    for (const s of f.services ?? []) {
      if (!uuids.has(canonicalUuid(s)))
        return false
    }
    // A filter that asks for nothing matches nothing (Web Bluetooth rejects one outright).
    return f.name !== undefined || f.namePrefix !== undefined || (f.services?.length ?? 0) > 0
  })
}

const HANDY_SERVICE = '77834d26-40f7-11ee-be56-0242ac120002'

/** What the device being looked for is, from what the page asks for. */
export function lookingFor(opts: RequestOptions): { title: string, thing: string } {
  const filters = opts.filters ?? []
  const services = new Set(filters.flatMap(f => (f.services ?? []).map(s => canonicalUuid(s))))
  if (services.has(HANDY_SERVICE) || filters.some(f => f.namePrefix === 'OHD_'))
    return { title: 'Choose your Handy', thing: 'your Handy' }
  if (services.has(canonicalUuid('heart_rate')))
    return { title: 'Choose a heart-rate monitor', thing: 'your heart-rate monitor' }
  return { title: 'Choose a Bluetooth device', thing: 'your device' }
}

/** A signal strength in words, for the picker. */
export function signalWords(rssi: number | undefined): string {
  if (rssi === undefined || rssi === 127)
    return ''
  if (rssi >= -60)
    return 'Strong signal'
  if (rssi >= -80)
    return 'Good signal'
  return 'Weak signal: bring it closer'
}

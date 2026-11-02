import { onUnmounted, ref } from 'vue'
import { webSerial } from '~/lib/browserApi'
import { useDeviceStore } from '~/stores/deviceStore'

// ── Singleton port state — shared across all callers ─────────────────────────
let port: SerialPort | null = null
let writer: WritableStreamDefaultWriter<Uint8Array> | null = null
let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
let readLoopActive = false
let readLoopId = 0
const connecting = ref(false)

export function useSerialPort() {
  const store = useDeviceStore()

  async function requestAndConnect(baudRate = 115200) {
    if (!webSerial.supported) {
      store.connectionError = 'Web Serial API not supported in this browser. Use Chrome/Edge.'
      return
    }
    connecting.value = true
    store.connectionError = null
    try {
      const selectedPort = await webSerial.requestPort()
      if (!selectedPort)
        return
      await connect(selectedPort, baudRate)
    }
    finally {
      connecting.value = false
    }
  }

  async function connect(selectedPort: SerialPort, baudRate = 115200) {
    try {
      await disconnect()
      await selectedPort.open({ baudRate })
      port = selectedPort
      writer = port.writable!.getWriter()
      store.connected = true
      store.baudRate = baudRate
      store.portPath = 'Web Serial Port'
      store.connectionError = null
      startReadLoop()
    }
    catch (e: any) {
      store.connectionError = e.message
    }
  }

  async function disconnect() {
    readLoopActive = false
    readLoopId++
    const r = reader
    reader = null
    if (r) {
      try { await r.cancel() }
      catch {}
      try { r.releaseLock() }
      catch {}
    }
    try { writer?.releaseLock() }
    catch {}
    writer = null
    const p = port
    port = null
    try {
      await p?.close()
    }
    catch (e: any) {
      console.warn('Serial close failed:', e?.message)
    }
    store.connected = false
  }

  async function write(data: string) {
    if (!writer)
      return
    store.lastCommand = data.trim()
    try {
      await writer.write(new TextEncoder().encode(data))
    }
    catch (e: any) {
      // Only hard-disconnect on fatal errors, not transient buffer issues
      const msg: string = e?.message ?? ''
      if (msg.includes('disconnected') || msg.includes('closed') || msg.includes('device lost')) {
        store.connectionError = msg
        store.connected = false
      }
      // Otherwise silently swallow — let the next write try again
    }
  }

  function startReadLoop() {
    if (!port?.readable)
      return
    readLoopActive = true
    const id = ++readLoopId
    const r = port.readable.getReader()
    reader = r
    ;(async () => {
      try {
        // eslint-disable-next-line no-unmodified-loop-condition -- cleared by disconnect()
        while (readLoopActive) {
          const { done } = await r.read()
          if (done)
            break
        }
      }
      catch { /* port closed */ }
      finally {
        if (reader === r)
          reader = null
        try { r.releaseLock() }
        catch {}
        if (id === readLoopId)
          store.connected = false
      }
    })()
  }

  onUnmounted(() => {
    // Don't auto-disconnect — keep connection across component remounts
  })

  return { requestAndConnect, disconnect, write, connecting }
}

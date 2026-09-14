import { ref, onUnmounted, onMounted } from 'vue'
import { useDeviceStore } from '~/stores/deviceStore'
import { webSerial } from '~/lib/browserApi'

// ── Singleton port state — shared across all callers ─────────────────────────
let port: SerialPort | null = null
let writer: WritableStreamDefaultWriter<Uint8Array> | null = null
let readLoopActive = false
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
      if (!selectedPort) return
      await connect(selectedPort, baudRate)
    } finally {
      connecting.value = false
    }
  }

  async function connect(selectedPort: SerialPort, baudRate = 115200) {
    try {
      await selectedPort.open({ baudRate })
      port = selectedPort
      writer = port.writable!.getWriter()
      store.connected = true
      store.baudRate = baudRate
      store.portPath = 'Web Serial Port'
      store.connectionError = null
      startReadLoop()
    } catch (e: any) {
      store.connectionError = e.message
    }
  }

  async function disconnect() {
    readLoopActive = false
    try { writer?.releaseLock() } catch {}
    try { await port?.close() } catch {}
    writer = null
    port = null
    store.connected = false
  }

  async function write(data: string) {
    if (!writer) return
    store.lastCommand = data.trim()
    try {
      await writer.write(new TextEncoder().encode(data))
    } catch (e: any) {
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
    if (!port?.readable) return
    readLoopActive = true
    const reader = port.readable.getReader()
    ;(async () => {
      try {
        while (readLoopActive) {
          const { done } = await reader.read()
          if (done) break
        }
      } catch { /* port closed */ } finally {
        reader.releaseLock()
        store.connected = false
      }
    })()
  }

  onUnmounted(() => {
    // Don't auto-disconnect — keep connection across component remounts
  })

  return { requestAndConnect, disconnect, write, connecting }
}

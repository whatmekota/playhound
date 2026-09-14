<script setup lang="ts">
import { ref, onUnmounted, watch, nextTick } from 'vue'
import { setEmuInstance } from '@/composables/useTCode'

let OSREmulator: any = null
let emuInst: any = null  // local alias — also registered in useTCode via setEmuInstance

const containerRef = ref<HTMLDivElement | null>(null)
const widgetRef = ref<HTMLDivElement | null>(null)
const ready = ref(false)
const error = ref<string | null>(null)

const props = defineProps<{ model?: 'OSR2' | 'SR6'; visible?: boolean }>()
const emit = defineEmits<{ 'update:model': [v: 'OSR2' | 'SR6'] }>()

// ─── Position & size ─────────────────────────────────────────────────────────
const pos = ref({ x: 16, y: 64 })
const size = ref({ w: 240, h: 260 })
const MIN = 160

// ─── Drag ────────────────────────────────────────────────────────────────────
let dragStart: { mx: number; my: number; x: number; y: number } | null = null
function onDragDown(e: MouseEvent) {
  e.preventDefault()
  dragStart = { mx: e.clientX, my: e.clientY, x: pos.value.x, y: pos.value.y }
  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('mouseup', onDragUp)
}
function onDragMove(e: MouseEvent) {
  if (!dragStart) return
  pos.value = { x: Math.max(0, dragStart.x + e.clientX - dragStart.mx), y: Math.max(0, dragStart.y + e.clientY - dragStart.my) }
}
function onDragUp() { dragStart = null; window.removeEventListener('mousemove', onDragMove); window.removeEventListener('mouseup', onDragUp) }

// ─── Resize ──────────────────────────────────────────────────────────────────
let resizeStart: { mx: number; my: number; w: number; h: number } | null = null
function onResizeDown(e: MouseEvent) {
  e.preventDefault(); e.stopPropagation()
  resizeStart = { mx: e.clientX, my: e.clientY, w: size.value.w, h: size.value.h }
  window.addEventListener('mousemove', onResizeMove)
  window.addEventListener('mouseup', onResizeUp)
}
function onResizeMove(e: MouseEvent) {
  if (!resizeStart) return
  size.value = { w: Math.max(MIN, resizeStart.w + e.clientX - resizeStart.mx), h: Math.max(MIN, resizeStart.h + e.clientY - resizeStart.my) }
}
function onResizeUp() { resizeStart = null; window.removeEventListener('mousemove', onResizeMove); window.removeEventListener('mouseup', onResizeUp) }

const pendingWrites: string[] = []

// ─── Emulator init ───────────────────────────────────────────────────────────
async function init() {
  if (emuInst) { emuInst.destroy(); emuInst = null; setEmuInstance(null); ready.value = false }
  try {
    if (!OSREmulator) { const mod = await import('osr-emu'); OSREmulator = mod.OSREmulator }

    // Wait until container has real dimensions (v-show may have just removed display:none)
    let attempts = 0
    while (attempts < 40) {
      if (containerRef.value && containerRef.value.clientWidth > 0) break
      await new Promise(r => setTimeout(r, 50))
      attempts++
    }
    if (!containerRef.value || containerRef.value.clientWidth === 0) {
      error.value = 'Container not ready'; return
    }

    emuInst = new OSREmulator(containerRef.value, { model: props.model ?? 'OSR2' })
    // *** Register the raw instance directly in useTCode — no Vue proxy indirection ***
    setEmuInstance(emuInst)
    ready.value = true
    // Flush any writes queued before init (shouldn't happen now, but safety net)
    for (const cmd of pendingWrites) emuInst.write(cmd)
    pendingWrites.length = 0
  } catch (e: any) { error.value = e.message }
}

watch(() => props.model, () => { if (emuInst) init() })

let initialized = false
watch(() => props.visible, async (v) => {
  if (v && !initialized) {
    initialized = true
    await nextTick()
    await init()
  } else if (emuInst) {
    try { v ? emuInst.resume?.() : emuInst.pause?.() } catch {}
  }
}, { immediate: true })

function write(tcodeStr: string) {
  if (emuInst) emuInst.write(tcodeStr)
  else pendingWrites.push(tcodeStr)
}
onUnmounted(() => {
  setEmuInstance(null)
  emuInst?.destroy(); emuInst = null
  window.removeEventListener('mousemove', onDragMove); window.removeEventListener('mouseup', onDragUp)
  window.removeEventListener('mousemove', onResizeMove); window.removeEventListener('mouseup', onResizeUp)
})
defineExpose({ write })
</script>

<template>
  <div
    ref="widgetRef"
    class="fixed z-50 flex flex-col rounded-xl overflow-hidden shadow-2xl border border-white/10"
    :style="{ left: pos.x+'px', top: pos.y+'px', width: size.w+'px', height: size.h+'px', background: 'var(--bg-900)', borderColor: 'var(--border)' }"
  >
    <!-- Header: drag handle + model picker -->
    <div
      class="flex items-center justify-between px-2.5 py-1.5 border-b shrink-0 cursor-move select-none"
      style="background:var(--bg-850); border-color:var(--border)"
      @mousedown="onDragDown"
    >
      <span class="text-[10px] font-medium tracking-wider uppercase" style="color:var(--text-faint)">OSR Emu</span>
      <!-- Model toggle — stop propagation so clicks don't start drag -->
      <div class="flex items-center gap-0.5" @mousedown.stop>
        <button
          class="text-[10px] px-1.5 py-0.5 rounded font-mono transition-colors"
          :style="(props.model ?? 'OSR2') === 'OSR2' ? 'background:var(--accent);color:#fff' : 'color:var(--text-faint)'"
          @click="emit('update:model', 'OSR2')"
        >OSR2</button>
        <button
          class="text-[10px] px-1.5 py-0.5 rounded font-mono transition-colors"
          :style="props.model === 'SR6' ? 'background:var(--accent);color:#fff' : 'color:var(--text-faint)'"
          @click="emit('update:model', 'SR6')"
        >SR6</button>
      </div>
    </div>

    <!-- 3D canvas -->
    <div class="flex-1 relative overflow-hidden">
      <div ref="containerRef" class="w-full h-full" />
      <div v-if="error" class="absolute inset-0 flex items-center justify-center text-[10px] text-red-400 px-2 text-center">{{ error }}</div>
      <div v-if="!ready && !error" class="absolute inset-0 flex items-center justify-center text-[10px]" style="color:var(--text-faint)">Loading…</div>
    </div>

    <!-- Resize handle -->
    <div class="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize select-none opacity-40 hover:opacity-80" @mousedown="onResizeDown">
      <svg viewBox="0 0 16 16" fill="currentColor" :style="{ color: 'var(--text-muted)' }">
        <path d="M11 10l-1 1H6l5-5v4zm3 3l-1 1h-2l3-3v2z"/>
      </svg>
    </div>
  </div>
</template>

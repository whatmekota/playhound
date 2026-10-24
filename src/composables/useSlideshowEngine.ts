import type { TransitionName } from '~/stores/slideshow'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useBinauralBeats } from '~/composables/useBinauralBeats'
import { useLFO } from '~/composables/useLFO'
import { useSessionEngine } from '~/composables/useSessionEngine'
import { useAudioStore } from '~/stores/audio'
import { useSlideshowStore } from '~/stores/slideshow'

export type AdvanceMode = 'timer' | 'beat' | 'pulse'

// Phase → auto-transition map
export const PHASE_TRANSITIONS: Record<string, TransitionName> = {
  idle: 'fade',
  entry: 'slide',
  build: 'zoom',
  peak: 'rotate',
  descent: 'blur',
}

/**
 * The slideshow's clock: when to advance, which way to transition, and how far
 * through the current slide we are.
 *
 * Three ways to advance: a plain timer (with ±20% variance so it does not feel
 * mechanical), every N beats of the binaural beat frequency, or locked to the
 * shared session pulse so slides land on the same beat as the audio and the
 * device. Only the view that shows the slideshow runs this.
 */
export function useSlideshowEngine() {
  const { items, settings, isPlaying, currentIndex } = useSlideshowStore()
  const audioStore = useAudioStore()
  const lfo = useLFO()
  const session = useSessionEngine()
  const { getPulseClock } = useBinauralBeats()

  const currentItem = computed(() => items[currentIndex.value])

  // ─── Advance mode ───────────────────────────────────────────────────────────
  // Stored as two flags (pulse wins over beat) for backwards compatibility.
  const mode = computed<AdvanceMode>({
    get: () => settings.value.pulseSync ? 'pulse' : settings.value.beatSync ? 'beat' : 'timer',
    set: (m) => {
      settings.value.pulseSync = m === 'pulse'
      settings.value.beatSync = m === 'beat'
    },
  })

  /** Seconds a beat-synced slide lasts at the current beat frequency. */
  const beatSlideSeconds = computed(() =>
    (settings.value.beatsPerSlide ?? 8) / Math.max(0.25, audioStore.beatDelta.value),
  )

  // ─── Progress through the current slide (0..1) ──────────────────────────────
  const progress = ref(0)
  /** False while pulse sync waits for an audio clock that is not running. */
  const pulseAvailable = ref(true)

  let timer: ReturnType<typeof setTimeout> | null = null
  let slideStartedAt = 0
  let slideDurationMs = 0
  /** Time left on the current slide when paused, so resume does not restart it. */
  let pausedRemaining: number | null = null

  // Pulse-locked advance: counts cycles of the shared session pulse so slides
  // land on the same beat the audio and the device are on, rather than merely
  // at a similar rate.
  let lastPulsePhase = 0
  let pulsesSeen = 0

  let raf: number | null = null

  function getSlideDelay(): number {
    if (settings.value.beatSync)
      return beatSlideSeconds.value * 1000
    const base = (currentItem.value?.duration ?? settings.value.delay) * 1000
    return session.variantDelay(base, 0.2)
  }

  function frame() {
    raf = null
    if (!isPlaying.value)
      return
    if (settings.value.pulseSync) {
      const c = getPulseClock()
      pulseAvailable.value = !!c
      if (c) {
        // A wrap back past the start of the cycle is one completed pulse.
        if (c.phase < lastPulsePhase)
          pulsesSeen++
        lastPulsePhase = c.phase
        const per = Math.max(1, settings.value.pulsesPerSlide)
        if (pulsesSeen >= per) {
          pulsesSeen = 0
          advance()
        }
        progress.value = Math.min(1, (pulsesSeen + c.phase) / per)
      }
    }
    else if (slideDurationMs > 0) {
      progress.value = Math.min(1, (performance.now() - slideStartedAt) / slideDurationMs)
    }
    raf = requestAnimationFrame(frame)
  }

  function startFrames() {
    if (raf === null)
      raf = requestAnimationFrame(frame)
  }

  function clearScheduled() {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (raf !== null) {
      cancelAnimationFrame(raf)
      raf = null
    }
  }

  function scheduleNext() {
    clearScheduled()
    if (items.length === 0 || !isPlaying.value)
      return

    // Pulse sync drives advances from the audio clock, not a timer.
    if (settings.value.pulseSync) {
      pulsesSeen = 0
      lastPulsePhase = getPulseClock()?.phase ?? 0
      pausedRemaining = null
      startFrames()
      return
    }

    pulseAvailable.value = true
    const full = getSlideDelay()
    const wait = pausedRemaining !== null ? Math.min(pausedRemaining, full) : full
    pausedRemaining = null
    slideDurationMs = full
    slideStartedAt = performance.now() - (full - wait)
    timer = setTimeout(() => {
      timer = null
      advance()
      if (isPlaying.value)
        scheduleNext()
    }, wait)
    startFrames()
  }

  // ─── Transitions ────────────────────────────────────────────────────────────
  // Refreshed on each advance when randomTransition is on.
  const randomPickedTransition = ref<TransitionName>('fade')

  function pickRandom(): TransitionName {
    const pool = settings.value.transitionPool ?? []
    if (!pool.length)
      return 'fade'
    return pool[Math.floor(Math.random() * pool.length)]
  }

  /** The transition the next slide change will use ('none' for a cut). */
  const activeTransition = computed<TransitionName>(() => {
    if (settings.value.randomTransition)
      return randomPickedTransition.value
    if (settings.value.autoTransition && audioStore.phase.value !== 'idle')
      return PHASE_TRANSITIONS[audioStore.phase.value] ?? settings.value.transition
    return settings.value.transition
  })

  /** Vue <Transition> name; empty means a hard cut. */
  const transitionName = computed(() => activeTransition.value === 'none' ? '' : activeTransition.value)

  function toggleTransitionPool(t: TransitionName) {
    const pool = settings.value.transitionPool ?? (settings.value.transitionPool = [])
    const idx = pool.indexOf(t)
    if (idx >= 0) {
      if (pool.length > 1)
        pool.splice(idx, 1)
    }
    else {
      pool.push(t)
    }
  }

  // ─── Navigation ─────────────────────────────────────────────────────────────
  function onSlideChanged() {
    pausedRemaining = null
    progress.value = 0
    session.emit('slideChange', { index: currentIndex.value, total: items.length })
  }

  function advance() {
    if (items.length === 0)
      return

    // Pick the random transition before changing slide so it is ready.
    if (settings.value.randomTransition)
      randomPickedTransition.value = pickRandom()

    if (settings.value.shuffle) {
      let next = currentIndex.value
      if (items.length > 1) {
        while (next === currentIndex.value)
          next = Math.floor(Math.random() * items.length)
      }
      currentIndex.value = next
    }
    else {
      const next = currentIndex.value + 1
      if (next >= items.length) {
        if (!settings.value.loop) {
          isPlaying.value = false
          return
        }
        currentIndex.value = 0
      }
      else {
        currentIndex.value = next
      }
    }
    onSlideChanged()
  }

  function prev() {
    if (items.length === 0)
      return
    if (settings.value.randomTransition)
      randomPickedTransition.value = pickRandom()
    if (currentIndex.value > 0)
      currentIndex.value--
    else if (settings.value.loop)
      currentIndex.value = items.length - 1
    onSlideChanged()
    if (isPlaying.value)
      scheduleNext()
  }

  function next() {
    advance()
    if (isPlaying.value)
      scheduleNext()
  }

  function goTo(i: number) {
    if (i < 0 || i >= items.length || i === currentIndex.value)
      return
    currentIndex.value = i
    onSlideChanged()
    if (isPlaying.value)
      scheduleNext()
  }

  function togglePlay() {
    if (!items.length)
      return
    isPlaying.value = !isPlaying.value
  }

  // ─── Wiring ─────────────────────────────────────────────────────────────────
  function start() {
    lfo.start()
    scheduleNext()
  }

  function stop() {
    if (timer !== null && slideDurationMs > 0)
      pausedRemaining = Math.max(0, slideDurationMs - (performance.now() - slideStartedAt))
    clearScheduled()
    lfo.stop()
  }

  watch(isPlaying, p => p ? start() : stop())

  // Sync LFO speed to beat frequency; beat-synced slides re-time with it.
  watch(() => audioStore.beatDelta.value, (delta) => {
    lfo.syncToFreq(delta)
    if (settings.value.beatSync && isPlaying.value) {
      pausedRemaining = null
      scheduleNext()
    }
  })

  // Switching advance mode, or its rate, has to rebuild the schedule.
  watch(() => [settings.value.pulseSync, settings.value.beatSync, settings.value.pulsesPerSlide, settings.value.beatsPerSlide], () => {
    pausedRemaining = null
    progress.value = 0
    if (isPlaying.value)
      scheduleNext()
  })

  // Auto-transition follows the session phase.
  watch(() => audioStore.phase.value, (ph) => {
    if (settings.value.autoTransition)
      settings.value.transition = PHASE_TRANSITIONS[ph] ?? 'fade'
  })

  // Nothing left to show.
  watch(() => items.length, (n) => {
    if (n === 0) {
      isPlaying.value = false
      progress.value = 0
    }
  })

  onMounted(() => {
    randomPickedTransition.value = pickRandom()
    lfo.syncToFreq(audioStore.beatDelta.value)
    // The store outlives the view: if it was playing when we left, carry on.
    if (isPlaying.value && items.length)
      start()
  })

  onBeforeUnmount(() => {
    clearScheduled()
    lfo.stop()
  })

  return {
    currentItem,
    mode,
    beatSlideSeconds,
    progress,
    pulseAvailable,
    activeTransition,
    transitionName,
    toggleTransitionPool,
    prev,
    next,
    goTo,
    togglePlay,
    lfo,
  }
}

# Session Engine Feature Expansion Spec

This document defines incremental features for an existing Vue 3 + Tone.js audiovisual session app with:

- binaural tone generator (carrier + beat)
- noise layer (ambient)
- slideshow with basic transitions (slide/zoom + fixed delay)

Goal: evolve system into a **dynamic, time-driven generative audiovisual engine** without architectural rewrite.

---

## 1. Audio Enhancements

### 1.1 Beat Drift

- Allow continuous or staged modulation of beat frequency
- Support:
  - linear ramps (e.g. 12Hz → 6Hz over time)
  - micro-random drift (±0.2–1Hz)

### 1.2 Multi-layer Tone

- Optional harmonic stack:
  - base: 1 oscillator pair
  - harmonics: +1/+2 octaves with reduced gain
- Maintain same beat delta across layers

### 1.3 Noise Morphing

- Crossfade between noise types:
  - brown → pink → white
- Modulate filter cutoff slowly over time

---

## 2. Session Intelligence

### 2.1 Timeline Variance

- Replace fixed delays with:
  - base duration ± variance (e.g. ±15–25%)
- Prevent rigid synchronization patterns

### 2.2 Phase-based Behavior

Introduce session phases:

- entry
- build
- peak
- descent

Each phase can modify:

- beat range
- noise level
- visual intensity

### 2.3 Controlled Randomness

- bounded randomness for:
  - slide order
  - timing offsets
  - parameter drift

---

## 3. Visual System Upgrades

### 3.1 Audio-reactive visuals

Link visuals to audio state:

- brightness ↔ noise volume
- zoom speed ↔ beat frequency
- transition rate ↔ session intensity

### 3.2 LFO-driven animation

- use slow oscillators (0.05–0.2Hz)
- drive:
  - opacity breathing
  - slow zoom
  - subtle pan shifts

### 3.3 Multi-layer composition

- background layer (static / slow drift)
- foreground slideshow
- optional overlay effects (blur, fade, vignette)

---

## 4. Ambient Layer System

### 4.1 Adaptive Ambient Mixing

Map session phase → ambient set:

- entry → rain / soft wind
- build → fireplace / light rain
- peak → storm / heavy rain / thunder
- descent → wind / silence

### 4.2 Smooth Crossfades

- never hard switch ambient sources
- use 2–5s crossfade minimum

---

## 5. Event System (Lightweight)

Add event hooks:

- onSlideChange
- onPhaseChange
- onBeatChange
- onIntensityChange

Allow optional scripted triggers:

- “after N minutes → increase drift”
- “on peak phase → reduce brightness”

---

## 6. Drift Mode (Optional)

Enable generative session mode:

- slow autonomous parameter evolution
- no fixed slideshow order
- periodic re-randomization of:
  - beat
  - noise mix
  - slide sequence

Constraints:

- keep changes smooth (no abrupt jumps)
- maintain overall session structure (entry → peak → exit)

---

## 7. UX Enhancements

### 7.1 Master Intensity Control

Single control affecting:

- beat range
- noise volume
- visual brightness
- transition speed

### 7.2 Preset Morphing

- allow blending between presets over time
- no instant switching

### 7.3 Live Override

- manual changes must:
  - not break timeline
  - fade into new values instead of snapping

---

## Design Principle

System must feel:

- continuous
- evolving
- non-repetitive
- lightly stochastic but controlled

Avoid:

- rigid loops
- abrupt parameter jumps
- deterministic repetition

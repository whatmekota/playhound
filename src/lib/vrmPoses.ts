/**
 * VRM solo pose presets — dual-keyframe system.
 * bonesBottom = skeleton at L0=0 (deepest stroke)
 * bonesTop    = skeleton at L0=1 (highest stroke)
 * The viewer lerps every bone between them based on smoothed L0.
 * Bones not listed in a keyframe default to rotation 0,0,0.
 */

export interface BoneKF {
  rx?: number
  ry?: number
  rz?: number
  px?: number
  py?: number
  pz?: number
}

export type PoseKeyframe = Partial<Record<string, BoneKF>>

export interface VrmPose {
  id: string
  label: string
  emoji: string
  description: string
  cameraLookAtY: number
  cameraRadius: number
  /** Full skeleton at L0 = 0 (bottom of stroke) */
  bonesBottom: PoseKeyframe
  /** Full skeleton at L0 = 1 (top of stroke) */
  bonesTop: PoseKeyframe
}

// ─── Helper for mirrored symmetric poses ─────────────────────────────────────
const S = Math.PI / 2   // 90°
const Q = Math.PI / 4   // 45°
const E = Math.PI / 8   // 22.5°
const T = Math.PI / 12  // 15°

export const VRM_POSES: VrmPose[] = [

  // ── Cowgirl ───────────────────────────────────────────────────────────────
  // Straddle squat, facing forward. L0=0: deepest squat. L0=1: risen up.
  {
    id: 'cowgirl',
    label: 'Cowgirl',
    emoji: '🤠',
    description: 'Straddle squat, facing forward',
    cameraLookAtY: 0.85,
    cameraRadius: 1.8,
    bonesBottom: {
      hips:          { py: -0.10 },
      spine:         { rx:  0.35 },
      chest:         { rx:  0.18 },
      upperChest:    { rx:  0.08 },
      neck:          { rx: -0.10 },
      // Thighs spread wide and bent deep
      leftUpperLeg:  { rx:  1.45, rz: -0.55 },
      rightUpperLeg: { rx:  1.45, rz:  0.55 },
      // Knees very bent — shins fold back
      leftLowerLeg:  { rx: -1.80 },
      rightLowerLeg: { rx: -1.80 },
      leftFoot:      { rx:  0.55 },
      rightFoot:     { rx:  0.55 },
      // Arms forward, hands on partner/thighs
      leftUpperArm:  { rx:  0.50, rz:  0.60 },
      rightUpperArm: { rx:  0.50, rz: -0.60 },
      leftLowerArm:  { rx:  0.90 },
      rightLowerArm: { rx:  0.90 },
    },
    bonesTop: {
      hips:          { py:  0.12 },
      spine:         { rx:  0.12 },
      chest:         { rx:  0.06 },
      upperChest:    { rx:  0.02 },
      neck:          { rx: -0.05 },
      // Legs partially straighten as she rises
      leftUpperLeg:  { rx:  0.85, rz: -0.45 },
      rightUpperLeg: { rx:  0.85, rz:  0.45 },
      leftLowerLeg:  { rx: -1.00 },
      rightLowerLeg: { rx: -1.00 },
      leftFoot:      { rx:  0.20 },
      rightFoot:     { rx:  0.20 },
      leftUpperArm:  { rx:  0.30, rz:  0.65 },
      rightUpperArm: { rx:  0.30, rz: -0.65 },
      leftLowerArm:  { rx:  0.50 },
      rightLowerArm: { rx:  0.50 },
    },
  },

  // ── Reverse Cowgirl ───────────────────────────────────────────────────────
  {
    id: 'reverse-cowgirl',
    label: 'Reverse Cowgirl',
    emoji: '🔄',
    description: 'Straddle squat, facing away',
    cameraLookAtY: 0.85,
    cameraRadius: 1.8,
    bonesBottom: {
      hips:          { py: -0.10, ry: Math.PI },
      spine:         { rx:  0.35 },
      chest:         { rx:  0.18 },
      upperChest:    { rx:  0.08 },
      neck:          { rx: -0.10 },
      leftUpperLeg:  { rx:  1.45, rz: -0.55 },
      rightUpperLeg: { rx:  1.45, rz:  0.55 },
      leftLowerLeg:  { rx: -1.80 },
      rightLowerLeg: { rx: -1.80 },
      leftFoot:      { rx:  0.55 },
      rightFoot:     { rx:  0.55 },
      leftUpperArm:  { rx:  0.50, rz:  0.60 },
      rightUpperArm: { rx:  0.50, rz: -0.60 },
      leftLowerArm:  { rx:  0.90 },
      rightLowerArm: { rx:  0.90 },
    },
    bonesTop: {
      hips:          { py:  0.12, ry: Math.PI },
      spine:         { rx:  0.12 },
      chest:         { rx:  0.06 },
      upperChest:    { rx:  0.02 },
      neck:          { rx: -0.05 },
      leftUpperLeg:  { rx:  0.85, rz: -0.45 },
      rightUpperLeg: { rx:  0.85, rz:  0.45 },
      leftLowerLeg:  { rx: -1.00 },
      rightLowerLeg: { rx: -1.00 },
      leftFoot:      { rx:  0.20 },
      rightFoot:     { rx:  0.20 },
      leftUpperArm:  { rx:  0.30, rz:  0.65 },
      rightUpperArm: { rx:  0.30, rz: -0.65 },
      leftLowerArm:  { rx:  0.50 },
      rightLowerArm: { rx:  0.50 },
    },
  },

  // ── Kneeling bounce ───────────────────────────────────────────────────────
  // Upright kneeling. L0 drives hips up/down while shins stay planted.
  {
    id: 'kneeling',
    label: 'Kneeling',
    emoji: '🧎',
    description: 'Kneeling upright, hips bounce',
    cameraLookAtY: 0.85,
    cameraRadius: 1.7,
    bonesBottom: {
      hips:          { py: -0.22 },
      spine:         { rx:  0.20 },
      chest:         { rx:  0.10 },
      upperChest:    { rx:  0.04 },
      neck:          { rx: -0.08 },
      // Thighs straight down, knees fully bent (sitting on heels)
      leftUpperLeg:  { rx:  S,    rz: -0.12 },
      rightUpperLeg: { rx:  S,    rz:  0.12 },
      leftLowerLeg:  { rx: -S,    rz:  0.0 },
      rightLowerLeg: { rx: -S,    rz:  0.0 },
      leftFoot:      { rx: -0.20 },
      rightFoot:     { rx: -0.20 },
      leftUpperArm:  { rx:  0.15, rz:  0.75 },
      rightUpperArm: { rx:  0.15, rz: -0.75 },
      leftLowerArm:  { rx:  0.35 },
      rightLowerArm: { rx:  0.35 },
    },
    bonesTop: {
      hips:          { py:  0.08 },
      spine:         { rx:  0.06 },
      chest:         { rx:  0.03 },
      upperChest:    { rx:  0.01 },
      neck:          { rx: -0.03 },
      // Thighs still down but hips higher — body lifts off heels
      leftUpperLeg:  { rx:  S * 0.7, rz: -0.12 },
      rightUpperLeg: { rx:  S * 0.7, rz:  0.12 },
      leftLowerLeg:  { rx: -S,       rz:  0.0 },
      rightLowerLeg: { rx: -S,       rz:  0.0 },
      leftFoot:      { rx: -0.20 },
      rightFoot:     { rx: -0.20 },
      leftUpperArm:  { rx:  0.15, rz:  0.75 },
      rightUpperArm: { rx:  0.15, rz: -0.75 },
      leftLowerArm:  { rx:  0.35 },
      rightLowerArm: { rx:  0.35 },
    },
  },

  // ── Doggy ─────────────────────────────────────────────────────────────────
  // All-fours. L0=0: hips thrust back. L0=1: hips thrust forward.
  {
    id: 'doggy',
    label: 'Doggy',
    emoji: '🐾',
    description: 'All fours, hips thrust fwd/back',
    cameraLookAtY: 0.55,
    cameraRadius: 1.6,
    bonesBottom: {
      // Hips back (thrust away)
      hips:          { py: 0.0, pz: -0.14, rx: -0.30 },
      spine:         { rx: -0.40 },
      chest:         { rx: -0.25 },
      upperChest:    { rx: -0.12 },
      neck:          { rx:  0.45 },
      leftUpperLeg:  { rx:  0.70, rz: -0.10 },
      rightUpperLeg: { rx:  0.70, rz:  0.10 },
      leftLowerLeg:  { rx: -0.75 },
      rightLowerLeg: { rx: -0.75 },
      leftFoot:      { rx:  0.35 },
      rightFoot:     { rx:  0.35 },
      // Arms stretched forward like hands on floor
      leftUpperArm:  { rx: -1.30, rz:  0.18 },
      rightUpperArm: { rx: -1.30, rz: -0.18 },
      leftLowerArm:  { rx:  0.15 },
      rightLowerArm: { rx:  0.15 },
    },
    bonesTop: {
      // Hips forward (thrust in)
      hips:          { py: 0.0, pz:  0.10, rx:  0.10 },
      spine:         { rx: -0.25 },
      chest:         { rx: -0.15 },
      upperChest:    { rx: -0.07 },
      neck:          { rx:  0.30 },
      leftUpperLeg:  { rx:  1.05, rz: -0.10 },
      rightUpperLeg: { rx:  1.05, rz:  0.10 },
      leftLowerLeg:  { rx: -1.10 },
      rightLowerLeg: { rx: -1.10 },
      leftFoot:      { rx:  0.45 },
      rightFoot:     { rx:  0.45 },
      leftUpperArm:  { rx: -1.30, rz:  0.18 },
      rightUpperArm: { rx: -1.30, rz: -0.18 },
      leftLowerArm:  { rx:  0.15 },
      rightLowerArm: { rx:  0.15 },
    },
  },

  // ── Bent Over ─────────────────────────────────────────────────────────────
  // Standing bent forward. L0 drives hip tilt + slight knee bend.
  {
    id: 'bent-over',
    label: 'Bent Over',
    emoji: '🫳',
    description: 'Standing bent forward, hands down',
    cameraLookAtY: 0.75,
    cameraRadius: 1.7,
    bonesBottom: {
      hips:          { rx:  0.10 },
      spine:         { rx: -0.80 },
      chest:         { rx: -0.45 },
      upperChest:    { rx: -0.20 },
      neck:          { rx:  0.60 },
      leftUpperLeg:  { rx:  0.35, rz: -0.10 },
      rightUpperLeg: { rx:  0.35, rz:  0.10 },
      leftLowerLeg:  { rx: -0.30 },
      rightLowerLeg: { rx: -0.30 },
      leftFoot:      { rx:  0.0 },
      rightFoot:     { rx:  0.0 },
      leftUpperArm:  { rx: -0.80, rz:  0.25 },
      rightUpperArm: { rx: -0.80, rz: -0.25 },
      leftLowerArm:  { rx:  0.40 },
      rightLowerArm: { rx:  0.40 },
    },
    bonesTop: {
      hips:          { rx: -0.10 },
      spine:         { rx: -0.55 },
      chest:         { rx: -0.30 },
      upperChest:    { rx: -0.12 },
      neck:          { rx:  0.40 },
      leftUpperLeg:  { rx:  0.15, rz: -0.10 },
      rightUpperLeg: { rx:  0.15, rz:  0.10 },
      leftLowerLeg:  { rx: -0.10 },
      rightLowerLeg: { rx: -0.10 },
      leftFoot:      { rx:  0.0 },
      rightFoot:     { rx:  0.0 },
      leftUpperArm:  { rx: -0.80, rz:  0.25 },
      rightUpperArm: { rx: -0.80, rz: -0.25 },
      leftLowerArm:  { rx:  0.40 },
      rightLowerArm: { rx:  0.40 },
    },
  },

  // ── Sitting / Lap ─────────────────────────────────────────────────────────
  // Seated facing forward, grinding motion.
  {
    id: 'sitting',
    label: 'Sitting / Lap',
    emoji: '🪑',
    description: 'Seated, grinding motion',
    cameraLookAtY: 0.80,
    cameraRadius: 1.6,
    bonesBottom: {
      hips:          { py: -0.08, rx:  0.25 },
      spine:         { rx:  0.15 },
      chest:         { rx:  0.08 },
      upperChest:    { rx:  0.03 },
      neck:          { rx: -0.06 },
      leftUpperLeg:  { rx:  1.55, rz: -0.22 },
      rightUpperLeg: { rx:  1.55, rz:  0.22 },
      leftLowerLeg:  { rx: -1.45 },
      rightLowerLeg: { rx: -1.45 },
      leftFoot:      { rx:  0.22 },
      rightFoot:     { rx:  0.22 },
      leftUpperArm:  { rx:  0.25, rz:  0.65 },
      rightUpperArm: { rx:  0.25, rz: -0.65 },
      leftLowerArm:  { rx:  0.50 },
      rightLowerArm: { rx:  0.50 },
    },
    bonesTop: {
      hips:          { py:  0.06, rx:  0.10 },
      spine:         { rx:  0.06 },
      chest:         { rx:  0.03 },
      upperChest:    { rx:  0.01 },
      neck:          { rx: -0.03 },
      leftUpperLeg:  { rx:  1.45, rz: -0.22 },
      rightUpperLeg: { rx:  1.45, rz:  0.22 },
      leftLowerLeg:  { rx: -1.45 },
      rightLowerLeg: { rx: -1.45 },
      leftFoot:      { rx:  0.22 },
      rightFoot:     { rx:  0.22 },
      leftUpperArm:  { rx:  0.20, rz:  0.65 },
      rightUpperArm: { rx:  0.20, rz: -0.65 },
      leftLowerArm:  { rx:  0.45 },
      rightLowerArm: { rx:  0.45 },
    },
  },

  // ── Standing bounce ───────────────────────────────────────────────────────
  {
    id: 'standing',
    label: 'Standing',
    emoji: '🧍',
    description: 'Upright, slight squat bounce',
    cameraLookAtY: 1.1,
    cameraRadius: 2.1,
    bonesBottom: {
      hips:          { py: -0.10, rx:  0.08 },
      spine:         { rx:  0.12 },
      chest:         { rx:  0.06 },
      upperChest:    { rx:  0.02 },
      neck:          { rx: -0.04 },
      leftUpperLeg:  { rx:  0.55, rz: -0.08 },
      rightUpperLeg: { rx:  0.55, rz:  0.08 },
      leftLowerLeg:  { rx: -0.55 },
      rightLowerLeg: { rx: -0.55 },
      leftFoot:      { rx:  0.08 },
      rightFoot:     { rx:  0.08 },
      leftUpperArm:  { rx:  0.10, rz:  0.85 },
      rightUpperArm: { rx:  0.10, rz: -0.85 },
      leftLowerArm:  { rx:  0.25 },
      rightLowerArm: { rx:  0.25 },
    },
    bonesTop: {
      hips:          { py:  0.04, rx:  0.02 },
      spine:         { rx:  0.04 },
      chest:         { rx:  0.02 },
      upperChest:    { rx:  0.0 },
      neck:          { rx: -0.02 },
      leftUpperLeg:  { rx:  0.10, rz: -0.06 },
      rightUpperLeg: { rx:  0.10, rz:  0.06 },
      leftLowerLeg:  { rx: -0.10 },
      rightLowerLeg: { rx: -0.10 },
      leftFoot:      { rx:  0.02 },
      rightFoot:     { rx:  0.02 },
      leftUpperArm:  { rx:  0.08, rz:  0.88 },
      rightUpperArm: { rx:  0.08, rz: -0.88 },
      leftLowerArm:  { rx:  0.20 },
      rightLowerArm: { rx:  0.20 },
    },
  },
]

export const DEFAULT_POSE_ID = 'cowgirl'

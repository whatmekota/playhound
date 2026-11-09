import type { Rule, RuleEvent, RuleMemory, RulesConfig, RuleState } from '../src/lib/rules'
import { describe, expect, it } from 'vitest'
import {
  ACTIONS,
  CONDITIONS,
  defaultRulesConfig,
  describeRule,
  emptyMemory,
  evaluate,
  intensityTarget,
  LOG_MAX,
  MIN_COOLDOWN_SEC,
  normaliseRulesConfig,
  pushLog,
  rampStep,
  TEMPLATES,
  TRIGGERS,
} from '../src/lib/rules'

const T0 = 1_700_000_000_000

function state(over: Partial<RuleState> = {}): RuleState {
  return {
    now: T0,
    bpm: null,
    heartRise: null,
    phase: null,
    sessionMinutes: null,
    intensity: 100,
    script: null,
    tags: [],
    playing: true,
    panicked: false,
    ...over,
  }
}

function rule(over: Partial<Rule> = {}): Rule {
  return {
    id: 'r1',
    name: 'Test',
    enabled: true,
    trigger: { kind: 'edge' },
    conditions: [],
    actions: [{ kind: 'toast', text: 'hi' }],
    cooldownSec: 30,
    ...over,
  }
}

function config(rules: Rule[], over: Partial<RulesConfig> = {}): RulesConfig {
  return { enabled: true, maxPerMinute: 6, rules, ...over }
}

/** Run a sequence of steps, returning which steps fired (by index). */
function run(cfg: RulesConfig, steps: { s: Partial<RuleState>, e?: RuleEvent[] }[], mem: RuleMemory = emptyMemory()) {
  const out: string[][] = []
  for (const step of steps) {
    const r = evaluate(cfg, state(step.s), step.e ?? [], mem)
    mem = r.memory
    out.push(r.fired.map(f => f.rule.id))
  }
  return { out, mem }
}

describe('event triggers', () => {
  it('fire on their event and nothing else', () => {
    const cfg = config([rule()])
    const { out } = run(cfg, [
      { s: {}, e: [{ kind: 'video-start' }] },
      { s: { now: T0 + 1000 }, e: [{ kind: 'edge' }] },
    ])
    expect(out).toEqual([[], ['r1']])
  })

  it('match the phase a phase trigger names', () => {
    const cfg = config([rule({ trigger: { kind: 'phase', phase: 'peak' } })])
    const { out } = run(cfg, [
      { s: {}, e: [{ kind: 'phase', phase: 'build' }] },
      { s: { now: T0 + 1000 }, e: [{ kind: 'phase', phase: 'peak' }] },
    ])
    expect(out).toEqual([[], ['r1']])
  })

  it('a tag trigger fires when a video with that tag starts', () => {
    const cfg = config([rule({ trigger: { kind: 'tag', tag: 'pov' } })])
    const { out } = run(cfg, [
      { s: { tags: ['solo'] }, e: [{ kind: 'video-start' }] },
      { s: { now: T0 + 1000, tags: ['pov', 'fast'] }, e: [{ kind: 'video-start' }] },
    ])
    expect(out).toEqual([[], ['r1']])
  })

  it('a missed event is not remembered for later', () => {
    const cfg = config([rule({ conditions: [{ kind: 'phase', phase: 'peak' }] })])
    const { out } = run(cfg, [
      { s: { phase: 'build' }, e: [{ kind: 'edge' }] },
      { s: { now: T0 + 1000, phase: 'peak' } },
    ])
    expect(out).toEqual([[], []])
  })

  it('a rule does not answer an event its own action caused', () => {
    const cfg = config([rule({ id: 'a', cooldownSec: 5 }), rule({ id: 'b', cooldownSec: 5 })])
    const r = evaluate(cfg, state(), [{ kind: 'edge', causedBy: 'a' }], emptyMemory())
    expect(r.fired.map(f => f.rule.id)).toEqual(['b'])
  })
})

describe('level triggers', () => {
  const heart = rule({ trigger: { kind: 'heart-above', value: 130 }, cooldownSec: 5 })

  it('fire when they become true, not while they stay true', () => {
    const { out } = run(config([heart]), [
      { s: { bpm: 120 } },
      { s: { now: T0 + 1000, bpm: 133 } },
      { s: { now: T0 + 20_000, bpm: 140 } },
    ])
    expect(out).toEqual([[], ['r1'], []])
  })

  it('do not fire on the first look when already true', () => {
    const { out } = run(config([heart]), [
      { s: { bpm: 140 } },
      { s: { now: T0 + 1000, bpm: 141 } },
    ])
    expect(out).toEqual([[], []])
  })

  it('re-arm only past the margin, so a reading wobbling at the line fires once', () => {
    const { out } = run(config([heart]), [
      { s: { bpm: 120 } },
      { s: { now: T0 + 10_000, bpm: 131 } },
      { s: { now: T0 + 20_000, bpm: 129 } },
      { s: { now: T0 + 30_000, bpm: 131 } },
      { s: { now: T0 + 40_000, bpm: 126 } },
      { s: { now: T0 + 50_000, bpm: 132 } },
    ])
    expect(out).toEqual([[], ['r1'], [], [], [], ['r1']])
  })

  it('know nothing without a monitor', () => {
    const { out } = run(config([heart]), [
      { s: { bpm: null } },
      { s: { now: T0 + 1000, bpm: null } },
    ])
    expect(out).toEqual([[], []])
  })

  it('stay armed while a condition holds them back, and fire once it allows', () => {
    const r = rule({ trigger: { kind: 'heart-above', value: 130 }, conditions: [{ kind: 'phase', phase: 'build' }] })
    const { out } = run(config([r]), [
      { s: { bpm: 120, phase: 'entry' } },
      { s: { now: T0 + 1000, bpm: 135, phase: 'entry' } },
      { s: { now: T0 + 2000, bpm: 136, phase: 'build' } },
      { s: { now: T0 + 3000, bpm: 137, phase: 'build' } },
    ])
    expect(out).toEqual([[], [], ['r1'], []])
  })

  it('minutes fire once per session and again in the next one', () => {
    const r = rule({ trigger: { kind: 'minutes', value: 20 } })
    const { out } = run(config([r]), [
      { s: { sessionMinutes: 5 } },
      { s: { now: T0 + 1000, sessionMinutes: 20.1 } },
      { s: { now: T0 + 60_000, sessionMinutes: 45 } },
      { s: { now: T0 + 120_000, sessionMinutes: null } },
      { s: { now: T0 + 130_000, sessionMinutes: 1 } },
      { s: { now: T0 + 200_000, sessionMinutes: 21 } },
    ])
    expect(out).toEqual([[], ['r1'], [], [], [], ['r1']])
  })

  it('intensity crossings go one way each', () => {
    const up = rule({ id: 'up', trigger: { kind: 'intensity-up', value: 80 }, cooldownSec: 5 })
    const down = rule({ id: 'down', trigger: { kind: 'intensity-down', value: 40 }, cooldownSec: 5 })
    const { out } = run(config([up, down]), [
      { s: { intensity: 60 } },
      { s: { now: T0 + 10_000, intensity: 80 } },
      { s: { now: T0 + 20_000, intensity: 35 } },
      { s: { now: T0 + 30_000, intensity: 90 } },
    ])
    expect(out).toEqual([[], ['up'], ['down'], ['up']])
  })

  it('a fast climb fires heart-rising', () => {
    const r = rule({ trigger: { kind: 'heart-rising', value: 12 } })
    const { out } = run(config([r]), [
      { s: { bpm: 100, heartRise: 2 } },
      { s: { now: T0 + 1000, bpm: 115, heartRise: 14 } },
    ])
    expect(out).toEqual([[], ['r1']])
  })

  it('script intensity has its own margin', () => {
    const r = rule({ trigger: { kind: 'script-above', value: 75 }, cooldownSec: 5 })
    const { out } = run(config([r]), [
      { s: { script: 50 } },
      { s: { now: T0 + 10_000, script: 80 } },
      { s: { now: T0 + 20_000, script: 73 } },
      { s: { now: T0 + 30_000, script: 80 } },
      { s: { now: T0 + 40_000, script: 60 } },
      { s: { now: T0 + 50_000, script: 77 } },
    ])
    expect(out).toEqual([[], ['r1'], [], [], [], ['r1']])
  })
})

describe('conditions', () => {
  const at = (over: Partial<RuleState>, c: Rule['conditions']) =>
    evaluate(config([rule({ conditions: c })]), state(over), [{ kind: 'edge' }], emptyMemory()).fired.length

  it('all must hold', () => {
    const c: Rule['conditions'] = [{ kind: 'phase', phase: 'peak' }, { kind: 'heart-above', value: 120 }]
    expect(at({ phase: 'peak', bpm: 125 }, c)).toBe(1)
    expect(at({ phase: 'peak', bpm: 110 }, c)).toBe(0)
    expect(at({ phase: 'build', bpm: 125 }, c)).toBe(0)
  })

  it('heart conditions fail without a monitor', () => {
    expect(at({ bpm: null }, [{ kind: 'heart-above', value: 100 }])).toBe(0)
    expect(at({ bpm: null }, [{ kind: 'heart-below', value: 100 }])).toBe(0)
  })

  it('tags, minutes, intensity, script and playing', () => {
    expect(at({ tags: ['pov'] }, [{ kind: 'tag', tag: 'pov' }])).toBe(1)
    expect(at({ tags: ['pov'] }, [{ kind: 'not-tag', tag: 'pov' }])).toBe(0)
    expect(at({ sessionMinutes: 12 }, [{ kind: 'minutes-over', value: 10 }])).toBe(1)
    expect(at({ sessionMinutes: null }, [{ kind: 'minutes-under', value: 10 }])).toBe(1)
    expect(at({ intensity: 50 }, [{ kind: 'intensity-above', value: 60 }])).toBe(0)
    expect(at({ script: null }, [{ kind: 'script-below', value: 60 }])).toBe(0)
    expect(at({ playing: false }, [{ kind: 'playing' }])).toBe(0)
    expect(at({ phase: null }, [{ kind: 'not-phase', phase: 'peak' }])).toBe(1)
  })
})

describe('loop guards', () => {
  it('a rule waits out its cooldown', () => {
    const { out } = run(config([rule({ cooldownSec: 30 })]), [
      { s: {}, e: [{ kind: 'edge' }] },
      { s: { now: T0 + 10_000 }, e: [{ kind: 'edge' }] },
      { s: { now: T0 + 31_000 }, e: [{ kind: 'edge' }] },
    ])
    expect(out).toEqual([['r1'], [], ['r1']])
  })

  it('the per-minute cap covers every rule, and says so once a minute', () => {
    const rules = Array.from({ length: 5 }, (_, i) => rule({ id: `r${i}`, cooldownSec: 5 }))
    let mem = emptyMemory()
    const cfg = config(rules, { maxPerMinute: 3 })
    const a = evaluate(cfg, state(), [{ kind: 'edge' }], mem)
    expect(a.fired).toHaveLength(3)
    expect(a.capped.map(r => r.id)).toEqual(['r3'])
    mem = a.memory
    const b = evaluate(cfg, state({ now: T0 + 10_000 }), [{ kind: 'edge' }], mem)
    expect(b.fired).toHaveLength(0)
    expect(b.capped).toHaveLength(0)
    const c = evaluate(cfg, state({ now: T0 + 61_000 }), [{ kind: 'edge' }], b.memory)
    expect(c.fired).toHaveLength(3)
  })

  it('a rule that edges on an edge cannot run away', () => {
    // Simulate the composable: each firing of the rule produces another edge event.
    const cfg = config([rule({ id: 'loop', actions: [{ kind: 'edge' }], cooldownSec: MIN_COOLDOWN_SEC })])
    let mem = emptyMemory()
    let fires = 0
    let pending: RuleEvent[] = [{ kind: 'edge' }]
    for (let t = 0; t < 60_000; t += 500) {
      const r = evaluate(cfg, state({ now: T0 + t }), pending, mem)
      mem = r.memory
      pending = r.fired.map(() => ({ kind: 'edge', causedBy: 'loop' }))
      fires += r.fired.length
    }
    expect(fires).toBe(1)
  })

  it('two rules feeding each other are held to the cap', () => {
    const cfg = config([
      rule({ id: 'a', actions: [{ kind: 'edge' }], cooldownSec: 5 }),
      rule({ id: 'b', actions: [{ kind: 'edge' }], cooldownSec: 5 }),
    ], { maxPerMinute: 6 })
    let mem = emptyMemory()
    let fires = 0
    let pending: RuleEvent[] = [{ kind: 'edge' }]
    for (let t = 0; t < 60_000; t += 500) {
      const r = evaluate(cfg, state({ now: T0 + t }), pending, mem)
      mem = r.memory
      pending = r.fired.map(f => ({ kind: 'edge', causedBy: f.rule.id }))
      fires += r.fired.length
    }
    expect(fires).toBeLessThanOrEqual(6)
  })
})

describe('panic and the master switch', () => {
  const heart = rule({ trigger: { kind: 'heart-above', value: 130 }, cooldownSec: 5 })

  it('nothing fires in a panic', () => {
    const r = evaluate(config([rule()]), state({ panicked: true }), [{ kind: 'edge' }], emptyMemory())
    expect(r.fired).toEqual([])
  })

  it('a level that went true during a panic does not fire on resume', () => {
    const { out } = run(config([heart]), [
      { s: { bpm: 120 } },
      { s: { now: T0 + 1000, bpm: 140, panicked: true } },
      { s: { now: T0 + 2000, bpm: 141 } },
      { s: { now: T0 + 3000, bpm: 120 } },
      { s: { now: T0 + 4000, bpm: 135 } },
    ])
    expect(out).toEqual([[], [], [], [], ['r1']])
  })

  it('master off fires nothing, and disarms the same way', () => {
    const off = config([heart], { enabled: false })
    const on = config([heart])
    let mem = evaluate(on, state({ bpm: 120 }), [], emptyMemory()).memory
    mem = evaluate(off, state({ now: T0 + 1000, bpm: 140 }), [{ kind: 'edge' }], mem).memory
    expect(evaluate(on, state({ now: T0 + 2000, bpm: 140 }), [], mem).fired).toEqual([])
  })

  it('a switched-off rule does nothing', () => {
    expect(evaluate(config([rule({ enabled: false })]), state(), [{ kind: 'edge' }], emptyMemory()).fired).toEqual([])
  })

  it('a rule with no actions does not count as firing', () => {
    expect(evaluate(config([rule({ actions: [] })]), state(), [{ kind: 'edge' }], emptyMemory()).fired).toEqual([])
  })
})

describe('memory', () => {
  it('forgets rules that were deleted', () => {
    let mem = evaluate(config([rule()]), state(), [{ kind: 'edge' }], emptyMemory()).memory
    expect(mem.lastFired.r1).toBe(T0)
    mem = evaluate(config([]), state({ now: T0 + 1 }), [], mem).memory
    expect(mem.lastFired).toEqual({})
  })
})

describe('storage', () => {
  it('starts with every template, all off', () => {
    const cfg = defaultRulesConfig()
    expect(cfg.enabled).toBe(true)
    expect(cfg.rules.map(r => r.id)).toEqual(TEMPLATES.map(t => t.id))
    expect(cfg.rules.every(r => !r.enabled)).toBe(true)
    // A copy, not the templates themselves.
    cfg.rules[0].actions.push({ kind: 'pause' })
    expect(TEMPLATES[0].actions).toHaveLength(1)
  })

  it('round-trips a valid config unchanged', () => {
    const cfg = defaultRulesConfig()
    cfg.rules[0].enabled = true
    expect(normaliseRulesConfig(JSON.parse(JSON.stringify(cfg)))).toEqual(cfg)
  })

  it('cleans what a hand-edited backup could hold', () => {
    const cfg = normaliseRulesConfig({
      enabled: 'yes',
      maxPerMinute: 1000,
      rules: [
        { id: 'x', name: '', enabled: true, trigger: { kind: 'heart-above', value: 9999 }, actions: [{ kind: 'intensity-set', value: 0 }, { kind: 'explode' }], cooldownSec: 0 },
        { id: 'x', trigger: { kind: 'tag', tag: '  #POV  ' }, actions: [{ kind: 'motion-source', source: 'warp' }], conditions: [{ kind: 'phase', phase: 'nope' }, null] },
        { trigger: { kind: 'nope' } },
        null,
      ],
    })
    expect(cfg.enabled).toBe(true)
    expect(cfg.maxPerMinute).toBe(30)
    expect(cfg.rules).toHaveLength(2)
    const [a, b] = cfg.rules
    expect(a.name).toBe('Rule')
    expect(a.trigger.value).toBe(230)
    expect(a.actions).toEqual([{ kind: 'intensity-set', value: 10 }])
    expect(a.cooldownSec).toBe(MIN_COOLDOWN_SEC)
    expect(b.id).not.toBe('x')
    expect(b.enabled).toBe(false)
    expect(b.trigger.tag).toBe('pov')
    expect(b.actions).toEqual([{ kind: 'motion-source', source: 'funscript' }])
    expect(b.conditions).toEqual([{ kind: 'phase', phase: 'build' }])
  })

  it('falls back to the defaults for anything unreadable', () => {
    expect(normaliseRulesConfig(null)).toEqual(defaultRulesConfig())
    expect(normaliseRulesConfig({ rules: 'no' })).toEqual(defaultRulesConfig())
  })
})

describe('words', () => {
  it('every kind has a description', () => {
    for (const t of TRIGGERS)
      expect(describeRule(rule({ trigger: { kind: t.kind, value: t.value, phase: 'peak', tag: 'x' } }))).toMatch(/^When /)
    for (const c of CONDITIONS)
      expect(describeRule(rule({ conditions: [{ kind: c.kind, value: c.value, phase: 'peak', tag: 'x' }] }))).toContain(',')
    for (const a of ACTIONS)
      expect(describeRule(rule({ actions: [{ kind: a.kind, value: a.value, source: 'music', tag: 'x', text: 'y' }] }))).toContain(':')
  })

  it('reads like a sentence', () => {
    expect(describeRule(TEMPLATES[0])).toBe('When heart rate goes over 130 bpm, in Build: edge')
  })
})

describe('intensity', () => {
  it('a set or nudge stays inside the knob range', () => {
    expect(intensityTarget({ kind: 'intensity-set', value: 60 }, 1)).toBe(0.6)
    expect(intensityTarget({ kind: 'intensity-nudge', value: 10 }, 0.95)).toBe(1)
    expect(intensityTarget({ kind: 'intensity-nudge', value: -50 }, 0.3)).toBe(0.1)
  })

  it('ramps a step at a time and lands exactly', () => {
    let v = 0.5
    for (let i = 0; i < 100; i++)
      v = rampStep(v, 0.7, 0.1)
    expect(v).toBe(0.7)
    expect(rampStep(0.5, 0.7, 1)).toBeCloseTo(0.55)
    expect(rampStep(0.5, 0.3, 1)).toBeCloseTo(0.45)
  })
})

describe('log', () => {
  it('keeps the newest fifty', () => {
    let log: ReturnType<typeof pushLog> = []
    for (let i = 0; i < 60; i++)
      log = pushLog(log, { at: i, ruleId: 'r', name: 'n', reason: '', did: '', tone: 'ok' })
    expect(log).toHaveLength(LOG_MAX)
    expect(log[0].at).toBe(59)
  })
})

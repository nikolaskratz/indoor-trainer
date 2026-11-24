import { describe, expect, it } from 'vitest'
import { evaluateErgStep, toleranceFor, type PowerPoint } from './ergTest.ts'

/** Four readings a second for 20 s; power moves from `from` to `to` with a 2 s time constant. */
function ramp(from: number, to: number, startMs = 0, seconds = 20): PowerPoint[] {
  const out: PowerPoint[] = []
  for (let ms = 0; ms <= seconds * 1000; ms += 250) {
    out.push({ t: startMs + ms, powerW: to + (from - to) * Math.exp(-ms / 2000) })
  }
  return out
}

describe('ERG step judgement', () => {
  it('uses 10 W or 8 %, whichever is larger', () => {
    expect(toleranceFor(100)).toBe(10)
    expect(toleranceFor(300)).toBe(24)
  })

  it('passes when power settles on the target', () => {
    const r = evaluateErgStep(ramp(120, 180), 180, 0, 20000)
    expect(r.pass).toBe(true)
    expect(r.meanW).toBe(180)
    expect(r.settleS).toBeGreaterThan(1)
    expect(r.settleS).toBeLessThan(8)
  })

  it('finds the settle time with one reading a second and uneven timing', () => {
    // As reported by a real trainer: readings 980 to 1010 ms apart.
    const samples: PowerPoint[] = []
    let t = 0
    for (let i = 0; i < 21; i++) {
      samples.push({ t, powerW: 180 + (120 - 180) * Math.exp(-t / 2000) + (i % 2 ? 3 : -3) })
      t += i % 3 === 0 ? 980 : 1010
    }
    const r = evaluateErgStep(samples, 180, 0, 20000)
    expect(r.pass).toBe(true)
    expect(r.settleS).not.toBeNull()
    expect(r.settleS).toBeLessThan(6)
  })

  it('fails when the trainer ignores the target', () => {
    const r = evaluateErgStep(ramp(120, 120), 180, 0, 20000)
    expect(r.pass).toBe(false)
    expect(r.settleS).toBeNull()
    expect(r.reason).toBe('held 120 W instead of 180 W')
  })

  it('says so when the rider is not pedalling', () => {
    const r = evaluateErgStep(ramp(0, 0), 150, 0, 20000)
    expect(r.pass).toBe(false)
    expect(r.reason).toContain('pedalling')
  })

  it('fails without readings and ignores readings outside the step', () => {
    expect(evaluateErgStep([], 150, 0, 20000).reason).toBe('no power readings')
    const r = evaluateErgStep(ramp(150, 150, 50000), 150, 0, 20000)
    expect(r.meanW).toBeNull()
  })
})

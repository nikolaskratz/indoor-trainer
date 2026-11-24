// Heart Rate and Cycling Power measurement formats.

export interface HeartRateSample {
  bpm: number
  /** null when the strap does not report skin contact. */
  contact: boolean | null
  /** Beat-to-beat intervals in milliseconds, when the strap sends them. */
  rrMs: number[]
}

/** Heart Rate Measurement (0x2A37). */
export function parseHeartRate(dv: DataView): HeartRateSample | null {
  if (dv.byteLength < 2) return null
  const flags = dv.getUint8(0)
  let o = 1
  let bpm: number
  if (flags & 0x01) {
    if (dv.byteLength < 3) return null
    bpm = dv.getUint16(o, true)
    o += 2
  } else {
    bpm = dv.getUint8(o)
    o += 1
  }
  const contact = flags & 0x04 ? (flags & 0x02) !== 0 : null
  if (flags & 0x08) o += 2 // energy expended
  const rrMs: number[] = []
  if (flags & 0x10) {
    for (; o + 2 <= dv.byteLength; o += 2) {
      rrMs.push(Math.round((dv.getUint16(o, true) / 1024) * 1000))
    }
  }
  return { bpm, contact, rrMs }
}

export interface CyclingPowerSample {
  powerW: number
  crankRevs?: number
  /** Time of the last crank event in 1/1024 s, wrapping at 65536. */
  crankEventTime?: number
}

/** Cycling Power Measurement (0x2A63). */
export function parseCyclingPower(dv: DataView): CyclingPowerSample | null {
  if (dv.byteLength < 4) return null
  const flags = dv.getUint16(0, true)
  const out: CyclingPowerSample = { powerW: dv.getInt16(2, true) }
  let o = 4
  if (flags & 0x01) o += 1 // pedal power balance
  if (flags & 0x04) o += 2 // accumulated torque
  if (flags & 0x10) o += 6 // wheel revolution data
  if (flags & 0x20 && o + 4 <= dv.byteLength) {
    out.crankRevs = dv.getUint16(o, true)
    out.crankEventTime = dv.getUint16(o + 2, true)
  }
  return out
}

/** Turns successive crank revolution counters into a cadence. */
export class CrankCadence {
  private lastRevs: number | null = null
  private lastTime: number | null = null
  private lastChangeMs = 0

  update(revs: number, eventTime: number, nowMs: number): number | null {
    if (this.lastRevs === null || this.lastTime === null) {
      this.lastRevs = revs
      this.lastTime = eventTime
      this.lastChangeMs = nowMs
      return null
    }
    const dRevs = (revs - this.lastRevs + 65536) % 65536
    const dTime = (eventTime - this.lastTime + 65536) % 65536
    if (dRevs === 0 || dTime === 0) {
      // No new crank event: after 3 s without one the rider has stopped.
      return nowMs - this.lastChangeMs > 3000 ? 0 : null
    }
    this.lastRevs = revs
    this.lastTime = eventTime
    this.lastChangeMs = nowMs
    const rpm = (dRevs / (dTime / 1024)) * 60
    return rpm < 250 ? Math.round(rpm) : null
  }
}

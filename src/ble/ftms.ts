// Fitness Machine Service (FTMS) wire formats. All multi-byte fields are little-endian.

export interface IndoorBikeData {
  speedKph?: number
  avgSpeedKph?: number
  cadenceRpm?: number
  avgCadenceRpm?: number
  distanceM?: number
  resistance?: number
  powerW?: number
  avgPowerW?: number
  energyKcal?: number
  heartRate?: number
  elapsedS?: number
  remainingS?: number
  /** True when the packet ended before all fields its flags announced. */
  truncated?: boolean
}

/** Indoor Bike Data (0x2AD2). Field presence is announced by a 16-bit flags word. */
export function parseIndoorBikeData(dv: DataView): IndoorBikeData {
  const out: IndoorBikeData = {}
  if (dv.byteLength < 2) return { truncated: true }
  const flags = dv.getUint16(0, true)
  let o = 2
  const has = (bit: number) => (flags & (1 << bit)) !== 0
  const fits = (size: number) => {
    if (o + size <= dv.byteLength) return true
    out.truncated = true
    return false
  }
  // Bit 0 is "more data": instantaneous speed is present when it is 0.
  if (!has(0)) {
    if (!fits(2)) return out
    out.speedKph = dv.getUint16(o, true) / 100
    o += 2
  }
  if (has(1)) {
    if (!fits(2)) return out
    out.avgSpeedKph = dv.getUint16(o, true) / 100
    o += 2
  }
  if (has(2)) {
    if (!fits(2)) return out
    out.cadenceRpm = dv.getUint16(o, true) / 2
    o += 2
  }
  if (has(3)) {
    if (!fits(2)) return out
    out.avgCadenceRpm = dv.getUint16(o, true) / 2
    o += 2
  }
  if (has(4)) {
    if (!fits(3)) return out
    out.distanceM = dv.getUint16(o, true) | (dv.getUint8(o + 2) << 16)
    o += 3
  }
  if (has(5)) {
    if (!fits(2)) return out
    out.resistance = dv.getInt16(o, true)
    o += 2
  }
  if (has(6)) {
    if (!fits(2)) return out
    out.powerW = dv.getInt16(o, true)
    o += 2
  }
  if (has(7)) {
    if (!fits(2)) return out
    out.avgPowerW = dv.getInt16(o, true)
    o += 2
  }
  if (has(8)) {
    // total kcal (uint16), kcal per hour (uint16), kcal per minute (uint8)
    if (!fits(5)) return out
    out.energyKcal = dv.getUint16(o, true)
    o += 5
  }
  if (has(9)) {
    if (!fits(1)) return out
    out.heartRate = dv.getUint8(o)
    o += 1
  }
  if (has(10)) {
    if (!fits(1)) return out
    o += 1 // metabolic equivalent, unused
  }
  if (has(11)) {
    if (!fits(2)) return out
    out.elapsedS = dv.getUint16(o, true)
    o += 2
  }
  if (has(12)) {
    if (!fits(2)) return out
    out.remainingS = dv.getUint16(o, true)
    o += 2
  }
  return out
}

export interface FtmsFeatures {
  machineBits: number
  targetBits: number
  cadence: boolean
  powerMeasurement: boolean
  /** The trainer accepts a target power, which is what ERG mode needs. */
  powerTarget: boolean
  resistanceTarget: boolean
  simulation: boolean
  spinDown: boolean
}

/** Fitness Machine Feature (0x2ACC): 32 bits of machine features, 32 bits of target settings. */
export function parseFtmsFeature(dv: DataView): FtmsFeatures | null {
  if (dv.byteLength < 8) return null
  const machineBits = dv.getUint32(0, true)
  const targetBits = dv.getUint32(4, true)
  const m = (bit: number) => (machineBits & (1 << bit)) !== 0
  const t = (bit: number) => (targetBits & (1 << bit)) !== 0
  return {
    machineBits,
    targetBits,
    cadence: m(1),
    powerMeasurement: m(14),
    powerTarget: t(3),
    resistanceTarget: t(2),
    simulation: t(13),
    spinDown: t(15),
  }
}

export interface PowerRange {
  minW: number
  maxW: number
  stepW: number
}

/** Supported Power Range (0x2AD8). */
export function parsePowerRange(dv: DataView): PowerRange | null {
  if (dv.byteLength < 6) return null
  return { minW: dv.getInt16(0, true), maxW: dv.getInt16(2, true), stepW: dv.getUint16(4, true) }
}

export const CP_OP = {
  REQUEST_CONTROL: 0x00,
  RESET: 0x01,
  SET_TARGET_POWER: 0x05,
  START_RESUME: 0x07,
  STOP_PAUSE: 0x08,
  RESPONSE: 0x80,
} as const

export const CP_RESULT: Record<number, string> = {
  1: 'success',
  2: 'not supported',
  3: 'invalid parameter',
  4: 'operation failed',
  5: 'control not permitted',
}

export const encodeRequestControl = (): Uint8Array => Uint8Array.of(CP_OP.REQUEST_CONTROL)
export const encodeStart = (): Uint8Array => Uint8Array.of(CP_OP.START_RESUME)
export const encodeReset = (): Uint8Array => Uint8Array.of(CP_OP.RESET)

/** Set Target Power: signed 16-bit watts. */
export function encodeSetTargetPower(watts: number): Uint8Array {
  const w = Math.max(-32768, Math.min(32767, Math.round(watts)))
  const out = new Uint8Array(3)
  const dv = new DataView(out.buffer)
  dv.setUint8(0, CP_OP.SET_TARGET_POWER)
  dv.setInt16(1, w, true)
  return out
}

export interface ControlPointResponse {
  requestOp: number
  result: number
}

/** Control point indication: [0x80, request op code, result code]. */
export function parseControlPointResponse(dv: DataView): ControlPointResponse | null {
  if (dv.byteLength < 3 || dv.getUint8(0) !== CP_OP.RESPONSE) return null
  return { requestOp: dv.getUint8(1), result: dv.getUint8(2) }
}

/** Fitness Machine Status (0x2ADA), rendered as text for the log. */
export function describeFtmsStatus(dv: DataView): string {
  if (dv.byteLength < 1) return 'empty status'
  const op = dv.getUint8(0)
  switch (op) {
    case 0x01:
      return 'reset'
    case 0x02:
      return 'stopped or paused by user'
    case 0x03:
      return 'stopped by safety key'
    case 0x04:
      return 'started or resumed by user'
    case 0x07:
      return 'target resistance changed'
    case 0x08:
      return dv.byteLength >= 3
        ? `target power changed to ${dv.getInt16(1, true)} W`
        : 'target power changed'
    case 0x12:
      return 'simulation parameters changed'
    case 0x14:
      return 'spin down status'
    case 0xff:
      return 'control permission lost'
    default:
      return `status 0x${op.toString(16).padStart(2, '0')}`
  }
}

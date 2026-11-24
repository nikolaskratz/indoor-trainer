import { describe, expect, it } from 'vitest'
import {
  describeFtmsStatus,
  encodeSetTargetPower,
  parseControlPointResponse,
  parseFtmsFeature,
  parseIndoorBikeData,
  parsePowerRange,
} from './ftms.ts'
import { CrankCadence, parseCyclingPower, parseHeartRate } from './sensors.ts'
import { hex, uuid16 } from './uuids.ts'

const dv = (...bytes: number[]) => new DataView(Uint8Array.from(bytes).buffer)

describe('indoor bike data', () => {
  it('reads speed, cadence and power', () => {
    // flags 0x0044: cadence + power; speed 25.00 km/h, cadence 90 rpm, power 200 W
    const d = parseIndoorBikeData(dv(0x44, 0x00, 0xc4, 0x09, 0xb4, 0x00, 0xc8, 0x00))
    expect(d).toEqual({ speedKph: 25, cadenceRpm: 90, powerW: 200 })
  })

  it('skips speed when the more-data bit is set', () => {
    // flags 0x0041: more data (no speed) + power 150 W
    expect(parseIndoorBikeData(dv(0x41, 0x00, 0x96, 0x00))).toEqual({ powerW: 150 })
  })

  it('walks past optional fields in order', () => {
    // flags 0x0a74: cadence, distance, resistance, power, heart rate, elapsed time
    const d = parseIndoorBikeData(
      dv(0x74, 0x0a, 0x10, 0x0e, 0xaa, 0x00, 0x10, 0x27, 0x00, 0x05, 0x00, 0xfa, 0x00, 0x8c, 0x3c, 0x00),
    )
    expect(d).toEqual({
      speedKph: 36,
      cadenceRpm: 85,
      distanceM: 10000,
      resistance: 5,
      powerW: 250,
      heartRate: 140,
      elapsedS: 60,
    })
  })

  it('reads negative power as signed', () => {
    expect(parseIndoorBikeData(dv(0x41, 0x00, 0xff, 0xff)).powerW).toBe(-1)
  })

  it('flags a packet that ends early instead of throwing', () => {
    const d = parseIndoorBikeData(dv(0x44, 0x00, 0xc4, 0x09, 0xb4))
    expect(d.speedKph).toBe(25)
    expect(d.truncated).toBe(true)
    expect(d.powerW).toBeUndefined()
  })
})

describe('control point', () => {
  it('encodes a target power as signed 16-bit little-endian', () => {
    expect(hex(encodeSetTargetPower(250))).toBe('05 fa 00')
    expect(hex(encodeSetTargetPower(1000))).toBe('05 e8 03')
    expect(hex(encodeSetTargetPower(149.6))).toBe('05 96 00')
  })

  it('reads a response', () => {
    expect(parseControlPointResponse(dv(0x80, 0x05, 0x01))).toEqual({ requestOp: 5, result: 1 })
    expect(parseControlPointResponse(dv(0x80, 0x05, 0x05))).toEqual({ requestOp: 5, result: 5 })
    expect(parseControlPointResponse(dv(0x05, 0x01))).toBeNull()
  })

  it('describes a target power status', () => {
    expect(describeFtmsStatus(dv(0x08, 0xc8, 0x00))).toBe('target power changed to 200 W')
    expect(describeFtmsStatus(dv(0xff))).toBe('control permission lost')
  })
})

describe('feature and range', () => {
  it('reads the feature bits ERG mode depends on', () => {
    const f = parseFtmsFeature(dv(0x02, 0x40, 0x00, 0x00, 0x0c, 0x20, 0x00, 0x00))
    expect(f).toMatchObject({
      cadence: true,
      powerMeasurement: true,
      powerTarget: true,
      resistanceTarget: true,
      simulation: true,
      spinDown: false,
    })
    expect(parseFtmsFeature(dv(0, 0, 0, 0, 0x04, 0, 0, 0))?.powerTarget).toBe(false)
  })

  it('reads the supported power range', () => {
    expect(parsePowerRange(dv(0x00, 0x00, 0xd0, 0x07, 0x01, 0x00))).toEqual({ minW: 0, maxW: 2000, stepW: 1 })
  })
})

describe('heart rate', () => {
  it('reads an 8-bit value with contact and RR intervals', () => {
    // flags 0x16; 142 bpm; RR 433/1024 s and 430/1024 s
    const s = parseHeartRate(dv(0x16, 142, 0xb1, 0x01, 0xae, 0x01))
    expect(s).toEqual({ bpm: 142, contact: true, rrMs: [423, 420] })
  })

  it('reads a 16-bit value and unsupported contact', () => {
    expect(parseHeartRate(dv(0x01, 0x2c, 0x01))).toEqual({ bpm: 300, contact: null, rrMs: [] })
  })

  it('reports lost contact', () => {
    expect(parseHeartRate(dv(0x04, 0))?.contact).toBe(false)
  })
})

describe('cycling power', () => {
  it('reads power alone', () => {
    expect(parseCyclingPower(dv(0x00, 0x00, 0xc8, 0x00))).toEqual({ powerW: 200 })
  })

  it('finds crank data behind wheel data', () => {
    // flags 0x0030: wheel + crank revolution data
    const s = parseCyclingPower(dv(0x30, 0x00, 0xc8, 0x00, 1, 0, 0, 0, 2, 0, 0x0a, 0x00, 0x00, 0x04))
    expect(s).toEqual({ powerW: 200, crankRevs: 10, crankEventTime: 1024 })
  })

  it('turns crank counters into cadence, across the 16-bit wrap', () => {
    const c = new CrankCadence()
    expect(c.update(10, 65000, 0)).toBeNull()
    // 2 revolutions in 1365/1024 s = 90 rpm, with the event time wrapping past 65536
    expect(c.update(12, (65000 + 1365) % 65536, 1300)).toBe(90)
    // no new crank event for more than 3 s: the rider stopped
    expect(c.update(12, (65000 + 1365) % 65536, 2000)).toBeNull()
    expect(c.update(12, (65000 + 1365) % 65536, 5000)).toBe(0)
  })
})

describe('uuids', () => {
  it('expands 16-bit numbers', () => {
    expect(uuid16(0x1826)).toBe('00001826-0000-1000-8000-00805f9b34fb')
  })
})

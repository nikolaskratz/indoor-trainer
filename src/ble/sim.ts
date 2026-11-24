// A stand-in for navigator.bluetooth that behaves like an FTMS trainer and a
// heart rate strap. Used with ?sim=1 so the app can be developed and tested
// without hardware. It speaks the same bytes a real device would.

import { CP_OP } from './ftms.ts'
import { CHAR, SERVICE } from './uuids.ts'

const view = (bytes: number[] | Uint8Array): DataView => new DataView(Uint8Array.from(bytes).buffer)

class SimCharacteristic extends EventTarget {
  readonly uuid: string
  value: DataView | null = null
  notifying = false
  private readonly read: (() => DataView) | null
  private readonly write: ((data: DataView) => void) | null

  constructor(
    uuid: string,
    read: (() => DataView) | null = null,
    write: ((data: DataView) => void) | null = null,
  ) {
    super()
    this.uuid = uuid
    this.read = read
    this.write = write
  }

  async readValue(): Promise<DataView> {
    if (!this.read) throw new Error('NotSupportedError: characteristic is not readable')
    this.value = this.read()
    return this.value
  }

  async startNotifications(): Promise<this> {
    this.notifying = true
    return this
  }

  async stopNotifications(): Promise<this> {
    this.notifying = false
    return this
  }

  async writeValueWithResponse(data: BufferSource): Promise<void> {
    if (!this.write) throw new Error('NotSupportedError: characteristic is not writable')
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data)
    this.write(view(bytes))
  }

  notify(bytes: number[] | Uint8Array): void {
    if (!this.notifying) return
    this.value = view(bytes)
    this.dispatchEvent(new Event('characteristicvaluechanged'))
  }
}

class SimService {
  readonly uuid: string
  private readonly characteristics: Map<string, SimCharacteristic>

  constructor(uuid: string, characteristics: SimCharacteristic[]) {
    this.uuid = uuid
    this.characteristics = new Map(characteristics.map((c) => [c.uuid, c]))
  }

  async getCharacteristic(uuid: string): Promise<SimCharacteristic> {
    const c = this.characteristics.get(uuid)
    if (!c) throw new Error(`NotFoundError: no characteristic ${uuid}`)
    return c
  }
}

class SimDevice extends EventTarget {
  readonly name: string
  readonly gatt: {
    connected: boolean
    connect: () => Promise<unknown>
    disconnect: () => void
    getPrimaryService: (uuid: string) => Promise<SimService>
  }
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(name: string, services: SimService[], tick: () => void, tickMs: number, onDrop: () => void = () => {}) {
    super()
    this.name = name
    const byUuid = new Map(services.map((s) => [s.uuid, s]))
    const gatt = {
      connected: false,
      connect: async () => {
        gatt.connected = true
        this.timer = setInterval(tick, tickMs)
        return gatt
      },
      disconnect: () => {
        if (!gatt.connected) return
        gatt.connected = false
        clearInterval(this.timer)
        onDrop()
        this.dispatchEvent(new Event('gattserverdisconnected'))
      },
      getPrimaryService: async (uuid: string) => {
        const s = byUuid.get(uuid)
        if (!s) throw new Error(`NotFoundError: no service ${uuid}`)
        return s
      },
    }
    this.gatt = gatt
  }
}

const text = (s: string) => () => new DataView(new TextEncoder().encode(s).buffer)
const int16 = (n: number) => [n & 0xff, (n >> 8) & 0xff]

/** Power the simulated rider produces: shared so the heart rate can follow it. */
let simPowerW = 0
/** False while the simulated rider has stopped pedalling. */
let simPedalling = true
let simTrainer: SimDevice | null = null

/** Hooks for automated tests, exposed as window.__sim in simulation mode. */
export const simControls = {
  setPedalling(on: boolean): void {
    simPedalling = on
  },
  /** Drops the trainer connection as if it went out of range. */
  dropTrainer(): void {
    simTrainer?.gatt.disconnect()
  },
}

function makeTrainer(): SimDevice {
  let hasControl = false
  let targetW: number | null = null
  let powerW = 95
  const FREE_RIDE_W = 95
  const TICK_MS = 250

  const bikeData = new SimCharacteristic(CHAR.INDOOR_BIKE_DATA)
  const status = new SimCharacteristic(CHAR.FTMS_STATUS)
  const cyclingPower = new SimCharacteristic(CHAR.CYCLING_POWER_MEASUREMENT)
  const controlPoint: SimCharacteristic = new SimCharacteristic(CHAR.FTMS_CONTROL_POINT, null, (data) => {
    const op = data.getUint8(0)
    let result = 1
    if (op === CP_OP.REQUEST_CONTROL) {
      hasControl = true
    } else if (op === CP_OP.RESET) {
      hasControl = false
      targetW = null
    } else if (!hasControl) {
      result = 5
    } else if (op === CP_OP.SET_TARGET_POWER) {
      const w = data.getInt16(1, true)
      if (w < 0 || w > 2000) result = 3
      else {
        targetW = w
        setTimeout(() => status.notify([0x08, ...int16(w)]), 30)
      }
    } else if (op !== CP_OP.START_RESUME && op !== CP_OP.STOP_PAUSE) {
      result = 2
    }
    setTimeout(() => controlPoint.notify([CP_OP.RESPONSE, op, result]), 40)
  })

  const tick = () => {
    // Power closes on the target with a time constant of about 2 s, like an ERG trainer.
    const goal = simPedalling ? (targetW ?? FREE_RIDE_W) : 0
    powerW += (goal - powerW) * (TICK_MS / 2000) + (simPedalling ? (Math.random() - 0.5) * 6 : 0)
    powerW = simPedalling ? Math.max(0, powerW) : powerW < 3 ? 0 : powerW
    simPowerW = powerW
    const cadence = simPedalling ? 88 + Math.sin(Date.now() / 4000) * 2 : 0
    const speedKph = 3.6 * Math.cbrt(powerW / 0.2)
    const p = Math.round(powerW)
    // flags 0x0044: instantaneous cadence and power present, speed present (bit 0 clear)
    bikeData.notify([0x44, 0x00, ...int16(Math.round(speedKph * 100)), ...int16(Math.round(cadence * 2)), ...int16(p)])
    cyclingPower.notify([0x00, 0x00, ...int16(p)])
  }

  const ftms = new SimService(SERVICE.FTMS, [
    // cadence + power measurement supported; resistance, power and simulation targets supported
    new SimCharacteristic(CHAR.FTMS_FEATURE, () => view([0x02, 0x40, 0x00, 0x00, 0x0c, 0x20, 0x00, 0x00])),
    new SimCharacteristic(CHAR.SUPPORTED_POWER_RANGE, () => view([...int16(0), ...int16(2000), ...int16(1)])),
    bikeData,
    status,
    controlPoint,
  ])
  const cps = new SimService(SERVICE.CYCLING_POWER, [cyclingPower])
  const info = new SimService(SERVICE.DEVICE_INFO, [
    new SimCharacteristic(CHAR.MANUFACTURER_NAME, text('Simulated')),
    new SimCharacteristic(CHAR.MODEL_NUMBER, text('Sim Trainer')),
    new SimCharacteristic(CHAR.FIRMWARE_REVISION, text('1.0')),
  ])
  // A real trainer forgets who controls it when the connection drops.
  simTrainer = new SimDevice('Sim Trainer 0001', [ftms, cps, info], tick, TICK_MS, () => {
    hasControl = false
    targetW = null
  })
  return simTrainer
}

function makeHeartRate(): SimDevice {
  let bpm = 110
  const measurement = new SimCharacteristic(CHAR.HEART_RATE_MEASUREMENT)
  const tick = () => {
    // Heart rate drifts towards a value that depends on the simulated power.
    bpm += (95 + simPowerW * 0.3 - bpm) * 0.05
    const rr = Math.round((60 / bpm) * 1024)
    // flags 0x16: 8-bit value, contact supported and detected, RR intervals present
    measurement.notify([0x16, Math.round(bpm), ...int16(rr)])
  }
  const hr = new SimService(SERVICE.HEART_RATE, [measurement])
  const battery = new SimService(SERVICE.BATTERY, [new SimCharacteristic(CHAR.BATTERY_LEVEL, () => view([80]))])
  return new SimDevice('Sim HRM', [hr, battery], tick, 1000)
}

/** Mimics the parts of navigator.bluetooth the app uses. */
export const simBluetooth = {
  async getAvailability(): Promise<boolean> {
    return true
  },
  async requestDevice(options?: RequestDeviceOptions): Promise<BluetoothDevice> {
    const filters = options && 'filters' in options ? (options.filters ?? []) : []
    const wantsHeartRate =
      filters.length > 0 && filters.every((f) => (f.services ?? []).includes(SERVICE.HEART_RATE))
    const device = wantsHeartRate ? makeHeartRate() : makeTrainer()
    return device as unknown as BluetoothDevice
  },
} as unknown as Bluetooth

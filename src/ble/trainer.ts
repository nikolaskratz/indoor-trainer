import {
  CP_OP,
  CP_RESULT,
  describeFtmsStatus,
  encodeSetTargetPower,
  parseControlPointResponse,
  parseFtmsFeature,
  parseIndoorBikeData,
  parsePowerRange,
  type FtmsFeatures,
  type PowerRange,
} from './ftms.ts'
import { CrankCadence, parseCyclingPower } from './sensors.ts'
import { CHAR, hex, SERVICE, SERVICE_LABEL } from './uuids.ts'

export type Log = (message: string) => void

export interface TrainerSample {
  /** Which Bluetooth service the values came from. */
  source: 'ftms' | 'cps'
  powerW?: number
  cadenceRpm?: number
  speedKph?: number
}

export interface TrainerInfo {
  name: string
  /** Full UUIDs of the known services the trainer exposes. */
  services: string[]
  features: FtmsFeatures | null
  powerRange: PowerRange | null
  hasControlPoint: boolean
  manufacturer?: string
  model?: string
  firmware?: string
  hardware?: string
}

export interface ControlResult {
  ok: boolean
  /** FTMS result code, or null when the trainer never answered. */
  result: number | null
  text: string
}

export interface TrainerHandlers {
  onSample: (sample: TrainerSample) => void
  onStatus: (text: string) => void
  onDisconnect: () => void
  log: Log
}

const KNOWN_SERVICES = [
  SERVICE.FTMS,
  SERVICE.CYCLING_POWER,
  SERVICE.FEC_OVER_BLE,
  SERVICE.DEVICE_INFO,
  SERVICE.BATTERY,
  SERVICE.HEART_RATE,
]

const RESPONSE_TIMEOUT_MS = 4000

/**
 * Opens the browser's device chooser for a trainer. Must be called from a click.
 * `acceptAll` lists every nearby Bluetooth device, for trainers that do not
 * advertise a service the filters match.
 */
export function requestTrainerDevice(bt: Bluetooth, acceptAll: boolean): Promise<BluetoothDevice> {
  if (acceptAll) {
    return bt.requestDevice({ acceptAllDevices: true, optionalServices: KNOWN_SERVICES })
  }
  return bt.requestDevice({
    filters: [
      { services: [SERVICE.FTMS] },
      { services: [SERVICE.CYCLING_POWER] },
      { namePrefix: 'Saris' },
      { namePrefix: 'H3' },
      { namePrefix: 'HAMMER' },
    ],
    optionalServices: KNOWN_SERVICES,
  })
}

async function readText(
  service: BluetoothRemoteGATTService,
  characteristic: string,
): Promise<string | undefined> {
  try {
    const c = await service.getCharacteristic(characteristic)
    const value = await c.readValue()
    return new TextDecoder().decode(value).replace(/\0+$/, '').trim() || undefined
  } catch {
    return undefined
  }
}

export class Trainer {
  readonly info: TrainerInfo
  private readonly device: BluetoothDevice
  private readonly handlers: TrainerHandlers
  private controlPoint: BluetoothRemoteGATTCharacteristic | null = null
  private pending: { op: number; resolve: (result: number | null) => void } | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private readonly cadence = new CrankCadence()

  private constructor(device: BluetoothDevice, handlers: TrainerHandlers) {
    this.device = device
    this.handlers = handlers
    this.info = {
      name: device.name ?? 'Unknown trainer',
      services: [],
      features: null,
      powerRange: null,
      hasControlPoint: false,
    }
  }

  /** Connects and subscribes to everything the trainer offers. */
  static async open(device: BluetoothDevice, handlers: TrainerHandlers): Promise<Trainer> {
    const trainer = new Trainer(device, handlers)
    const { log } = handlers
    if (!device.gatt) throw new Error('Device has no GATT server')
    log(`Connecting to "${trainer.info.name}"`)
    const server = await device.gatt.connect()
    device.addEventListener('gattserverdisconnected', trainer.onDisconnected)

    for (const uuid of KNOWN_SERVICES) {
      try {
        const service = await server.getPrimaryService(uuid)
        trainer.info.services.push(uuid)
        log(`Service found: ${SERVICE_LABEL[uuid] ?? uuid}`)
        if (uuid === SERVICE.FTMS) await trainer.setupFtms(service)
        if (uuid === SERVICE.CYCLING_POWER) await trainer.setupCyclingPower(service)
        if (uuid === SERVICE.DEVICE_INFO) {
          trainer.info.manufacturer = await readText(service, CHAR.MANUFACTURER_NAME)
          trainer.info.model = await readText(service, CHAR.MODEL_NUMBER)
          trainer.info.firmware = await readText(service, CHAR.FIRMWARE_REVISION)
          trainer.info.hardware = await readText(service, CHAR.HARDWARE_REVISION)
          log(
            `Device info: ${trainer.info.manufacturer ?? '?'} / ${trainer.info.model ?? '?'} / firmware ${trainer.info.firmware ?? '?'}`,
          )
        }
      } catch {
        // Service not present on this device.
      }
    }
    if (trainer.info.services.length === 0) {
      log('No known trainer service found on this device')
    }
    return trainer
  }

  private async setupFtms(service: BluetoothRemoteGATTService): Promise<void> {
    const { log } = this.handlers
    try {
      const value = await (await service.getCharacteristic(CHAR.FTMS_FEATURE)).readValue()
      this.info.features = parseFtmsFeature(value)
      log(`FTMS feature [${hex(value)}]`)
    } catch (e) {
      log(`FTMS feature not readable: ${String(e)}`)
    }
    try {
      const value = await (await service.getCharacteristic(CHAR.SUPPORTED_POWER_RANGE)).readValue()
      this.info.powerRange = parsePowerRange(value)
      log(`Supported power range [${hex(value)}]`)
    } catch (e) {
      log(`Supported power range not readable: ${String(e)}`)
    }
    try {
      const data = await service.getCharacteristic(CHAR.INDOOR_BIKE_DATA)
      data.addEventListener('characteristicvaluechanged', this.onIndoorBikeData)
      await data.startNotifications()
      log('Subscribed to indoor bike data')
    } catch (e) {
      log(`Indoor bike data unavailable: ${String(e)}`)
    }
    try {
      const status = await service.getCharacteristic(CHAR.FTMS_STATUS)
      status.addEventListener('characteristicvaluechanged', this.onFtmsStatus)
      await status.startNotifications()
    } catch (e) {
      log(`FTMS status unavailable: ${String(e)}`)
    }
    try {
      const cp = await service.getCharacteristic(CHAR.FTMS_CONTROL_POINT)
      cp.addEventListener('characteristicvaluechanged', this.onControlPoint)
      await cp.startNotifications()
      this.controlPoint = cp
      this.info.hasControlPoint = true
      log('Control point ready')
    } catch (e) {
      log(`Control point unavailable: ${String(e)}`)
    }
  }

  private async setupCyclingPower(service: BluetoothRemoteGATTService): Promise<void> {
    const { log } = this.handlers
    try {
      const m = await service.getCharacteristic(CHAR.CYCLING_POWER_MEASUREMENT)
      m.addEventListener('characteristicvaluechanged', this.onCyclingPower)
      await m.startNotifications()
      log('Subscribed to cycling power measurement')
    } catch (e) {
      log(`Cycling power measurement unavailable: ${String(e)}`)
    }
  }

  private readonly onIndoorBikeData = (event: Event): void => {
    const value = (event.target as BluetoothRemoteGATTCharacteristic).value
    if (!value) return
    const d = parseIndoorBikeData(value)
    if (d.truncated) this.handlers.log(`Short indoor bike data packet [${hex(value)}]`)
    this.handlers.onSample({
      source: 'ftms',
      powerW: d.powerW,
      cadenceRpm: d.cadenceRpm,
      speedKph: d.speedKph,
    })
  }

  private readonly onCyclingPower = (event: Event): void => {
    const value = (event.target as BluetoothRemoteGATTCharacteristic).value
    if (!value) return
    const d = parseCyclingPower(value)
    if (!d) return
    let cadenceRpm: number | undefined
    if (d.crankRevs !== undefined && d.crankEventTime !== undefined) {
      cadenceRpm = this.cadence.update(d.crankRevs, d.crankEventTime, Date.now()) ?? undefined
    }
    this.handlers.onSample({ source: 'cps', powerW: d.powerW, cadenceRpm })
  }

  private readonly onFtmsStatus = (event: Event): void => {
    const value = (event.target as BluetoothRemoteGATTCharacteristic).value
    if (!value) return
    const text = describeFtmsStatus(value)
    this.handlers.log(`Trainer status: ${text} [${hex(value)}]`)
    this.handlers.onStatus(text)
  }

  private readonly onControlPoint = (event: Event): void => {
    const value = (event.target as BluetoothRemoteGATTCharacteristic).value
    if (!value) return
    const response = parseControlPointResponse(value)
    if (!response) {
      this.handlers.log(`Unexpected control point data [${hex(value)}]`)
      return
    }
    if (this.pending && this.pending.op === response.requestOp) {
      const { resolve } = this.pending
      this.pending = null
      resolve(response.result)
    } else {
      this.handlers.log(`Unmatched control point response [${hex(value)}]`)
    }
  }

  private readonly onDisconnected = (): void => {
    this.controlPoint = null
    this.pending?.resolve(null)
    this.pending = null
    this.handlers.log('Trainer disconnected')
    this.handlers.onDisconnect()
  }

  /** Writes one control point command and waits for the trainer's answer. One at a time. */
  private command(bytes: Uint8Array, label: string): Promise<ControlResult> {
    const run = async (): Promise<ControlResult> => {
      const cp = this.controlPoint
      const { log } = this.handlers
      if (!cp) return { ok: false, result: null, text: 'no control point' }
      const op = bytes[0]
      let timer: ReturnType<typeof setTimeout> | undefined
      const answer = new Promise<number | null>((resolve) => {
        this.pending = { op, resolve }
        timer = setTimeout(() => {
          if (this.pending?.op === op) this.pending = null
          resolve(null)
        }, RESPONSE_TIMEOUT_MS)
      })
      log(`→ ${label} [${hex(bytes)}]`)
      try {
        await cp.writeValueWithResponse(bytes as Uint8Array<ArrayBuffer>)
      } catch (e) {
        clearTimeout(timer)
        this.pending = null
        log(`← ${label}: write failed (${String(e)})`)
        return { ok: false, result: null, text: `write failed: ${String(e)}` }
      }
      const result = await answer
      clearTimeout(timer)
      const text = result === null ? 'no answer' : (CP_RESULT[result] ?? `code ${result}`)
      log(`← ${label}: ${text}`)
      return { ok: result === 1, result, text }
    }
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }

  requestControl(): Promise<ControlResult> {
    return this.command(Uint8Array.of(CP_OP.REQUEST_CONTROL), 'Request control')
  }

  start(): Promise<ControlResult> {
    return this.command(Uint8Array.of(CP_OP.START_RESUME), 'Start')
  }

  setTargetPower(watts: number): Promise<ControlResult> {
    return this.command(encodeSetTargetPower(watts), `Set target ${Math.round(watts)} W`)
  }

  /** Reset hands control back; the trainer leaves ERG mode. */
  reset(): Promise<ControlResult> {
    return this.command(Uint8Array.of(CP_OP.RESET), 'Reset')
  }

  disconnect(): void {
    this.device.removeEventListener('gattserverdisconnected', this.onDisconnected)
    if (this.device.gatt?.connected) this.device.gatt.disconnect()
    this.controlPoint = null
    this.handlers.log('Trainer disconnected by user')
  }
}

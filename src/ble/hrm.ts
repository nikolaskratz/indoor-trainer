import { parseHeartRate, type HeartRateSample } from './sensors.ts'
import type { Log } from './trainer.ts'
import { CHAR, SERVICE } from './uuids.ts'

export interface HeartRateHandlers {
  onSample: (sample: HeartRateSample) => void
  onDisconnect: () => void
  log: Log
}

/** Opens the browser's device chooser for a heart rate strap. Must be called from a click. */
export function requestHeartRateDevice(bt: Bluetooth): Promise<BluetoothDevice> {
  return bt.requestDevice({
    filters: [{ services: [SERVICE.HEART_RATE] }],
    optionalServices: [SERVICE.BATTERY],
  })
}

export class HeartRateMonitor {
  readonly name: string
  batteryPercent: number | null = null
  private readonly device: BluetoothDevice
  private readonly handlers: HeartRateHandlers

  private constructor(device: BluetoothDevice, handlers: HeartRateHandlers) {
    this.device = device
    this.handlers = handlers
    this.name = device.name ?? 'Heart rate monitor'
  }

  static async open(device: BluetoothDevice, handlers: HeartRateHandlers): Promise<HeartRateMonitor> {
    const hrm = new HeartRateMonitor(device, handlers)
    const { log } = handlers
    if (!device.gatt) throw new Error('Device has no GATT server')
    log(`Connecting to "${hrm.name}"`)
    const server = await device.gatt.connect()
    device.addEventListener('gattserverdisconnected', hrm.onDisconnected)
    const service = await server.getPrimaryService(SERVICE.HEART_RATE)
    const measurement = await service.getCharacteristic(CHAR.HEART_RATE_MEASUREMENT)
    measurement.addEventListener('characteristicvaluechanged', hrm.onMeasurement)
    await measurement.startNotifications()
    log('Subscribed to heart rate')
    try {
      const battery = await server.getPrimaryService(SERVICE.BATTERY)
      const level = await (await battery.getCharacteristic(CHAR.BATTERY_LEVEL)).readValue()
      hrm.batteryPercent = level.getUint8(0)
      log(`Strap battery ${hrm.batteryPercent} %`)
    } catch {
      // Battery level is optional.
    }
    return hrm
  }

  private readonly onMeasurement = (event: Event): void => {
    const value = (event.target as BluetoothRemoteGATTCharacteristic).value
    if (!value) return
    const sample = parseHeartRate(value)
    if (sample) this.handlers.onSample(sample)
  }

  private readonly onDisconnected = (): void => {
    this.device.removeEventListener('gattserverdisconnected', this.onDisconnected)
    this.handlers.log('Heart rate monitor disconnected')
    this.handlers.onDisconnect()
  }

  disconnect(): void {
    this.device.removeEventListener('gattserverdisconnected', this.onDisconnected)
    if (this.device.gatt?.connected) this.device.gatt.disconnect()
    this.handlers.log('Heart rate monitor disconnected by user')
  }
}

/** Expands a 16-bit Bluetooth SIG number to the full UUID string Web Bluetooth reports. */
export const uuid16 = (n: number): string =>
  `0000${n.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`

export const SERVICE = {
  FTMS: uuid16(0x1826),
  CYCLING_POWER: uuid16(0x1818),
  HEART_RATE: uuid16(0x180d),
  DEVICE_INFO: uuid16(0x180a),
  BATTERY: uuid16(0x180f),
  /** ANT+ FE-C tunnelled over Bluetooth (Tacx and some others). Detected for the report only. */
  FEC_OVER_BLE: '6e40fec1-b5a3-f393-e0a9-e50e24dcca9e',
} as const

export const CHAR = {
  FTMS_FEATURE: uuid16(0x2acc),
  INDOOR_BIKE_DATA: uuid16(0x2ad2),
  SUPPORTED_POWER_RANGE: uuid16(0x2ad8),
  FTMS_CONTROL_POINT: uuid16(0x2ad9),
  FTMS_STATUS: uuid16(0x2ada),
  CYCLING_POWER_MEASUREMENT: uuid16(0x2a63),
  HEART_RATE_MEASUREMENT: uuid16(0x2a37),
  BATTERY_LEVEL: uuid16(0x2a19),
  MANUFACTURER_NAME: uuid16(0x2a29),
  MODEL_NUMBER: uuid16(0x2a24),
  FIRMWARE_REVISION: uuid16(0x2a26),
  HARDWARE_REVISION: uuid16(0x2a27),
} as const

export const SERVICE_LABEL: Record<string, string> = {
  [SERVICE.FTMS]: 'Fitness Machine (FTMS)',
  [SERVICE.CYCLING_POWER]: 'Cycling Power',
  [SERVICE.HEART_RATE]: 'Heart Rate',
  [SERVICE.DEVICE_INFO]: 'Device Information',
  [SERVICE.BATTERY]: 'Battery',
  [SERVICE.FEC_OVER_BLE]: 'FE-C over Bluetooth',
}

export const hex = (data: DataView | Uint8Array): string => {
  const bytes =
    data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ')
}

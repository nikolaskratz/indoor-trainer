// The app's single connection to the trainer and the heart rate strap.
// Lives outside React so a ride keeps running while pages change.

import { Store } from '../lib/store.ts'
import { HeartRateMonitor, requestHeartRateDevice } from './hrm.ts'
import { simBluetooth, simControls } from './sim.ts'
import { requestTrainerDevice, Trainer, type TrainerInfo, type TrainerSample } from './trainer.ts'

const params = new URLSearchParams(location.search)
/** Simulated devices instead of real Bluetooth: add ?sim=1 to the URL. */
export const SIM = params.has('sim')
export const bluetooth: Bluetooth | null = SIM ? simBluetooth : (navigator.bluetooth ?? null)
if (SIM) (window as unknown as { __sim: typeof simControls }).__sim = simControls

export type LinkStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting'

export interface ConnectionState {
  trainer: {
    status: LinkStatus
    name: string | null
    info: TrainerInfo | null
    error: string | null
    /** Whether the trainer let us take control: null until first asked. */
    control: boolean | null
    /** Whether the trainer accepted the last target: null until first asked. */
    targetAccepted: boolean | null
    /** Target power the trainer last confirmed. */
    targetW: number | null
  }
  hr: {
    status: LinkStatus
    name: string | null
    battery: number | null
    error: string | null
  }
}

export interface LiveState {
  /** Preferred power reading: the trainer protocol's, else the power service's. */
  powerW: number | null
  ftmsPowerW: number | null
  cpsPowerW: number | null
  cadenceRpm: number | null
  speedKph: number | null
  hrBpm: number | null
  hrContact: boolean | null
  hrHasRr: boolean
}

export interface PowerReading {
  t: number
  powerW: number
}

const idleTrainer: ConnectionState['trainer'] = {
  status: 'idle',
  name: null,
  info: null,
  error: null,
  control: null,
  targetAccepted: null,
  targetW: null,
}
const idleHr: ConnectionState['hr'] = { status: 'idle', name: null, battery: null, error: null }
const emptyLive: LiveState = {
  powerW: null,
  ftmsPowerW: null,
  cpsPowerW: null,
  cadenceRpm: null,
  speedKph: null,
  hrBpm: null,
  hrContact: null,
  hrHasRr: false,
}

export const connection = new Store<ConnectionState>({ trainer: idleTrainer, hr: idleHr })
export const live = new Store<LiveState>(emptyLive)
export const deviceLog = new Store<string[]>([])

const clock = () => new Date().toLocaleTimeString('en-GB', { hour12: false })
export function addLog(message: string): void {
  deviceLog.set((lines) => [...lines.slice(-799), `${clock()}  ${message}`])
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const RECONNECT_EVERY_MS = SIM ? 500 : 2000
const RECONNECT_ATTEMPTS = 150
/** Readings older than this are treated as "no signal". */
const STALE_MS = 3500

function errorText(e: unknown): string {
  if (e instanceof DOMException && e.name === 'NotFoundError') return 'No device was chosen.'
  return e instanceof Error ? e.message : String(e)
}

const patchTrainer = (patch: Partial<ConnectionState['trainer']>) =>
  connection.set((s) => ({ ...s, trainer: { ...s.trainer, ...patch } }))
const patchHr = (patch: Partial<ConnectionState['hr']>) =>
  connection.set((s) => ({ ...s, hr: { ...s.hr, ...patch } }))

let trainer: Trainer | null = null
let trainerDevice: BluetoothDevice | null = null
let hasControl = false
/** The target the app wants; re-sent after a reconnect. null means "no ERG target". */
let desiredTargetW: number | null = null
let lastFtmsPowerAt = 0
let lastPowerAt = 0
let lastCadenceAt = 0
let lastHrAt = 0
const powerListeners = new Set<(reading: PowerReading) => void>()

/** Calls back for every preferred power reading, a few times a second. */
export function onPower(listener: (reading: PowerReading) => void): () => void {
  powerListeners.add(listener)
  return () => powerListeners.delete(listener)
}

function onTrainerSample(s: TrainerSample): void {
  const t = Date.now()
  const patch: Partial<LiveState> = {}
  if (s.cadenceRpm !== undefined) {
    patch.cadenceRpm = s.cadenceRpm
    lastCadenceAt = t
  }
  if (s.speedKph !== undefined) patch.speedKph = s.speedKph
  if (s.powerW !== undefined) {
    if (s.source === 'ftms') {
      patch.ftmsPowerW = s.powerW
      lastFtmsPowerAt = t
    } else {
      patch.cpsPowerW = s.powerW
    }
    // Prefer the trainer protocol's power; use the power service only when that is silent.
    if (s.source === 'ftms' || t - lastFtmsPowerAt > 3000) {
      patch.powerW = s.powerW
      lastPowerAt = t
      for (const listener of powerListeners) listener({ t, powerW: s.powerW })
    }
  }
  live.set((prev) => ({ ...prev, ...patch }))
}

// Blank out readings that stopped arriving.
setInterval(() => {
  const t = Date.now()
  const l = live.get()
  const patch: Partial<LiveState> = {}
  if (l.powerW !== null && t - lastPowerAt > STALE_MS) {
    patch.powerW = null
    patch.ftmsPowerW = null
    patch.cpsPowerW = null
    patch.speedKph = null
  }
  if (l.cadenceRpm !== null && t - lastCadenceAt > STALE_MS) patch.cadenceRpm = null
  if (l.hrBpm !== null && t - lastHrAt > 6000) patch.hrBpm = null
  if (Object.keys(patch).length > 0) live.set((prev) => ({ ...prev, ...patch }))
}, 1000)

async function openTrainer(device: BluetoothDevice): Promise<void> {
  hasControl = false
  trainer = await Trainer.open(device, {
    onSample: onTrainerSample,
    onStatus: (text) => {
      if (text === 'control permission lost') hasControl = false
    },
    onDisconnect: () => void reconnectTrainer(device),
    log: (m) => addLog(`[trainer] ${m}`),
  })
  patchTrainer({
    status: 'connected',
    name: trainer.info.name,
    info: { ...trainer.info },
    error: null,
    control: null,
    targetAccepted: null,
    targetW: null,
  })
  if (desiredTargetW !== null) await setTarget(desiredTargetW)
}

let trainerReconnecting = false

async function reconnectTrainer(device: BluetoothDevice): Promise<void> {
  trainer = null
  hasControl = false
  if (trainerReconnecting || trainerDevice !== device) return
  trainerReconnecting = true
  patchTrainer({ status: 'reconnecting', targetW: null, error: 'Connection lost. Reconnecting…' })
  try {
    for (let attempt = 1; attempt <= RECONNECT_ATTEMPTS; attempt++) {
      await sleep(RECONNECT_EVERY_MS)
      if (trainerDevice !== device) return // the user disconnected or chose another device
      try {
        addLog(`[trainer] Reconnect attempt ${attempt}`)
        await openTrainer(device)
        addLog('[trainer] Reconnected')
        return
      } catch (e) {
        addLog(`[trainer] Reconnect failed: ${String(e)}`)
      }
    }
  } finally {
    trainerReconnecting = false
  }
  if (trainerDevice === device) {
    trainerDevice = null
    patchTrainer({ ...idleTrainer, error: 'The trainer disconnected and did not come back.' })
  }
}

/** Opens the device chooser and connects. Must be called from a click. */
export async function connectTrainer(acceptAll = false): Promise<void> {
  if (!bluetooth) return
  patchTrainer({ status: 'connecting', error: null })
  try {
    const device = await requestTrainerDevice(bluetooth, acceptAll)
    trainerDevice = device
    await openTrainer(device)
  } catch (e) {
    addLog(`[trainer] Connect failed: ${String(e)}`)
    trainerDevice = null
    trainer = null
    patchTrainer({ ...idleTrainer, error: errorText(e) })
  }
}

export function disconnectTrainer(): void {
  trainerDevice = null
  trainer?.disconnect()
  trainer = null
  hasControl = false
  desiredTargetW = null
  patchTrainer(idleTrainer)
  live.set((prev) => ({ ...prev, powerW: null, ftmsPowerW: null, cpsPowerW: null, cadenceRpm: null, speedKph: null }))
}

async function takeControl(t: Trainer): Promise<boolean> {
  const granted = await t.requestControl()
  if (!granted.ok) {
    patchTrainer({ control: false })
    return false
  }
  // Some trainers answer "operation failed" to start when already started; that is harmless.
  await t.start()
  hasControl = true
  patchTrainer({ control: true })
  return true
}

/**
 * Sets the ERG target in watts. Takes control first when needed and retries once
 * if the trainer says control was lost. Resolves to whether the trainer accepted.
 */
export async function setTarget(watts: number): Promise<boolean> {
  const range = trainer?.info.powerRange
  const w = Math.round(range && range.maxW > range.minW ? Math.min(range.maxW, Math.max(range.minW, watts)) : watts)
  desiredTargetW = w
  const t = trainer
  if (!t) return false
  if (!hasControl && !(await takeControl(t))) return false
  let r = await t.setTargetPower(w)
  if (!r.ok && r.result === 5) {
    hasControl = false
    if (await takeControl(t)) r = await t.setTargetPower(w)
  }
  if (trainer !== t) return false
  // A newer target may have been requested while this one was in flight.
  if (r.ok) patchTrainer({ targetAccepted: true, targetW: w })
  else patchTrainer({ targetAccepted: false })
  return r.ok
}

/** Hands control back: the trainer leaves ERG mode. */
export async function releaseTarget(): Promise<void> {
  desiredTargetW = null
  const t = trainer
  if (!t) return
  if (hasControl) await t.reset()
  hasControl = false
  patchTrainer({ targetW: null, control: null })
}

let hrm: HeartRateMonitor | null = null
let hrDevice: BluetoothDevice | null = null

async function openHr(device: BluetoothDevice): Promise<void> {
  hrm = await HeartRateMonitor.open(device, {
    onSample: (s) => {
      lastHrAt = Date.now()
      live.set((prev) => ({ ...prev, hrBpm: s.bpm, hrContact: s.contact, hrHasRr: prev.hrHasRr || s.rrMs.length > 0 }))
    },
    onDisconnect: () => void reconnectHr(device),
    log: (m) => addLog(`[hr] ${m}`),
  })
  patchHr({ status: 'connected', name: hrm.name, battery: hrm.batteryPercent, error: null })
}

let hrReconnecting = false

async function reconnectHr(device: BluetoothDevice): Promise<void> {
  hrm = null
  if (hrReconnecting || hrDevice !== device) return
  hrReconnecting = true
  patchHr({ status: 'reconnecting', error: 'Connection lost. Reconnecting…' })
  try {
    for (let attempt = 1; attempt <= RECONNECT_ATTEMPTS; attempt++) {
      await sleep(RECONNECT_EVERY_MS)
      if (hrDevice !== device) return
      try {
        await openHr(device)
        addLog('[hr] Reconnected')
        return
      } catch (e) {
        addLog(`[hr] Reconnect failed: ${String(e)}`)
      }
    }
  } finally {
    hrReconnecting = false
  }
  if (hrDevice === device) {
    hrDevice = null
    patchHr({ ...idleHr, error: 'The heart rate strap disconnected and did not come back.' })
  }
}

/** Opens the device chooser and connects. Must be called from a click. */
export async function connectHr(): Promise<void> {
  if (!bluetooth) return
  patchHr({ status: 'connecting', error: null })
  try {
    const device = await requestHeartRateDevice(bluetooth)
    hrDevice = device
    await openHr(device)
  } catch (e) {
    addLog(`[hr] Connect failed: ${String(e)}`)
    hrDevice = null
    hrm = null
    patchHr({ ...idleHr, error: errorText(e) })
  }
}

export function disconnectHr(): void {
  hrDevice = null
  hrm?.disconnect()
  hrm = null
  patchHr(idleHr)
  live.set((prev) => ({ ...prev, hrBpm: null, hrContact: null }))
}

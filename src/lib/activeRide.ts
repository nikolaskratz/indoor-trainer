// Connects a RideSession to the real world: Bluetooth devices, the clock,
// sound, the screen wake lock and storage. One ride at a time.

import { connection, live, onPower, releaseTarget, setTarget, SIM } from '../ble/devices.ts'
import { summarize } from '../domain/metrics.ts'
import { RideSession, type LiveReading, type RideIO, type RiderProfile, type RideSnapshot } from '../domain/ride.ts'
import type { Workout } from '../domain/workout.ts'
import { clearActiveRide, saveActiveRide, saveRide, settingsStore, type SavedRide } from './storage.ts'
import { Store } from './store.ts'

/** The ride in progress, or null. */
export const activeRide = new Store<RideSession | null>(null)
/** Id of a ride that just ended on its own and was saved; the ride page opens its summary. */
export const finishedRideId = new Store<string | null>(null)

// In simulation mode ?speed=20 runs the ride clock 20 times faster, for tests.
const SPEED = SIM ? Math.max(1, Number(new URLSearchParams(location.search).get('speed')) || 1) : 1
// The fast clock keeps its origin across reloads, so time never runs backwards in tests.
const clockBase = SPEED === 1 ? Date.now() : Number(sessionStorage.getItem('it.clockBase')) || Date.now()
if (SPEED !== 1) sessionStorage.setItem('it.clockBase', String(clockBase))
const now = (): number => clockBase + (Date.now() - clockBase) * SPEED

const TICK_MS = 250
const SAVE_EVERY_MS = 10_000

let powerSum = 0
let powerCount = 0
onPower((reading) => {
  powerSum += reading.powerW
  powerCount++
})

let audio: AudioContext | null = null
function beep(frequency: number, seconds: number): void {
  if (!settingsStore.get().sound || !audio) return
  const t = audio.currentTime
  const osc = audio.createOscillator()
  const gain = audio.createGain()
  osc.frequency.value = frequency
  gain.gain.setValueAtTime(0.0001, t)
  gain.gain.exponentialRampToValueAtTime(0.25, t + 0.01)
  gain.gain.exponentialRampToValueAtTime(0.0001, t + seconds)
  osc.connect(gain).connect(audio.destination)
  osc.start(t)
  osc.stop(t + seconds + 0.02)
}

const io: RideIO = {
  now,
  setTarget(watts) {
    if (watts === null) void releaseTarget()
    else void setTarget(watts)
  },
  live(): LiveReading {
    const l = live.get()
    return { powerW: l.powerW, cadenceRpm: l.cadenceRpm, hrBpm: l.hrBpm }
  },
  takeSecond(): LiveReading {
    const l = live.get()
    // Mean of the readings that arrived this second; none arriving means no signal.
    const powerW = powerCount > 0 ? powerSum / powerCount : l.powerW
    powerSum = 0
    powerCount = 0
    return { powerW, cadenceRpm: l.cadenceRpm, hrBpm: l.hrBpm }
  },
  cue(kind) {
    if (kind === 'countdown') beep(660, 0.12)
    else if (kind === 'change') beep(990, 0.35)
    else beep(520, 0.8)
  },
}

// A worker timer keeps ticking at full rate when the tab is in the background,
// where page timers are slowed down.
let stopTicker: (() => void) | null = null
function startTicker(onTick: () => void): void {
  stopTicker?.()
  try {
    const source = `setInterval(() => postMessage(0), ${TICK_MS})`
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    const worker = new Worker(url)
    worker.onmessage = onTick
    stopTicker = () => {
      worker.terminate()
      URL.revokeObjectURL(url)
    }
  } catch {
    const id = setInterval(onTick, TICK_MS)
    stopTicker = () => clearInterval(id)
  }
}

let wakeLock: WakeLockSentinel | null = null
async function keepScreenOn(): Promise<void> {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen')
    }
  } catch {
    // Not granted (for example on battery saver): the ride still works.
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && activeRide.get()) void keepScreenOn()
})

// Leaving the page mid-ride loses the Bluetooth connection: ask first.
window.addEventListener('beforeunload', (event) => {
  const status = activeRide.get()?.getView().status
  if (status === 'running' || status === 'autopaused' || status === 'paused') event.preventDefault()
})

// Closing or reloading the tab: save the latest state so nothing recorded is lost.
window.addEventListener('pagehide', () => {
  const session = activeRide.get()
  if (session && session.samples.length > 0 && session.getView().status !== 'finished') {
    saveActiveRide(session.snapshot())
  }
})

function attach(session: RideSession): void {
  activeRide.set(session)
  let lastSave = 0
  let lastTrainerStatus = connection.get().trainer.status
  startTicker(() => {
    session.tick()
    // After a reconnect the trainer has forgotten its target.
    const status = connection.get().trainer.status
    if (status === 'connected' && lastTrainerStatus !== 'connected') session.resendTarget()
    lastTrainerStatus = status
    const view = session.getView()
    if (view.status === 'finished') {
      // The workout ran to its end: store the ride right away, whatever page is open.
      void completeRide().then((id) => finishedRideId.set(id ?? 'none'))
      return
    }
    if (view.status !== 'ready' && Date.now() - lastSave > SAVE_EVERY_MS) {
      lastSave = Date.now()
      if (session.samples.length > 0) saveActiveRide(session.snapshot())
    }
  })
}

function detach(): void {
  stopTicker?.()
  stopTicker = null
  void wakeLock?.release().catch(() => undefined)
  wakeLock = null
  activeRide.set(null)
}

const options = () => ({ autoPause: settingsStore.get().autoPause })

/** Prepares a ride; it starts counting when `beginRide` is called. */
export function prepareRide(workout: Workout, profile: RiderProfile): void {
  attach(new RideSession(workout, profile, io, options()))
}

/** Picks up an interrupted ride, paused where it stopped. */
export function resumeRide(snapshot: RideSnapshot): void {
  attach(RideSession.restore(snapshot, io, options()))
}

/** Starts the clock. Call from a click, so sound and the wake lock are allowed. */
export function beginRide(): void {
  const session = activeRide.get()
  if (!session) return
  enableCues()
  session.start()
}

/** Call from a click before resuming, so sound and the wake lock are allowed. */
export function enableCues(): void {
  try {
    audio ??= new AudioContext()
    void audio.resume()
  } catch {
    audio = null
  }
  void keepScreenOn()
}

/** Ends the ride and stores it. Resolves to the saved ride's id, or null if nothing was recorded. */
export async function completeRide(): Promise<string | null> {
  const session = activeRide.get()
  if (!session) return null
  session.finish()
  detach()
  clearActiveRide()
  if (session.samples.length === 0) return null
  const ride = toSavedRide(session.snapshot())
  await saveRide(ride)
  return ride.id
}

/** Stores an interrupted ride as it is, without resuming it. */
export async function saveSnapshotAsRide(snapshot: RideSnapshot): Promise<string | null> {
  clearActiveRide()
  if (snapshot.samples.length === 0) return null
  const ride = toSavedRide(snapshot)
  await saveRide(ride)
  return ride.id
}

export function discardRide(): void {
  const session = activeRide.get()
  if (session) {
    session.finish()
    detach()
  }
  clearActiveRide()
}

function toSavedRide(snapshot: RideSnapshot): SavedRide {
  return {
    id: `ride-${snapshot.startTs}`,
    startTs: snapshot.startTs,
    workout: snapshot.workout,
    profile: snapshot.profile,
    intensity: snapshot.intensity,
    samples: snapshot.samples,
    summary: summarize(snapshot.samples, snapshot.profile.ftp),
  }
}

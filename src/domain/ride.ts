// A ride in progress: walks through the workout, tells the trainer the target,
// and records one sample per second. No browser or Bluetooth code in here; the
// surrounding app passes those in as `RideIO`, which keeps this testable.

import { bikeModel, stepSpeed, type BikeModel } from './physics.ts'
import { flatten, powerAt, segmentAt, totalDuration, type Segment, type Workout } from './workout.ts'

export interface RiderProfile {
  ftp: number
  weightKg: number
  maxHr: number | null
  thresholdHr: number | null
}

export interface RideSample {
  /** Seconds of riding time (pauses excluded), starting at 1. */
  t: number
  /** Wall-clock time of the sample, epoch ms. */
  ts: number
  /** Workout position in seconds when the sample was taken. */
  pos: number
  powerW: number | null
  targetW: number | null
  cadenceRpm: number | null
  hrBpm: number | null
  speedKph: number
  distanceM: number
  segment: number
}

export interface LiveReading {
  powerW: number | null
  cadenceRpm: number | null
  hrBpm: number | null
}

export interface RideIO {
  /** Current time, epoch ms. */
  now(): number
  /** Send an ERG target to the trainer; null releases it. */
  setTarget(watts: number | null): void
  /** Latest readings. */
  live(): LiveReading
  /** Readings averaged since the previous call, for the one-per-second record. */
  takeSecond(): LiveReading
  cue?(kind: 'countdown' | 'change' | 'finish'): void
}

export type RideStatus = 'ready' | 'running' | 'paused' | 'autopaused' | 'finished'

export interface RideView {
  status: RideStatus
  /** Workout position, seconds. */
  positionS: number
  /** Riding time, seconds. */
  activeS: number
  totalS: number
  segment: Segment | null
  next: Segment | null
  segmentRemainingS: number
  targetW: number | null
  /** Intensity adjustment, 1 = as planned. */
  intensity: number
  distanceM: number
  speedKph: number
  live: LiveReading
  /** Power averaged over the last 3 seconds. */
  power3s: number | null
  avgPowerW: number | null
  avgHrBpm: number | null
  workKJ: number
  sampleCount: number
}

/** Everything needed to resume a ride after a reload. */
export interface RideSnapshot {
  version: 1
  workout: Workout
  profile: RiderProfile
  startTs: number
  positionS: number
  activeS: number
  intensity: number
  distanceM: number
  speedMs: number
  samples: RideSample[]
  savedAt: number
}

export interface RideOptions {
  autoPause: boolean
}

const AUTO_PAUSE_BELOW_W = 5
const AUTO_PAUSE_AFTER_MS = 3000
const AUTO_RESUME_ABOVE_W = 20
/** While paused the target drops to this share of FTP, so restarting is easy. */
const PAUSE_TARGET = 0.5
/** A tick that arrives later than this is treated as a pause (sleeping laptop). */
const MAX_TICK_MS = 5000
const MIN_INTENSITY = 0.5
const MAX_INTENSITY = 1.5

export class RideSession {
  readonly workout: Workout
  readonly profile: RiderProfile
  readonly segments: Segment[]
  readonly totalS: number
  readonly samples: RideSample[] = []
  startTs = 0
  private readonly io: RideIO
  private readonly options: RideOptions
  private readonly model: BikeModel
  private status: RideStatus = 'ready'
  private positionS = 0
  private activeS = 0
  private intensity = 1
  private distanceM = 0
  private speedMs = 0
  private lastTick = 0
  private carryMs = 0
  private lowSince: number | null = null
  private lastSentW: number | null | undefined = undefined
  private lastSegment = -1
  private sumPower = 0
  private countPower = 0
  private sumHr = 0
  private countHr = 0
  private view: RideView
  private readonly listeners = new Set<() => void>()

  constructor(workout: Workout, profile: RiderProfile, io: RideIO, options: RideOptions) {
    this.workout = workout
    this.profile = profile
    this.io = io
    this.options = options
    this.segments = flatten(workout.blocks)
    this.totalS = totalDuration(this.segments)
    this.model = bikeModel(profile.weightKg)
    this.view = this.buildView()
  }

  /** Rebuilds a ride from a saved snapshot, paused where it stopped. */
  static restore(snapshot: RideSnapshot, io: RideIO, options: RideOptions): RideSession {
    const ride = new RideSession(snapshot.workout, snapshot.profile, io, options)
    ride.startTs = snapshot.startTs
    ride.positionS = snapshot.positionS
    ride.activeS = snapshot.activeS
    ride.intensity = snapshot.intensity
    ride.distanceM = snapshot.distanceM
    ride.speedMs = 0
    ride.samples.push(...snapshot.samples)
    for (const s of snapshot.samples) ride.addToAverages(s)
    ride.status = 'paused'
    ride.lastSegment = segmentAt(ride.segments, ride.positionS)?.index ?? -1
    ride.view = ride.buildView()
    return ride
  }

  snapshot(): RideSnapshot {
    return {
      version: 1,
      workout: this.workout,
      profile: this.profile,
      startTs: this.startTs,
      positionS: this.positionS,
      activeS: this.activeS,
      intensity: this.intensity,
      distanceM: this.distanceM,
      speedMs: this.speedMs,
      samples: this.samples,
      savedAt: this.io.now(),
    }
  }

  readonly getView = (): RideView => this.view

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(): void {
    if (this.status !== 'ready') return
    this.startTs = this.io.now()
    this.status = 'running'
    this.lastTick = this.io.now()
    this.lastSegment = 0
    this.sendTarget()
    this.emit()
  }

  pause(): void {
    if (this.status !== 'running' && this.status !== 'autopaused') return
    this.status = 'paused'
    this.sendTarget()
    this.emit()
  }

  resume(): void {
    if (this.status !== 'paused' && this.status !== 'autopaused') return
    this.status = 'running'
    this.lowSince = null
    this.lastTick = this.io.now()
    this.sendTarget()
    this.emit()
  }

  /** Jumps to the start of the next step, or finishes on the last one. */
  skip(): void {
    if (this.status === 'ready' || this.status === 'finished') return
    const segment = segmentAt(this.segments, this.positionS)
    this.positionS = segment ? segment.endS : this.totalS
    this.carryMs = 0
    if (this.positionS >= this.totalS) {
      this.finish()
      return
    }
    this.afterPositionChange()
    this.emit()
  }

  /** Jumps to the start of the step with this index, forwards or backwards. */
  jumpTo(index: number): void {
    if (this.status === 'ready' || this.status === 'finished') return
    const segment = this.segments[index]
    if (!segment) return
    this.positionS = segment.startS
    this.carryMs = 0
    this.afterPositionChange()
    this.emit()
  }

  /** Makes every remaining target harder or easier, in steps such as +0.05. */
  adjustIntensity(delta: number): void {
    const next = Math.round((this.intensity + delta) * 100) / 100
    this.intensity = Math.min(MAX_INTENSITY, Math.max(MIN_INTENSITY, next))
    this.sendTarget()
    this.emit()
  }

  finish(): void {
    if (this.status === 'finished') return
    this.status = 'finished'
    this.sendTarget()
    this.io.cue?.('finish')
    this.emit()
  }

  /** Advances the ride. Call a few times a second. */
  tick(): void {
    const now = this.io.now()
    const elapsed = now - this.lastTick
    this.lastTick = now
    if (this.status === 'ready' || this.status === 'finished' || this.status === 'paused') {
      this.emit()
      return
    }
    const live = this.io.live()
    if (this.status === 'autopaused') {
      if (live.powerW !== null && live.powerW >= AUTO_RESUME_ABOVE_W) {
        this.status = 'running'
        this.lowSince = null
        this.sendTarget()
      }
      this.emit()
      return
    }
    if (this.options.autoPause && live.powerW !== null && live.powerW < AUTO_PAUSE_BELOW_W) {
      this.lowSince ??= now
      if (now - this.lowSince >= AUTO_PAUSE_AFTER_MS) {
        this.status = 'autopaused'
        this.carryMs = 0
        this.sendTarget()
        this.emit()
        return
      }
    } else {
      this.lowSince = null
    }
    if (elapsed > 0 && elapsed <= MAX_TICK_MS) this.carryMs += elapsed
    const whole = Math.floor(this.carryMs / 1000)
    this.carryMs -= whole * 1000
    for (let i = 0; i < whole && this.status === 'running'; i++) {
      this.stepSecond(now - this.carryMs - (whole - 1 - i) * 1000)
    }
    this.emit()
  }

  private stepSecond(ts: number): void {
    const reading = this.io.takeSecond()
    const targetW = this.currentTargetW()
    const segment = segmentAt(this.segments, this.positionS)
    this.speedMs = stepSpeed(this.model, this.speedMs, reading.powerW ?? 0, 1)
    this.distanceM += this.speedMs
    this.activeS += 1
    this.positionS += 1
    const sample: RideSample = {
      t: this.activeS,
      ts,
      pos: this.positionS,
      powerW: reading.powerW === null ? null : Math.round(reading.powerW),
      targetW,
      cadenceRpm: reading.cadenceRpm === null ? null : Math.round(reading.cadenceRpm),
      hrBpm: reading.hrBpm === null ? null : Math.round(reading.hrBpm),
      speedKph: Math.round(this.speedMs * 36) / 10,
      distanceM: Math.round(this.distanceM * 10) / 10,
      segment: segment?.index ?? this.segments.length - 1,
    }
    this.samples.push(sample)
    this.addToAverages(sample)
    if (this.positionS >= this.totalS) {
      this.finish()
      return
    }
    this.afterPositionChange()
  }

  private afterPositionChange(): void {
    const segment = segmentAt(this.segments, this.positionS)
    if (!segment) return
    if (segment.index !== this.lastSegment) {
      this.lastSegment = segment.index
      this.io.cue?.('change')
    } else {
      const left = segment.endS - this.positionS
      if (left >= 1 && left <= 3 && segment.durationS >= 10) this.io.cue?.('countdown')
    }
    this.sendTarget()
  }

  private addToAverages(s: RideSample): void {
    if (s.powerW !== null) {
      this.sumPower += s.powerW
      this.countPower++
    }
    if (s.hrBpm !== null) {
      this.sumHr += s.hrBpm
      this.countHr++
    }
  }

  /** The planned target right now in watts, with the intensity adjustment applied. */
  private currentTargetW(): number | null {
    const segment = segmentAt(this.segments, this.positionS)
    if (!segment) return null
    return Math.round(powerAt(segment, this.positionS) * this.profile.ftp * this.intensity)
  }

  private sendTarget(): void {
    let watts: number | null
    if (this.status === 'finished' || this.status === 'ready') {
      watts = null
    } else {
      const planned = this.currentTargetW()
      const paused = this.status === 'paused' || this.status === 'autopaused'
      watts = planned === null ? null : paused ? Math.min(planned, Math.round(this.profile.ftp * PAUSE_TARGET)) : planned
    }
    if (watts === this.lastSentW) return
    this.lastSentW = watts
    this.io.setTarget(watts)
  }

  /** Sends the current target again, for when the trainer reconnected. */
  resendTarget(): void {
    this.lastSentW = undefined
    this.sendTarget()
  }

  private buildView(): RideView {
    const segment = segmentAt(this.segments, this.positionS)
    const next = segment ? (this.segments[segment.index + 1] ?? null) : null
    const recent = this.samples.slice(-3).filter((s) => s.powerW !== null)
    return {
      status: this.status,
      positionS: this.positionS,
      activeS: this.activeS,
      totalS: this.totalS,
      segment,
      next,
      segmentRemainingS: segment ? segment.endS - this.positionS : 0,
      targetW: this.status === 'finished' ? null : this.currentTargetW(),
      intensity: this.intensity,
      distanceM: this.distanceM,
      speedKph: this.speedMs * 3.6,
      live: this.io.live(),
      power3s: recent.length ? Math.round(recent.reduce((a, s) => a + (s.powerW ?? 0), 0) / recent.length) : null,
      avgPowerW: this.countPower ? Math.round(this.sumPower / this.countPower) : null,
      avgHrBpm: this.countHr ? Math.round(this.sumHr / this.countHr) : null,
      workKJ: this.sumPower / 1000,
      sampleCount: this.samples.length,
    }
  }

  private emit(): void {
    this.view = this.buildView()
    for (const listener of this.listeners) listener()
  }
}

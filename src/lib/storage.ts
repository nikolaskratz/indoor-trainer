// Everything the app keeps on this device. Small things live in localStorage;
// finished rides (thousands of samples each) live in IndexedDB.
//
// The device copy is what the app works from, so it runs without a network. When the
// user is signed in, lib/sync.ts mirrors it to their account. For that, every change
// made here is stamped with its time, deletions leave a marker, and `onLocalChange`
// tells the sync to run. The `cloudLocal` functions at the end are the sync's own way
// in: they write what came from the account without stamping it as a new change.

import type { RideSummary } from '../domain/metrics.ts'
import type { RiderProfile, RideSample, RideSnapshot } from '../domain/ride.ts'
import type { Entry } from '../domain/sync.ts'
import type { Workout } from '../domain/workout.ts'
import { Store } from './store.ts'

export interface Settings {
  sound: boolean
  autoPause: boolean
}

export interface SavedRide {
  id: string
  startTs: number
  workout: Workout
  profile: RiderProfile
  intensity: number
  samples: RideSample[]
  summary: RideSummary
  /** Set once the ride was uploaded to Strava. */
  stravaActivityId?: number
  /** Time of the last change, epoch ms; used to sync between browsers. */
  updatedAt?: number
}

const KEY = {
  profile: 'it.profile',
  settings: 'it.settings',
  workouts: 'it.workouts',
  activeRide: 'it.ride.active',
  sync: 'it.sync',
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : { ...fallback, ...JSON.parse(raw) }
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage full or blocked: the app keeps working from memory.
  }
}

/** What the sync needs to know beyond the data itself. */
interface SyncMeta {
  /** Time of the last change to profile or settings; 0 = never changed since sync exists. */
  profileAt: number
  /** Deleted items and when they were deleted, until the account knows. */
  deletedWorkouts: Record<string, number>
  deletedRides: Record<string, number>
  /** Saved rides and the time of their last change; null until built from the ride database. */
  rides: Record<string, number> | null
}
const meta = read<SyncMeta>(KEY.sync, { profileAt: 0, deletedWorkouts: {}, deletedRides: {}, rides: null })
const saveMeta = (): void => write(KEY.sync, meta)

const changeListeners = new Set<() => void>()
/** Calls `listener` after every change the user made on this device. */
export function onLocalChange(listener: () => void): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}
const changed = (): void => {
  for (const listener of changeListeners) listener()
}

/** True while data from the account is being written, which is not a change by the user. */
let fromCloud = false
function profileChanged(): void {
  if (fromCloud) return
  meta.profileAt = Date.now()
  saveMeta()
  changed()
}

export interface ProfileForm {
  ftp: number | null
  weightKg: number | null
  maxHr: number | null
  thresholdHr: number | null
}

export const profileStore = new Store<ProfileForm>(
  read<ProfileForm>(KEY.profile, { ftp: null, weightKg: null, maxHr: null, thresholdHr: null }),
)
profileStore.subscribe(() => {
  write(KEY.profile, profileStore.get())
  profileChanged()
})

/** The profile as the ride needs it; null until FTP and weight are entered. */
export function riderProfile(p: ProfileForm): RiderProfile | null {
  if (!p.ftp || !p.weightKg) return null
  return { ftp: p.ftp, weightKg: p.weightKg, maxHr: p.maxHr, thresholdHr: p.thresholdHr }
}

export const settingsStore = new Store<Settings>(read<Settings>(KEY.settings, { sound: true, autoPause: true }))
settingsStore.subscribe(() => {
  write(KEY.settings, settingsStore.get())
  profileChanged()
})

function readWorkouts(): Workout[] {
  try {
    const raw = localStorage.getItem(KEY.workouts)
    const list: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? (list as Workout[]) : []
  } catch {
    return []
  }
}

/** Workouts the user generated or saved, newest first. Change it with saveWorkout and removeWorkout. */
export const workoutStore = new Store<Workout[]>(readWorkouts())
workoutStore.subscribe(() => write(KEY.workouts, workoutStore.get()))

const workoutAt = (w: Workout): number => w.updatedAt ?? (Date.parse(w.createdAt) || 0)

/** Adds a workout, or replaces the one with the same id. */
export function saveWorkout(workout: Workout): Workout {
  const stamped = { ...workout, updatedAt: Date.now() }
  workoutStore.set((list) =>
    list.some((w) => w.id === stamped.id) ? list.map((w) => (w.id === stamped.id ? stamped : w)) : [stamped, ...list],
  )
  delete meta.deletedWorkouts[stamped.id]
  saveMeta()
  changed()
  return stamped
}

export function removeWorkout(id: string): void {
  workoutStore.set((list) => list.filter((w) => w.id !== id))
  meta.deletedWorkouts[id] = Date.now()
  saveMeta()
  changed()
}

// The ride in progress, saved every few seconds so a reload or crash loses nothing.
export function saveActiveRide(snapshot: RideSnapshot): void {
  write(KEY.activeRide, snapshot)
}

export function loadActiveRide(): RideSnapshot | null {
  try {
    const raw = localStorage.getItem(KEY.activeRide)
    if (!raw) return null
    const snapshot = JSON.parse(raw) as RideSnapshot
    return snapshot.version === 1 && Array.isArray(snapshot.samples) ? snapshot : null
  } catch {
    return null
  }
}

export function clearActiveRide(): void {
  localStorage.removeItem(KEY.activeRide)
}

const DB_NAME = 'indoor-trainer'
const RIDES = 'rides'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(RIDES, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open the ride database'))
  })
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(RIDES, mode)
        const request = run(transaction.objectStore(RIDES))
        transaction.oncomplete = () => {
          db.close()
          resolve(request.result)
        }
        transaction.onerror = () => {
          db.close()
          reject(transaction.error ?? new Error('Ride database error'))
        }
      }),
  )
}

/** Counts up whenever the saved rides change, so lists can reload. */
export const ridesVersion = new Store(0)

const rideAt = (r: SavedRide): number => r.updatedAt ?? r.startTs

/** Saved rides and their last change. Built once from the ride database, then kept up to date. */
async function rideTimes(): Promise<Record<string, number>> {
  if (!meta.rides) {
    const rides = await tx<SavedRide[]>('readonly', (s) => s.getAll())
    meta.rides = Object.fromEntries(rides.map((r) => [r.id, rideAt(r)]))
    saveMeta()
  }
  return meta.rides
}

async function putRide(ride: SavedRide): Promise<void> {
  const times = await rideTimes()
  await tx('readwrite', (s) => s.put(ride))
  times[ride.id] = rideAt(ride)
  delete meta.deletedRides[ride.id]
  saveMeta()
  ridesVersion.set((v) => v + 1)
}

async function dropRide(id: string): Promise<void> {
  const times = await rideTimes()
  await tx('readwrite', (s) => s.delete(id))
  delete times[id]
  saveMeta()
  ridesVersion.set((v) => v + 1)
}

/** Stores a ride, new or changed. */
export async function saveRide(ride: SavedRide): Promise<SavedRide> {
  const stamped = { ...ride, updatedAt: Date.now() }
  await putRide(stamped)
  changed()
  return stamped
}

export const loadRide = (id: string): Promise<SavedRide | undefined> => tx('readonly', (s) => s.get(id))

export async function deleteRide(id: string): Promise<void> {
  await dropRide(id)
  meta.deletedRides[id] = Date.now()
  saveMeta()
  changed()
}

/** All saved rides, newest first. */
export async function listRides(): Promise<SavedRide[]> {
  const rides = await tx<SavedRide[]>('readonly', (s) => s.getAll())
  return rides.sort((a, b) => b.startTs - a.startTs)
}

const tombstones = (deleted: Record<string, number>): Entry[] =>
  Object.entries(deleted).map(([id, at]) => ({ id, at, deleted: true }))

export interface CloudProfile {
  profile: ProfileForm
  settings: Settings
}

/** The device copy as the account sync sees it. Nothing in here counts as a change by the user. */
export const cloudLocal = {
  profile(): { at: number; data: CloudProfile } {
    return { at: meta.profileAt, data: { profile: profileStore.get(), settings: settingsStore.get() } }
  },
  /** Marks the profile as changed now; for a profile that predates the sync. */
  stampProfile(): number {
    meta.profileAt = Date.now()
    saveMeta()
    return meta.profileAt
  },
  setProfile(data: CloudProfile, at: number): void {
    fromCloud = true
    try {
      profileStore.set({ ...profileStore.get(), ...data.profile })
      settingsStore.set({ ...settingsStore.get(), ...data.settings })
    } finally {
      fromCloud = false
    }
    meta.profileAt = at
    saveMeta()
  },

  workoutIndex(): Entry[] {
    const live = workoutStore.get().map((w) => ({ id: w.id, at: workoutAt(w), deleted: false }))
    return [...live, ...tombstones(meta.deletedWorkouts)]
  },
  workoutDeletedAt: (id: string): number => meta.deletedWorkouts[id] ?? Date.now(),
  /** Adds or replaces workouts that came from the account. */
  putWorkouts(workouts: Workout[]): void {
    if (workouts.length === 0) return
    const incoming = new Map(workouts.map((w) => [w.id, w]))
    workoutStore.set((list) =>
      [...list.filter((w) => !incoming.has(w.id)), ...workouts].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    )
    for (const id of incoming.keys()) delete meta.deletedWorkouts[id]
    saveMeta()
  },
  dropWorkouts(ids: string[]): void {
    if (ids.length === 0) return
    const gone = new Set(ids)
    workoutStore.set((list) => list.filter((w) => !gone.has(w.id)))
  },
  forgetDeletedWorkouts(ids: string[]): void {
    for (const id of ids) delete meta.deletedWorkouts[id]
    saveMeta()
  },

  async rideIndex(): Promise<Entry[]> {
    const live = Object.entries(await rideTimes()).map(([id, at]) => ({ id, at, deleted: false }))
    return [...live, ...tombstones(meta.deletedRides)]
  },
  rideDeletedAt: (id: string): number => meta.deletedRides[id] ?? Date.now(),
  putRide,
  dropRide,
  forgetDeletedRides(ids: string[]): void {
    for (const id of ids) delete meta.deletedRides[id]
    saveMeta()
  },
}

// Everything the app keeps on this device. Small things live in localStorage;
// finished rides (thousands of samples each) live in IndexedDB.

import type { RideSummary } from '../domain/metrics.ts'
import type { RiderProfile, RideSample, RideSnapshot } from '../domain/ride.ts'
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
}

const KEY = {
  profile: 'it.profile',
  settings: 'it.settings',
  workouts: 'it.workouts',
  activeRide: 'it.ride.active',
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

export interface ProfileForm {
  ftp: number | null
  weightKg: number | null
  maxHr: number | null
  thresholdHr: number | null
}

export const profileStore = new Store<ProfileForm>(
  read<ProfileForm>(KEY.profile, { ftp: null, weightKg: null, maxHr: null, thresholdHr: null }),
)
profileStore.subscribe(() => write(KEY.profile, profileStore.get()))

/** The profile as the ride needs it; null until FTP and weight are entered. */
export function riderProfile(p: ProfileForm): RiderProfile | null {
  if (!p.ftp || !p.weightKg) return null
  return { ftp: p.ftp, weightKg: p.weightKg, maxHr: p.maxHr, thresholdHr: p.thresholdHr }
}

export const settingsStore = new Store<Settings>(read<Settings>(KEY.settings, { sound: true, autoPause: true }))
settingsStore.subscribe(() => write(KEY.settings, settingsStore.get()))

function readWorkouts(): Workout[] {
  try {
    const raw = localStorage.getItem(KEY.workouts)
    const list: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? (list as Workout[]) : []
  } catch {
    return []
  }
}

/** Workouts the user generated or saved, newest first. */
export const workoutStore = new Store<Workout[]>(readWorkouts())
workoutStore.subscribe(() => write(KEY.workouts, workoutStore.get()))

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

export const saveRide = (ride: SavedRide): Promise<unknown> => tx('readwrite', (s) => s.put(ride))
export const loadRide = (id: string): Promise<SavedRide | undefined> => tx('readonly', (s) => s.get(id))
export const deleteRide = (id: string): Promise<unknown> => tx('readwrite', (s) => s.delete(id))

/** All saved rides, newest first. */
export async function listRides(): Promise<SavedRide[]> {
  const rides = await tx<SavedRide[]>('readonly', (s) => s.getAll())
  return rides.sort((a, b) => b.startTs - a.startTs)
}

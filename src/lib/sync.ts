// Mirrors profile, workouts and rides to the signed-in account, so they survive a
// cleared browser and show up on another computer.
//
// The device copy stays in charge: the app reads and writes local storage only, and
// this module reconciles it with the account in the background. Per item, the side
// that changed it last wins (see domain/sync.ts). Without a sign-in nothing is sent.
//
// Several people can have an account, so two rules keep their data apart: the server
// only hands out and accepts an account's own rows, and a browser that already holds
// one account's data exchanges nothing with another account until the user says so.
//
// Tables (supabase/migrations): turbo_profile, turbo_workouts, turbo_rides.

import { packSamples, planSync, unpackSamples, type Entry } from '../domain/sync.ts'
import type { Workout } from '../domain/workout.ts'
import { accessStore, refreshAccess, sessionStore, supabase } from './cloud.ts'
import { cloudLocal, loadRide, onLocalChange, workoutStore, type CloudProfile, type SavedRide } from './storage.ts'
import { Store } from './store.ts'

export interface SyncState {
  /**
   * off: not signed in. noaccess: signed in, but the owner has not let this account in yet.
   * otheraccount: this browser holds another account's data, so nothing is exchanged.
   */
  status: 'off' | 'idle' | 'syncing' | 'error' | 'noaccess' | 'otheraccount'
  /** When everything was last known to be in the account, epoch ms. */
  lastSyncedAt: number | null
  error: string | null
  /** What a long sync is busy with, e.g. "Uploading rides: 2 of 5". */
  progress: string | null
}

export const syncStore = new Store<SyncState>({ status: 'off', lastSyncedAt: null, error: null, progress: null })

const DEBOUNCE_MS = 1500
const RETRY_MS = 60_000
const REFRESH_AFTER_MS = 60_000
const CHUNK = 50

const iso = (ms: number): string => new Date(ms).toISOString()

type Result<T> = PromiseLike<{ data: T | null; error: { message: string } | null }>
async function must<T>(query: Result<T>): Promise<T> {
  const { data, error } = await query
  if (error) throw new Error(error.message)
  return data as T
}

type IndexRow = { id: string; updated_at: string; deleted: boolean }
const toEntry = (row: IndexRow): Entry => ({ id: row.id, at: Date.parse(row.updated_at), deleted: row.deleted })

const progress = (text: string | null): void => syncStore.set((s) => ({ ...s, progress: text }))

async function syncProfile(): Promise<void> {
  const rows = await must<{ data: CloudProfile; updated_at: string }[]>(
    supabase.from('turbo_profile').select('data,updated_at'),
  )
  const remote = rows[0]
  const remoteAt = remote ? Date.parse(remote.updated_at) : 0
  const local = cloudLocal.profile()
  if (remote && remoteAt > local.at) {
    if (remote.data?.profile && remote.data.settings) cloudLocal.setProfile(remote.data, remoteAt)
    return
  }
  // Nothing entered here yet: nothing worth saving.
  if (!Object.values(local.data.profile).some((v) => v !== null)) return
  if (remote && local.at <= remoteAt) return
  const at = local.at || cloudLocal.stampProfile()
  await must(supabase.from('turbo_profile').upsert({ data: local.data, updated_at: iso(at) }, { onConflict: 'user_id' }))
}

async function syncWorkouts(): Promise<void> {
  const remote = await must<IndexRow[]>(supabase.from('turbo_workouts').select('id,updated_at,deleted'))
  const plan = planSync(cloudLocal.workoutIndex(), remote.map(toEntry))

  for (let i = 0; i < plan.pull.length; i += CHUNK) {
    const rows = await must<{ id: string; data: Workout | null; updated_at: string }[]>(
      supabase
        .from('turbo_workouts')
        .select('id,data,updated_at')
        .in('id', plan.pull.slice(i, i + CHUNK)),
    )
    cloudLocal.putWorkouts(
      rows
        .filter((r) => r.data && Array.isArray(r.data.blocks))
        .map((r) => ({ ...(r.data as Workout), id: r.id, updatedAt: Date.parse(r.updated_at) })),
    )
  }
  cloudLocal.dropWorkouts(plan.dropLocal)

  const byId = new Map(workoutStore.get().map((w) => [w.id, w]))
  const rows = [
    ...plan.push.flatMap((id) => {
      const w = byId.get(id)
      return w ? [{ id, data: w as Workout | null, updated_at: iso(w.updatedAt ?? (Date.parse(w.createdAt) || 0)), deleted: false }] : []
    }),
    ...plan.pushDeleted.map((id) => ({ id, data: null, updated_at: iso(cloudLocal.workoutDeletedAt(id)), deleted: true })),
  ]
  for (let i = 0; i < rows.length; i += CHUNK) {
    await must(supabase.from('turbo_workouts').upsert(rows.slice(i, i + CHUNK), { onConflict: 'user_id,id' }))
  }
  cloudLocal.forgetDeletedWorkouts([...plan.forget, ...plan.pushDeleted])
}

type RideRow = { id: string; data: Omit<SavedRide, 'samples'> | null; samples: unknown; updated_at: string }

async function syncRides(): Promise<void> {
  const remote = await must<IndexRow[]>(supabase.from('turbo_rides').select('id,updated_at,deleted'))
  const plan = planSync(await cloudLocal.rideIndex(), remote.map(toEntry))

  // Rides are large (one sample per second), so they travel one at a time.
  for (const [n, id] of plan.pull.entries()) {
    progress(`Downloading rides: ${n + 1} of ${plan.pull.length}`)
    const rows = await must<RideRow[]>(supabase.from('turbo_rides').select('id,data,samples,updated_at').eq('id', id))
    const row = rows[0]
    const samples = row ? unpackSamples(row.samples) : null
    if (!row?.data || !samples) continue
    await cloudLocal.putRide({ ...row.data, id: row.id, samples, updatedAt: Date.parse(row.updated_at) })
  }
  for (const id of plan.dropLocal) await cloudLocal.dropRide(id)

  for (const [n, id] of plan.push.entries()) {
    progress(`Uploading rides: ${n + 1} of ${plan.push.length}`)
    const ride = await loadRide(id)
    if (!ride) continue
    const { samples, ...data } = ride
    await must(
      supabase.from('turbo_rides').upsert(
        {
          id,
          start_ts: iso(ride.startTs),
          data,
          samples: packSamples(samples),
          updated_at: iso(ride.updatedAt ?? ride.startTs),
          deleted: false,
        },
        { onConflict: 'user_id,id' },
      ),
    )
  }
  if (plan.pushDeleted.length) {
    await must(
      supabase.from('turbo_rides').upsert(
        plan.pushDeleted.map((id) => ({
          id,
          start_ts: null,
          data: null,
          samples: null,
          updated_at: iso(cloudLocal.rideDeletedAt(id)),
          deleted: true,
        })),
        { onConflict: 'user_id,id' },
      ),
    )
  }
  cloudLocal.forgetDeletedRides([...plan.forget, ...plan.pushDeleted])
  progress(null)
}

let timer: ReturnType<typeof setTimeout> | undefined
let running = false
let again = false
let recheckAccess = false

const stopped = (status: 'noaccess' | 'otheraccount'): void =>
  syncStore.set({ status, lastSyncedAt: null, error: null, progress: null })

async function run(): Promise<void> {
  const user = sessionStore.get()?.user.id
  if (!user) return
  if (running) {
    again = true
    return
  }
  running = true
  try {
    const known = accessStore.get()
    const access = !recheckAccess && (known === 'owner' || known === 'member') ? known : await refreshAccess()
    recheckAccess = false
    if (sessionStore.get()?.user.id !== user) return
    if (access === 'none') return stopped('noaccess')
    const holder = cloudLocal.owner()
    if (holder && holder !== user) return stopped('otheraccount')
    cloudLocal.setOwner(user)
    syncStore.set((s) => ({ ...s, status: 'syncing', error: null }))
    await syncProfile()
    await syncWorkouts()
    await syncRides()
    syncStore.set({ status: 'idle', lastSyncedAt: Date.now(), error: null, progress: null })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    syncStore.set((s) => ({ ...s, status: 'error', error: message, progress: null }))
    // The server also refuses an account whose access was taken away: ask again next time.
    recheckAccess = true
    // Try again later on its own: the usual cause is a dropped connection.
    again = false
    requestSync(RETRY_MS)
  } finally {
    running = false
    if (again) {
      again = false
      requestSync(DEBOUNCE_MS)
    }
  }
}

/** Syncs soon. Calls made while waiting collapse into one sync. */
export function requestSync(delayMs = DEBOUNCE_MS): void {
  if (!sessionStore.get()) return
  clearTimeout(timer)
  timer = setTimeout(() => void run(), delayMs)
}

/**
 * Hands this browser to the signed-in account: deletes the data it holds (another
 * account's) and loads the signed-in account's instead.
 */
export async function switchBrowserToThisAccount(): Promise<void> {
  const user = sessionStore.get()?.user.id
  if (!user || syncStore.get().status !== 'otheraccount') return
  await cloudLocal.replaceWith(user)
  requestSync(0)
}

let started = false
/** Hooks the sync up to sign-in, local changes and the tab coming back. Call once at startup. */
export function startSync(): void {
  if (started) return
  started = true
  let userId: string | null = null
  const onSession = (): void => {
    const session = sessionStore.get()
    if (!session) {
      if (session === null) {
        userId = null
        clearTimeout(timer)
        syncStore.set({ status: 'off', lastSyncedAt: null, error: null, progress: null })
      }
      return
    }
    // The session object is replaced on every token refresh; only a sign-in needs a sync.
    if (session.user.id === userId) return
    userId = session.user.id
    requestSync(0)
  }
  sessionStore.subscribe(onSession)
  onSession()
  onLocalChange(() => requestSync())
  const refresh = (): void => {
    const last = syncStore.get().lastSyncedAt
    if (document.visibilityState === 'visible' && (last === null || Date.now() - last > REFRESH_AFTER_MS)) requestSync(0)
  }
  document.addEventListener('visibilitychange', refresh)
  window.addEventListener('online', () => requestSync(0))
}

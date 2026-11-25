// Strava: connect the account once, then upload finished rides.
// All talking to Strava happens in the turbo-strava edge function; the browser
// only ever sees the public client id.

import { FunctionsHttpError } from '@supabase/supabase-js'
import { buildTcx } from '../domain/tcx.ts'
import { flatten } from '../domain/workout.ts'
import { sessionStore, supabase } from './cloud.ts'
import { saveRide, type SavedRide } from './storage.ts'
import { Store } from './store.ts'

export type StravaState =
  | { kind: 'unknown' }
  /** Not signed in to the app, so Strava cannot be asked. */
  | { kind: 'signed-out' }
  /** The server side is missing or has no Strava credentials yet. */
  | { kind: 'unavailable' }
  | { kind: 'disconnected'; clientId: string }
  | { kind: 'connected'; clientId: string; athlete: string | null }

export const stravaStore = new Store<StravaState>({ kind: 'unknown' })
/** Result of the last connect attempt, shown once. */
export const stravaNotice = new Store<{ ok: boolean; text: string } | null>(null)

const STATE_KEY = 'it.strava.state'
const RETURN_KEY = 'it.strava.return'

async function call<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.functions.invoke('turbo-strava', { body: { action, ...body } })
  if (error) {
    let message = 'Strava could not be reached. Check your connection and try again.'
    if (error instanceof FunctionsHttpError) {
      try {
        const payload = (await (error.context as Response).json()) as { error?: string }
        message = payload.error ?? 'Strava returned an error.'
      } catch {
        message = 'Strava upload is not available.'
      }
    }
    throw new Error(message)
  }
  return data as T
}

/** Asks the server whether Strava is set up and connected. */
export async function refreshStrava(): Promise<void> {
  if (!sessionStore.get()) {
    stravaStore.set({ kind: 'signed-out' })
    return
  }
  try {
    const s = await call<{ configured: boolean; clientId?: string; connected: boolean; athlete?: string | null }>('status')
    if (!s.configured || !s.clientId) stravaStore.set({ kind: 'unavailable' })
    else if (s.connected) stravaStore.set({ kind: 'connected', clientId: s.clientId, athlete: s.athlete ?? null })
    else stravaStore.set({ kind: 'disconnected', clientId: s.clientId })
  } catch {
    stravaStore.set({ kind: 'unavailable' })
  }
}

// Ask again whenever the sign-in state changes, and now if it is already known.
sessionStore.subscribe(() => {
  if (sessionStore.get() !== undefined) void refreshStrava()
})
if (sessionStore.get() !== undefined) void refreshStrava()

/** The page Strava sends the user back to: the app's own address without query or hash. */
const redirectUri = (): string => `${location.origin}${location.pathname}`

/** Sends the browser to Strava's permission page. Comes back via `finishStravaConnect`. */
export function startStravaConnect(clientId: string): void {
  const state = crypto.randomUUID()
  sessionStorage.setItem(STATE_KEY, state)
  sessionStorage.setItem(RETURN_KEY, location.hash)
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    approval_prompt: 'auto',
    scope: 'activity:write',
    state,
  })
  location.href = `https://www.strava.com/oauth/authorize?${query}`
}

/**
 * Call once when the app starts. If Strava just sent the user back, finishes the
 * connection and restores the page they came from.
 */
export async function finishStravaConnect(): Promise<void> {
  const query = new URLSearchParams(location.search)
  const state = query.get('state')
  const expected = sessionStorage.getItem(STATE_KEY)
  if (!state || !expected || (!query.has('code') && !query.has('error'))) return
  const returnTo = sessionStorage.getItem(RETURN_KEY) ?? ''
  sessionStorage.removeItem(STATE_KEY)
  sessionStorage.removeItem(RETURN_KEY)
  // Take Strava's parameters out of the address so a reload does not repeat this.
  history.replaceState(null, '', `${location.pathname}${returnTo}`)
  window.dispatchEvent(new HashChangeEvent('hashchange'))
  if (state !== expected) {
    stravaNotice.set({ ok: false, text: 'The answer from Strava did not match this browser session. Try connecting again.' })
    return
  }
  const code = query.get('code')
  if (!code) {
    stravaNotice.set({ ok: false, text: 'Strava was not connected: the request was declined.' })
    return
  }
  try {
    // The sign-in is restored from storage in the background; wait for it.
    await supabase.auth.getSession()
    const result = await call<{ athlete: string | null }>('exchange', { code })
    stravaNotice.set({ ok: true, text: `Strava connected${result.athlete ? ` as ${result.athlete}` : ''}.` })
  } catch (e) {
    stravaNotice.set({ ok: false, text: e instanceof Error ? e.message : String(e) })
  }
  await refreshStrava()
}

export async function disconnectStrava(): Promise<void> {
  await call('disconnect')
  await refreshStrava()
}

export function rideTcx(ride: SavedRide): string {
  return buildTcx({
    name: ride.workout.name,
    notes: `${ride.workout.name}. ${ride.workout.description}`,
    startTs: ride.startTs,
    samples: ride.samples,
    segments: flatten(ride.workout.blocks),
  })
}

function rideDescription(ride: SavedRide): string {
  const s = ride.summary
  const facts = [
    s.normalizedPowerW !== null && `NP ${s.normalizedPowerW} W`,
    s.intensityFactor !== null && `IF ${s.intensityFactor.toFixed(2)}`,
    s.tss !== null && `TSS ${s.tss}`,
  ].filter(Boolean)
  return [ride.workout.description, facts.join(' · '), 'Ridden with Indoor Trainer'].filter(Boolean).join('\n')
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const POLL_MS = 1500
const POLL_TIMES = 40

/**
 * Uploads a ride and waits until Strava has turned it into an activity.
 * Resolves to the activity id and stores it with the ride. Throws an Error with a readable message.
 */
export async function uploadRide(ride: SavedRide, onProgress: (text: string) => void): Promise<number> {
  onProgress('Sending the ride to Strava…')
  const started = await call<{ uploadId: string; error: string | null }>('upload', {
    tcx: rideTcx(ride),
    name: ride.workout.name,
    description: rideDescription(ride),
    externalId: ride.id,
  })
  let error = started.error
  let activityId: number | null = null
  for (let i = 0; i < POLL_TIMES && !error && activityId === null; i++) {
    onProgress('Strava is processing the ride…')
    await sleep(POLL_MS)
    const check = await call<{ status: string | null; error: string | null; activityId: number | null }>('check', {
      uploadId: started.uploadId,
    })
    error = check.error
    activityId = check.activityId
  }
  if (activityId === null && error) {
    // Strava refuses a second upload of the same ride and names the existing activity.
    const duplicate = /duplicate of (?:<a [^>]*>)?activity (\d+)/i.exec(error) ?? /activities\/(\d+)/.exec(error)
    if (!duplicate) throw new Error(`Strava rejected the ride: ${error.replace(/<[^>]+>/g, '')}`)
    activityId = Number(duplicate[1])
  }
  if (activityId === null) throw new Error('Strava is taking unusually long. Check strava.com in a minute before trying again.')
  await saveRide({ ...ride, stravaActivityId: activityId })
  return activityId
}

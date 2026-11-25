// The app's link to Supabase: accounts, who has access, and the workout generator.
// Shares the tri-coach Supabase project and its logins.

import { createClient, FunctionsHttpError, type Session } from '@supabase/supabase-js'
import type { RiderProfile } from '../domain/ride.ts'
import { validateWorkout, type Block, type Workout } from '../domain/workout.ts'
import { Store } from './store.ts'

// Publishable key: safe to ship in the client; the server checks who is calling.
const SUPABASE_URL = 'https://adagtmentbsommzgbona.supabase.co'
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_yoZdCAzH5KaEMGIL1Lm1VQ_E1hwqh1x'

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY)

/** undefined while the stored session is still being read, null when signed out. */
export const sessionStore = new Store<Session | null | undefined>(undefined)
void supabase.auth.getSession().then(({ data }) => sessionStore.set(data.session))
supabase.auth.onAuthStateChange((_event, session) => sessionStore.set(session))

/** Resolves to an error message, or null when the sign-in worked. */
export async function signIn(email: string, password: string): Promise<string | null> {
  const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
  return error ? error.message : null
}

/**
 * Creates an account. Resolves to an error message, to 'confirm' when the address has to
 * be confirmed by email before the first sign-in, or to null when the user is now signed in.
 */
export async function signUp(email: string, password: string): Promise<string | null> {
  const { data, error } = await supabase.auth.signUp({ email: email.trim(), password })
  if (error) return error.message
  return data.session ? null : 'confirm'
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut()
}

/**
 * What the signed-in account may do on the server: the owner runs the app and decides who
 * else gets in, a member was let in by the owner, 'none' has an account but no access yet.
 * Everyone gets only their own data. null while signed out or not yet known.
 */
export type Access = 'owner' | 'member' | 'none'
export const accessStore = new Store<Access | null>(null)

let accessCheck: { user: string; result: Promise<Access> } | null = null

/** Asks the server what the signed-in account may do. Throws when it cannot be reached. */
export function refreshAccess(): Promise<Access> {
  const user = sessionStore.get()?.user.id
  if (!user) return Promise.resolve('none')
  if (accessCheck?.user === user) return accessCheck.result
  const result = (async (): Promise<Access> => {
    try {
      const { data, error } = await supabase.rpc('turbo_access')
      if (error) throw new Error(error.message)
      const access: Access = data === 'owner' || data === 'member' ? data : 'none'
      if (sessionStore.get()?.user.id === user) accessStore.set(access)
      return access
    } finally {
      accessCheck = null
    }
  })()
  accessCheck = { user, result }
  return result
}

let accessUser: string | null = null
sessionStore.subscribe(() => {
  const user = sessionStore.get()?.user.id ?? null
  if (user === accessUser) return
  accessUser = user
  accessStore.set(null)
  // A failure here is retried by the sync, which needs the answer too.
  if (user) void refreshAccess().catch(() => undefined)
})

type Generated = { name: string; description: string; blocks: Block[] }

/** Calls the workout generator. Throws an Error with a readable message. */
async function callGenerator(body: { prompt: string; profile: RiderProfile; base?: unknown }): Promise<Generated> {
  const { data, error } = await supabase.functions.invoke('turbo-workout', { body })
  if (error) {
    let message = 'The workout generator could not be reached. Check your connection and try again.'
    if (error instanceof FunctionsHttpError) {
      try {
        const body = (await (error.context as Response).json()) as { error?: string }
        if (body.error) message = body.error
      } catch {
        message = 'The workout generator returned an error.'
      }
    }
    throw new Error(message)
  }
  const result = (data as { workout?: Generated }).workout
  if (!result || !Array.isArray(result.blocks)) throw new Error('The workout generator returned nothing usable.')
  const problems = validateWorkout(result.blocks)
  if (problems.length) throw new Error(`The generated workout is not usable: ${problems[0]}`)
  return { name: result.name, description: result.description, blocks: result.blocks }
}

const newId = () => `w-${Date.now().toString(36)}`

/** Asks the server to build a workout from a description. Throws an Error with a readable message. */
export async function generateWorkout(prompt: string, profile: RiderProfile): Promise<Workout> {
  const result = await callGenerator({ prompt, profile })
  return { id: newId(), ...result, source: 'prompt', prompt, createdAt: new Date().toISOString() }
}

/**
 * Asks the server to apply a change ("make the warm-up shorter") to a workout.
 * A workout of the user's own comes back changed under the same id; a built-in one comes
 * back as a new workout, since built-ins cannot be edited. Throws an Error with a readable message.
 */
export async function reviseWorkout(workout: Workout, change: string, profile: RiderProfile): Promise<Workout> {
  const result = await callGenerator({
    prompt: change,
    profile,
    base: {
      name: workout.name,
      description: workout.description,
      blocks: workout.blocks,
      prompt: workout.prompt,
      changes: workout.changes,
    },
  })
  const changes = [...(workout.changes ?? []), change]
  if (workout.source === 'prompt') return { ...workout, ...result, changes }
  return { id: newId(), ...result, source: 'prompt', basedOn: workout.name, changes, createdAt: new Date().toISOString() }
}

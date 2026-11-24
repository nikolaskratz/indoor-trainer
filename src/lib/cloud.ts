// The app's link to Supabase: sign-in and the workout generator.
// Shares the tri-coach Supabase project and its login.

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

export async function signOut(): Promise<void> {
  await supabase.auth.signOut()
}

/** Asks the server to build a workout from a description. Throws an Error with a readable message. */
export async function generateWorkout(prompt: string, profile: RiderProfile): Promise<Workout> {
  const { data, error } = await supabase.functions.invoke('turbo-workout', { body: { prompt, profile } })
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
  const result = (data as { workout?: { name: string; description: string; blocks: Block[] } }).workout
  if (!result || !Array.isArray(result.blocks)) throw new Error('The workout generator returned nothing usable.')
  const problems = validateWorkout(result.blocks)
  if (problems.length) throw new Error(`The generated workout is not usable: ${problems[0]}`)
  return {
    id: `w-${Date.now().toString(36)}`,
    name: result.name,
    description: result.description,
    blocks: result.blocks,
    source: 'prompt',
    prompt,
    createdAt: new Date().toISOString(),
  }
}

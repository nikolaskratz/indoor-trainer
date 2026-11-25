// Turns a request such as "45 min easy Z2 with some variations" into a structured workout.
//
// Called by the Indoor Trainer app with the user's Supabase JWT and
// {prompt, profile: {ftp, weightKg, maxHr, thresholdHr}}. With {base: <a workout>} as well,
// the prompt is a change request ("make the warm-up shorter") applied to that workout.
// Only the owner and the people they let in (see turbo_access_of) may call it, so nobody
// else can spend the API key.
//
// Needs the ANTHROPIC_API_KEY secret (already set in this project for plant-ai).

import { createClient } from 'npm:@supabase/supabase-js@2'
import { readBase } from './base.ts'
import { Anthropic, generateWorkout, type Profile } from './claude.ts'

const MAX_PROMPT_CHARS = 1500

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

const positive = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null)

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors })
  try {
    const token = req.headers.get('Authorization')?.replace('Bearer ', '')
    const { data } = token ? await supabase.auth.getUser(token) : { data: { user: null } }
    if (!data.user) return json({ error: 'Please sign in first.' }, 401)
    const access = await supabase.rpc('turbo_access_of', { p_user: data.user.id })
    if (access.error) throw access.error
    if (access.data !== 'owner' && access.data !== 'member') return json({ error: 'This account has no access yet.' }, 403)

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
    if (!apiKey) return json({ error: 'Workout generation is not set up yet (missing ANTHROPIC_API_KEY).' }, 503)

    const body = (await req.json()) as { prompt?: unknown; profile?: Record<string, unknown>; base?: unknown }
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    const changing = body.base !== undefined && body.base !== null
    if (!prompt) return json({ error: changing ? 'Describe what to change.' : 'Describe the workout you want.' }, 400)
    if (prompt.length > MAX_PROMPT_CHARS) return json({ error: 'That description is too long.' }, 400)
    const ftp = positive(body.profile?.ftp)
    if (!ftp) return json({ error: 'Enter your FTP in the profile first.' }, 400)
    const profile: Profile = {
      ftp,
      weightKg: positive(body.profile?.weightKg),
      maxHr: positive(body.profile?.maxHr),
      thresholdHr: positive(body.profile?.thresholdHr),
    }

    const base = changing ? readBase(body.base) : undefined
    if (base === null) return json({ error: 'This workout cannot be changed: its steps are not readable.' }, 400)

    const { workout, problem, model, usage } = await generateWorkout(apiKey, prompt, profile, base)
    console.log('turbo-workout:', base ? 'change' : 'new', model, usage.input_tokens, 'in', usage.output_tokens, 'out', problem ?? 'ok')
    if (!workout) return json({ error: problem ?? 'Could not build a workout from that. Try rephrasing it.' }, 502)
    return json({ workout })
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return json({ error: 'The workout generator is busy. Try again in a minute.' }, 429)
    if (e instanceof Anthropic.AuthenticationError) {
      console.error('turbo-workout: Anthropic rejected the API key')
      return json({ error: 'The workout generator key is not valid.' }, 503)
    }
    if (e instanceof Anthropic.APIError) {
      console.error('turbo-workout: Anthropic API error', e.status)
      return json({ error: 'The workout generator is unavailable right now.' }, 502)
    }
    console.error(e)
    return json({ error: 'Something went wrong while creating the workout.' }, 500)
  }
})

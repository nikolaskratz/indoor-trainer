// Strava for the Indoor Trainer app: connect an account and upload finished rides.
//
// Called with the user's Supabase JWT and {action, ...}:
//   status                     -> is Strava set up, is this user connected
//   exchange {code}            -> finish the OAuth connect with the code Strava sent back
//   upload {tcx, name, description, externalId} -> start an upload, returns its id
//   check {uploadId}           -> how the upload is doing; activityId once it is ready
//   disconnect                 -> revoke access and forget the tokens
//
// The client secret and the tokens never leave the server: tokens live in turbo_strava,
// which only this function (service role) can read. Only accounts in tri_owners may call it.
//
// Needs the secrets STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET.

import { createClient } from 'npm:@supabase/supabase-js@2'

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

const MAX_TCX_BYTES = 12_000_000
/** Refresh when the access token has less than this long to live. */
const REFRESH_MARGIN_MS = 10 * 60 * 1000

type TokenResponse = {
  access_token: string
  refresh_token: string
  expires_at: number
  scope?: string
  athlete?: { id?: number; firstname?: string; lastname?: string }
}

class StravaError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function tokenRequest(clientId: string, clientSecret: string, fields: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...fields }),
  })
  if (!res.ok) {
    console.error('turbo-strava: token request failed', res.status)
    throw new StravaError('Strava did not accept the connection. Try connecting again.', 502)
  }
  return (await res.json()) as TokenResponse
}

/** A valid access token for the user, refreshed when needed; null when not connected. */
async function accessToken(userId: string, clientId: string, clientSecret: string): Promise<string | null> {
  const { data: row, error } = await supabase.from('turbo_strava').select('*').eq('user_id', userId).maybeSingle()
  if (error) throw error
  if (!row) return null
  if (new Date(row.expires_at).getTime() - Date.now() > REFRESH_MARGIN_MS) return row.access_token
  // Strava rotates refresh tokens: the new one must be stored or the connection is lost.
  const fresh = await tokenRequest(clientId, clientSecret, {
    grant_type: 'refresh_token',
    refresh_token: row.refresh_token,
  })
  const saved = await supabase
    .from('turbo_strava')
    .update({
      access_token: fresh.access_token,
      refresh_token: fresh.refresh_token,
      expires_at: new Date(fresh.expires_at * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
  if (saved.error) throw saved.error
  return fresh.access_token
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors })
  try {
    const jwt = req.headers.get('Authorization')?.replace('Bearer ', '')
    const { data } = jwt ? await supabase.auth.getUser(jwt) : { data: { user: null } }
    if (!data.user) return json({ error: 'Please sign in first.' }, 401)
    const userId = data.user.id
    const owner = await supabase.from('tri_owners').select('user_id').eq('user_id', userId).maybeSingle()
    if (owner.error) throw owner.error
    if (!owner.data) return json({ error: 'This account may not use Strava here.' }, 403)

    const body = (await req.json()) as Record<string, unknown>
    const action = body.action
    const clientId = Deno.env.get('STRAVA_CLIENT_ID')
    const clientSecret = Deno.env.get('STRAVA_CLIENT_SECRET')

    if (action === 'status') {
      if (!clientId || !clientSecret) return json({ configured: false, connected: false })
      const { data: row, error } = await supabase
        .from('turbo_strava')
        .select('athlete_name')
        .eq('user_id', userId)
        .maybeSingle()
      if (error) throw error
      // The client id is public: the app needs it to send the user to Strava.
      return json({ configured: true, clientId, connected: row !== null, athlete: row?.athlete_name ?? null })
    }

    if (!clientId || !clientSecret) return json({ error: 'Strava is not set up yet.' }, 503)

    if (action === 'exchange') {
      const code = typeof body.code === 'string' ? body.code : ''
      if (!code) return json({ error: 'Strava sent no code.' }, 400)
      const token = await tokenRequest(clientId, clientSecret, { grant_type: 'authorization_code', code })
      // The user can untick permissions on Strava's page; uploading needs this one.
      if (token.scope !== undefined && !token.scope.split(/[ ,]/).includes('activity:write')) {
        return json({ error: 'Strava was connected without permission to upload. Connect again and leave "Upload your activities" ticked.' }, 400)
      }
      const athlete = [token.athlete?.firstname, token.athlete?.lastname].filter(Boolean).join(' ') || null
      const saved = await supabase.from('turbo_strava').upsert({
        user_id: userId,
        athlete_id: token.athlete?.id ?? null,
        athlete_name: athlete,
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        expires_at: new Date(token.expires_at * 1000).toISOString(),
        scope: token.scope ?? null,
        updated_at: new Date().toISOString(),
      })
      if (saved.error) throw saved.error
      return json({ connected: true, athlete })
    }

    if (action === 'disconnect') {
      const token = await accessToken(userId, clientId, clientSecret).catch(() => null)
      if (token) {
        const res = await fetch(`https://www.strava.com/oauth/deauthorize?access_token=${encodeURIComponent(token)}`, {
          method: 'POST',
        })
        if (!res.ok) console.error('turbo-strava: deauthorize failed', res.status)
      }
      const removed = await supabase.from('turbo_strava').delete().eq('user_id', userId)
      if (removed.error) throw removed.error
      return json({ connected: false })
    }

    const token = await accessToken(userId, clientId, clientSecret)
    if (!token) return json({ error: 'Connect Strava first.' }, 409)

    if (action === 'upload') {
      const tcx = typeof body.tcx === 'string' ? body.tcx : ''
      if (!tcx || tcx.length > MAX_TCX_BYTES) return json({ error: 'The ride file is missing or too large.' }, 400)
      const externalId = String(body.externalId ?? `ride-${Date.now()}`).replace(/[^A-Za-z0-9_-]/g, '')
      const form = new FormData()
      form.append('file', new Blob([tcx], { type: 'application/xml' }), `${externalId}.tcx`)
      form.append('data_type', 'tcx')
      form.append('sport_type', 'VirtualRide')
      form.append('trainer', '1')
      form.append('external_id', externalId)
      if (typeof body.name === 'string' && body.name) form.append('name', body.name.slice(0, 200))
      if (typeof body.description === 'string' && body.description) form.append('description', body.description.slice(0, 2000))
      const res = await fetch('https://www.strava.com/api/v3/uploads', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      })
      const upload = (await res.json().catch(() => ({}))) as { id_str?: string; id?: number; error?: string | null; status?: string }
      if (res.status === 401) return json({ error: 'Strava no longer accepts the connection. Connect again.' }, 409)
      if (!res.ok || (!upload.id_str && !upload.id)) {
        console.error('turbo-strava: upload failed', res.status)
        return json({ error: upload.error || 'Strava did not accept the upload.' }, 502)
      }
      return json({ uploadId: upload.id_str ?? String(upload.id), status: upload.status ?? null, error: upload.error ?? null })
    }

    if (action === 'check') {
      const uploadId = String(body.uploadId ?? '')
      if (!/^\d+$/.test(uploadId)) return json({ error: 'Unknown upload.' }, 400)
      const res = await fetch(`https://www.strava.com/api/v3/uploads/${uploadId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        console.error('turbo-strava: upload check failed', res.status)
        return json({ error: 'Strava could not report on the upload.' }, 502)
      }
      const upload = (await res.json()) as { status?: string; error?: string | null; activity_id?: number | null }
      return json({ status: upload.status ?? null, error: upload.error ?? null, activityId: upload.activity_id ?? null })
    }

    return json({ error: 'Unknown action.' }, 400)
  } catch (e) {
    if (e instanceof StravaError) return json({ error: e.message }, e.status)
    console.error(e)
    return json({ error: 'Something went wrong while talking to Strava.' }, 500)
  }
})

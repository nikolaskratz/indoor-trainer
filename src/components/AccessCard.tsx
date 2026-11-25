import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { accessStore, supabase } from '../lib/cloud.ts'
import { useStore } from '../lib/store.ts'
import { Button, Card } from './ui.tsx'

/** One person's use of the workout generator in the current calendar month. */
type Usage = { email: string; access: string; requests: number; cost_usd: number; month_usd: number }

const usd = (amount: number): string => '$' + Number(amount).toFixed(2)

function used(u: Usage): string {
  if (u.requests === 0) return `nothing used of ${usd(u.month_usd)} this month`
  return `${u.requests} ${u.requests === 1 ? 'request' : 'requests'}, ${usd(u.cost_usd)} of ${usd(u.month_usd)} this month`
}

/**
 * For the owner only: the email addresses that may use the app's server side (workouts
 * from a description, Strava, saving to an account), and what each person's workout
 * requests cost this month. Each person creates their own account with that address and
 * sees only their own data.
 */
export function AccessCard() {
  const access = useStore(accessStore)
  const [emails, setEmails] = useState<string[] | null>(null)
  const [usage, setUsage] = useState<Usage[]>([])
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('turbo_members').select('email').order('added_at')
    if (error) setError(error.message)
    else setEmails((data as { email: string }[]).map((row) => row.email))
    // The numbers are an extra: the list works without them.
    const summary = await supabase.rpc('turbo_usage_summary')
    if (!summary.error && Array.isArray(summary.data)) setUsage(summary.data as Usage[])
  }, [])

  useEffect(() => {
    if (access === 'owner') void load()
  }, [access, load])

  if (access !== 'owner') return null

  const change = async (run: () => PromiseLike<{ error: { message: string; code?: string } | null }>) => {
    setBusy(true)
    setError(null)
    const { error } = await run()
    // 23505: the address is already on the list, which is what was asked for.
    if (error && error.code !== '23505') setError(error.message)
    await load()
    setBusy(false)
  }

  const add = (e: FormEvent) => {
    e.preventDefault()
    const address = email.trim().toLowerCase()
    if (!address) return
    void change(() => supabase.from('turbo_members').insert({ email: address })).then(() => setEmail(''))
  }

  const mine = usage.find((u) => u.access === 'owner')
  const theirs = new Map(usage.filter((u) => u.access === 'member').map((u) => [u.email, u]))

  return (
    <Card title="People with access">
      <div className="space-y-3 text-sm">
        <p className="text-stone-600 dark:text-stone-400">
          Add someone’s email address, then send them the link to this app. They choose “Create an account” on the start
          page with that address and their own password. They get their own profile, workouts, rides and Strava
          connection, and never see yours. Workouts they create from a description are billed to your Claude API key, so
          each person has a limit per hour and a budget per month.
        </p>
        {mine && <p data-testid="my-usage">You: {used(mine)}.</p>}
        {emails === null ? (
          !error && <p className="text-stone-500">Loading…</p>
        ) : emails.length === 0 ? (
          <p className="text-stone-500">Nobody else has access.</p>
        ) : (
          <ul className="divide-y divide-stone-200 dark:divide-stone-800" data-testid="access-list">
            {emails.map((address) => (
              <li key={address} className="flex items-center justify-between gap-3 py-1.5">
                <span className="min-w-0">
                  <span className="block break-all">{address}</span>
                  <span className="block text-xs text-stone-500">
                    {theirs.has(address) ? used(theirs.get(address)!) : 'no account yet'}
                  </span>
                </span>
                <Button
                  kind="quiet"
                  disabled={busy}
                  onClick={() => void change(() => supabase.from('turbo_members').delete().eq('email', address))}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={add} className="flex flex-wrap gap-2">
          <input
            type="email"
            required
            placeholder="friend@example.com"
            aria-label="Email address to give access"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="min-w-0 flex-1 rounded border border-stone-300 bg-white px-3 py-1.5 dark:border-stone-700 dark:bg-stone-900"
          />
          <button
            type="submit"
            disabled={busy || !email.trim()}
            className="rounded-lg bg-teal-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-50"
          >
            Give access
          </button>
        </form>
        {error && <p className="text-red-700 dark:text-red-400">{error}</p>}
        <p className="text-xs text-stone-500">
          Removing an address stops the access at once. What that person saved stays in their account.
        </p>
      </div>
    </Card>
  )
}

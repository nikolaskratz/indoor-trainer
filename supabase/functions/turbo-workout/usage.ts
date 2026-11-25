// The spending guard's arithmetic and wording: what a call cost, and what to tell someone
// who reached a limit. No imports, so it can be unit-tested outside Deno. The limits
// themselves live in the database (turbo_limits), which also does the counting.

/** US dollars per million tokens: [input, output]. */
const PRICES: Record<string, [number, number]> = {
  'claude-opus-5-5': [4, 20],
  // What a declined request can fall back to.
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
}
/** For a model missing above: the dearest current rate, so the guard errs on the careful side. */
const UNKNOWN_PRICE: [number, number] = [10, 50]

const price = (model: string): [number, number] => PRICES[model] ?? UNKNOWN_PRICE

type Tokens = { input_tokens?: unknown; output_tokens?: unknown; cache_creation_input_tokens?: unknown; cache_read_input_tokens?: unknown }
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
const input = (t: Tokens): number => n(t.input_tokens) + n(t.cache_creation_input_tokens) + n(t.cache_read_input_tokens)

/**
 * Tokens and estimated cost of one call. When a request was declined and answered by a
 * fallback model, `usage.iterations` lists every attempt and the top-level numbers cover
 * only the last one, so the attempts are added up. All of it is priced at the dearer of
 * the requested model and the one that answered: an estimate that never comes out low.
 */
export function spent(requested: string, answered: string, usage: Tokens & { iterations?: unknown }) {
  let inputTokens = input(usage)
  let outputTokens = n(usage.output_tokens)
  if (Array.isArray(usage.iterations)) {
    const attempts = usage.iterations.filter((a): a is Tokens => !!a && typeof a === 'object')
    inputTokens = Math.max(inputTokens, attempts.reduce((sum, a) => sum + input(a), 0))
    outputTokens = Math.max(outputTokens, attempts.reduce((sum, a) => sum + n(a.output_tokens), 0))
  }
  const [a, b] = [price(requested), price(answered)]
  const costUsd = (inputTokens * Math.max(a[0], b[0]) + outputTokens * Math.max(a[1], b[1])) / 1_000_000
  return { inputTokens, outputTokens, costUsd: Math.round(costUsd * 100_000) / 100_000 }
}

export type Refusal = { reason?: string; limit?: number; retry_at?: string }

/** What the rider reads when a limit stops a request. `now` is epoch ms. */
export function limitMessage(refusal: Refusal, now: number): string {
  if (refusal.reason === 'hour') {
    const wait = Math.max(1, Math.ceil((Date.parse(refusal.retry_at ?? '') - now) / 60_000) || 60)
    return `That is the limit of ${refusal.limit} workout requests per hour. Try again in about ${wait} ${wait === 1 ? 'minute' : 'minutes'}.`
  }
  if (refusal.reason === 'month') {
    const next = new Date(now)
    const first = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 1))
    const day = first.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' })
    return `This month's budget for creating workouts is used up. It starts again on ${day}. Your saved workouts still work.`
  }
  return 'This account has no access yet.'
}

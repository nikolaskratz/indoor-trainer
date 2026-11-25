import { describe, expect, it } from 'vitest'
import { limitMessage, spent } from './usage.ts'

describe('spent', () => {
  it('prices a normal call at the model rate', () => {
    // 2,788 in and 1,037 out on Opus 5.5 ($4 / $20 per million): a real change request
    expect(spent('claude-opus-5-5', 'claude-opus-5-5', { input_tokens: 2788, output_tokens: 1037 })).toEqual({
      inputTokens: 2788,
      outputTokens: 1037,
      costUsd: 0.03189,
    })
  })

  it('adds up every attempt when a fallback model answered, at the dearer rate', () => {
    const usage = {
      input_tokens: 3000,
      output_tokens: 1000,
      iterations: [
        { type: 'message', input_tokens: 3000, output_tokens: 0 },
        { type: 'fallback_message', input_tokens: 3000, output_tokens: 1000 },
      ],
    }
    // 6,000 in at $5 and 1,000 out at $25
    expect(spent('claude-opus-5-5', 'claude-opus-4-8', usage)).toEqual({ inputTokens: 6000, outputTokens: 1000, costUsd: 0.055 })
  })

  it('never counts less than the top-level numbers and survives odd input', () => {
    expect(spent('claude-opus-5-5', 'claude-opus-5-5', { input_tokens: 500, output_tokens: 100, iterations: [null, 'x', {}] })).toEqual({
      inputTokens: 500,
      outputTokens: 100,
      costUsd: 0.004,
    })
    expect(spent('claude-opus-5-5', 'claude-opus-5-5', {}).costUsd).toBe(0)
  })

  it('counts cached input and prices an unknown model at the dearest rate', () => {
    const cost = spent('claude-opus-5-5', 'some-future-model', { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 1000 })
    expect(cost).toEqual({ inputTokens: 1000, outputTokens: 1000, costUsd: 0.06 })
  })
})

describe('limitMessage', () => {
  const now = Date.parse('2026-11-25T18:00:00Z')

  it('says how long to wait after the hourly limit', () => {
    expect(limitMessage({ reason: 'hour', limit: 10, retry_at: '2026-11-25T18:12:20Z' }, now)).toBe(
      'That is the limit of 10 workout requests per hour. Try again in about 13 minutes.',
    )
    expect(limitMessage({ reason: 'hour', limit: 10, retry_at: '2026-11-25T18:00:20Z' }, now)).toContain('about 1 minute.')
    expect(limitMessage({ reason: 'hour', limit: 10 }, now)).toContain('about 60 minutes.')
  })

  it('names the day the monthly budget starts again, also across the year end', () => {
    expect(limitMessage({ reason: 'month', limit: 3 }, now)).toContain('It starts again on 1 December.')
    expect(limitMessage({ reason: 'month', limit: 3 }, Date.parse('2026-12-31T23:30:00Z'))).toContain('It starts again on 1 January.')
  })

  it('falls back to the access message', () => {
    expect(limitMessage({ reason: 'access' }, now)).toBe('This account has no access yet.')
  })
})

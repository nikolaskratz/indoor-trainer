// The decisions behind account sync, free of any network or storage code.
//
// Every item (a workout, a ride) carries the time of its last change. A deletion is
// a change too: it leaves a marker with its own time. Whichever side changed an item
// last wins, so two browsers end up with the same data whatever order they sync in.

import type { RideSample } from './ride.ts'

export interface Entry {
  id: string
  /** Time of the last change, epoch ms. */
  at: number
  deleted: boolean
}

export interface SyncPlan {
  /** Local items to upload. */
  push: string[]
  /** Local deletions to record on the server. */
  pushDeleted: string[]
  /** Server items to download. */
  pull: string[]
  /** Local items to remove because they were deleted elsewhere. */
  dropLocal: string[]
  /** Local deletion markers the server already knows about. */
  forget: string[]
}

export function planSync(local: Entry[], remote: Entry[]): SyncPlan {
  const plan: SyncPlan = { push: [], pushDeleted: [], pull: [], dropLocal: [], forget: [] }
  const here = new Map(local.map((e) => [e.id, e]))
  const there = new Map(remote.map((e) => [e.id, e]))
  for (const id of new Set([...here.keys(), ...there.keys()])) {
    const l = here.get(id)
    const r = there.get(id)
    if (l && (!r || l.at > r.at)) {
      if (l.deleted) plan.pushDeleted.push(id)
      else plan.push.push(id)
      continue
    }
    if (!r) continue
    // From here on the server's version is as new as ours or newer.
    if (l?.deleted) plan.forget.push(id)
    if (l && l.at === r.at && l.deleted === r.deleted) continue
    if (r.deleted) {
      if (l && !l.deleted) plan.dropLocal.push(id)
    } else if (!l || l.deleted || r.at > l.at) {
      plan.pull.push(id)
    }
  }
  return plan
}

const FIELDS = ['t', 'ts', 'pos', 'powerW', 'targetW', 'cadenceRpm', 'hrBpm', 'speedKph', 'distanceM', 'segment'] as const

/** A ride's samples column by column: about a third of the size of a list of objects. */
export type PackedSamples = Record<(typeof FIELDS)[number], (number | null)[]>

export function packSamples(samples: RideSample[]): PackedSamples {
  const out = {} as PackedSamples
  for (const f of FIELDS) out[f] = samples.map((s) => s[f])
  return out
}

/** The reverse of `packSamples`; null if the data does not look like packed samples. */
export function unpackSamples(packed: unknown): RideSample[] | null {
  if (!packed || typeof packed !== 'object') return null
  const cols = packed as Record<string, unknown>
  const t = cols.t
  if (!Array.isArray(t)) return null
  for (const f of FIELDS) {
    const col = cols[f]
    if (!Array.isArray(col) || col.length !== t.length) return null
  }
  const p = cols as PackedSamples
  return t.map((_, i) => ({
    t: p.t[i] ?? 0,
    ts: p.ts[i] ?? 0,
    pos: p.pos[i] ?? 0,
    powerW: p.powerW[i],
    targetW: p.targetW[i],
    cadenceRpm: p.cadenceRpm[i],
    hrBpm: p.hrBpm[i],
    speedKph: p.speedKph[i] ?? 0,
    distanceM: p.distanceM[i] ?? 0,
    segment: p.segment[i] ?? 0,
  }))
}

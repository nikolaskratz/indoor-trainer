import { describe, expect, it } from 'vitest'
import type { RideSample } from './ride.ts'
import { packSamples, planSync, unpackSamples, type Entry } from './sync.ts'

const live = (id: string, at: number): Entry => ({ id, at, deleted: false })
const gone = (id: string, at: number): Entry => ({ id, at, deleted: true })
const empty = { push: [], pushDeleted: [], pull: [], dropLocal: [], forget: [] }

describe('planSync', () => {
  it('does nothing when both sides agree', () => {
    expect(planSync([live('a', 5)], [live('a', 5)])).toEqual(empty)
    expect(planSync([], [])).toEqual(empty)
  })

  it('uploads what only this device has, and downloads what only the account has', () => {
    expect(planSync([live('a', 5)], [])).toEqual({ ...empty, push: ['a'] })
    expect(planSync([], [live('b', 5)])).toEqual({ ...empty, pull: ['b'] })
  })

  it('lets the newer side win', () => {
    expect(planSync([live('a', 9)], [live('a', 5)])).toEqual({ ...empty, push: ['a'] })
    expect(planSync([live('a', 5)], [live('a', 9)])).toEqual({ ...empty, pull: ['a'] })
  })

  it('records a local deletion on the server, then forgets the marker', () => {
    expect(planSync([gone('a', 9)], [live('a', 5)])).toEqual({ ...empty, pushDeleted: ['a'] })
    // Next sync: the server has the deletion, the marker is no longer needed.
    expect(planSync([gone('a', 9)], [gone('a', 9)])).toEqual({ ...empty, forget: ['a'] })
    // And after that there is nothing left to do.
    expect(planSync([], [gone('a', 9)])).toEqual(empty)
  })

  it('removes locally what was deleted elsewhere', () => {
    expect(planSync([live('a', 5)], [gone('a', 9)])).toEqual({ ...empty, dropLocal: ['a'] })
  })

  it('keeps an item that was changed after it was deleted on the other side', () => {
    // Deleted here at 5, changed elsewhere at 9: it comes back.
    expect(planSync([gone('a', 5)], [live('a', 9)])).toEqual({ ...empty, pull: ['a'], forget: ['a'] })
    // Deleted elsewhere at 5, changed here at 9: it is uploaded again.
    expect(planSync([live('a', 9)], [gone('a', 5)])).toEqual({ ...empty, push: ['a'] })
  })

  it('handles a mix of items independently', () => {
    const plan = planSync([live('same', 1), live('mine', 2), live('older', 3), gone('deleted', 8)], [live('same', 1), live('theirs', 4), live('older', 7), live('deleted', 6)])
    expect(plan).toEqual({ push: ['mine'], pushDeleted: ['deleted'], pull: ['older', 'theirs'], dropLocal: [], forget: [] })
  })

  it('brings two devices to the same state whatever the order', () => {
    // Device A deletes x and adds y; device B edits z. Simulate the server as a map.
    const server = new Map<string, Entry>([['x', live('x', 1)], ['z', live('z', 1)]])
    const apply = (device: Map<string, Entry>) => {
      const plan = planSync([...device.values()], [...server.values()])
      for (const id of [...plan.push, ...plan.pushDeleted]) server.set(id, device.get(id)!)
      for (const id of plan.pull) device.set(id, server.get(id)!)
      for (const id of plan.dropLocal) device.delete(id)
      for (const id of [...plan.forget, ...plan.pushDeleted]) if (device.get(id)?.deleted) device.delete(id)
    }
    const a = new Map<string, Entry>([['x', gone('x', 5)], ['y', live('y', 6)], ['z', live('z', 1)]])
    const b = new Map<string, Entry>([['x', live('x', 1)], ['z', live('z', 7)]])
    apply(a)
    apply(b)
    apply(a)
    const state = (m: Map<string, Entry>) => [...m.values()].sort((p, q) => p.id.localeCompare(q.id))
    expect(state(a)).toEqual([live('y', 6), live('z', 7)])
    expect(state(b)).toEqual(state(a))
  })
})

describe('packSamples', () => {
  const samples: RideSample[] = [
    { t: 1, ts: 1000, pos: 1, powerW: 150, targetW: 150, cadenceRpm: 90, hrBpm: 120, speedKph: 25.1, distanceM: 7, segment: 0 },
    { t: 2, ts: 2000, pos: 2, powerW: null, targetW: null, cadenceRpm: null, hrBpm: null, speedKph: 24.9, distanceM: 13.9, segment: 1 },
  ]

  it('survives the round trip, including missing readings', () => {
    const packed = packSamples(samples)
    expect(packed.powerW).toEqual([150, null])
    expect(unpackSamples(JSON.parse(JSON.stringify(packed)))).toEqual(samples)
    expect(unpackSamples(packSamples([]))).toEqual([])
  })

  it('rejects data that is not packed samples', () => {
    expect(unpackSamples(null)).toBeNull()
    expect(unpackSamples([])).toBeNull()
    expect(unpackSamples({ t: [1, 2] })).toBeNull()
    expect(unpackSamples({ ...packSamples(samples), hrBpm: [120] })).toBeNull()
  })
})

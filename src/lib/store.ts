import { useSyncExternalStore } from 'react'

/** A value with change listeners, readable from React and from plain code. */
export class Store<T> {
  private state: T
  private readonly listeners = new Set<() => void>()

  constructor(initial: T) {
    this.state = initial
  }

  readonly get = (): T => this.state

  set(next: T | ((prev: T) => T)): void {
    const value = typeof next === 'function' ? (next as (prev: T) => T)(this.state) : next
    if (Object.is(value, this.state)) return
    this.state = value
    for (const listener of this.listeners) listener()
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get)
}

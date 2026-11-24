import { useSyncExternalStore } from 'react'

// Hash routing: works on GitHub Pages without server rewrites, and keeps
// query parameters such as ?sim=1 in place.

const subscribe = (listener: () => void): (() => void) => {
  window.addEventListener('hashchange', listener)
  return () => window.removeEventListener('hashchange', listener)
}

const current = (): string => location.hash.replace(/^#\/?/, '')

/** The current route without the leading "#/", e.g. "workout/abc". */
export function useRoute(): string {
  return useSyncExternalStore(subscribe, current)
}

export function navigate(route: string): void {
  location.hash = `/${route}`
}

export const href = (route: string): string => `#/${route}`

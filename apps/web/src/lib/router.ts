/**
 * The whole router.
 *
 * Four screens do not need a routing library, and the one thing this has to get
 * right is the thing a library would also have to: the URL is the state. Back,
 * forward and a hard refresh all work because the browser already knows how to
 * do them, and nothing here caches a second copy of where we are.
 *
 * The app used to key off `location.hash`, which made /app unlinkable, unable
 * to redirect, and invisible to anything that reads a URL.
 */

import { useSyncExternalStore } from 'react'

const subscribers = new Set<() => void>()

function currentPath(): string {
  return window.location.pathname + window.location.search
}

function announce(): void {
  for (const notify of subscribers) notify()
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify)
  return () => {
    subscribers.delete(notify)
  }
}

/** Where we are now, re-rendering whoever asked when that changes. */
export function usePath(): string {
  return useSyncExternalStore(subscribe, currentPath)
}

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  if (to === currentPath()) return
  if (options.replace) window.history.replaceState(null, '', to)
  else window.history.pushState(null, '', to)
  // A pushed route is a new screen, so it starts at the top. Back and forward
  // are left alone: the browser restores their scroll position itself.
  window.scrollTo(0, 0)
  announce()
}

/**
 * Only same-site absolute paths survive. `?next=` is attacker-writable, and a
 * value like `//evil.example` is a path to the browser but another origin once
 * it reaches the address bar, which would turn our sign-in into a redirector.
 * A backslash is refused for the same reason: browsers fold `/\` into `//`.
 */
export function safePath(raw: string | null, fallback: string): string {
  if (raw === null || raw[0] !== '/') return fallback
  if (raw[1] === '/' || raw[1] === '\\') return fallback
  return raw
}

// Anchors keep being anchors. A middle click, a modifier click or target=_blank
// belongs to the browser, and an href starting with # is an in-page jump on the
// landing page rather than a route. Intercepting here rather than exporting a
// <Link> means every href="/signup" already written works, including the ones
// inside the animated button wrappers that only forward DOM props.
window.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  // Element, not HTMLElement: a click can land on the SVG inside a logo link.
  const anchor = e.target instanceof Element ? e.target.closest('a') : null
  if (anchor === null) return
  const href = anchor.getAttribute('href')
  if (href === null || anchor.target === '_blank') return
  if (safePath(href, '') === '') return
  e.preventDefault()
  navigate(href)
})

window.addEventListener('popstate', announce)

/**
 * Who is signed in, held once for the whole app.
 *
 * This used to live inside AppShell, which was fine while /app was the only
 * screen that cared. It is not: /login has to know whether to bounce someone
 * straight through, and /app has to know whether to send them to /login. Two
 * copies of "are we signed in" would disagree exactly once, on the redirect.
 */

import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, getToken, setToken, type User } from './api'

export interface SessionState {
  user: User | null
  /** False until we know whether a stored token is any good. */
  checked: boolean
  /** Set when the monitor could not be reached, which is not being signed out. */
  offline: string | null
  setUser: (user: User | null) => void
  signOut: () => Promise<void>
}

export function useSession(): SessionState {
  const [user, setUser] = useState<User | null>(null)
  const [checked, setChecked] = useState(false)
  const [offline, setOffline] = useState<string | null>(null)

  // A stored token can be expired or revoked, and the only way to know is to
  // ask. Until it answers, showing either the app or the sign-in form would be
  // a guess that flickers when it turns out wrong.
  useEffect(() => {
    if (getToken() === null) {
      setChecked(true)
      return
    }
    api
      .me()
      .then((res) => setUser(res.user))
      .catch((err) => {
        // Only a 401 means the token is bad. A monitor that is simply down must
        // not silently sign the user out.
        if (err instanceof ApiError && err.status === 401) setToken(null)
        else if (err instanceof ApiError) setOffline(err.message)
      })
      .finally(() => setChecked(true))
  }, [])

  const signOut = useCallback(async () => {
    try {
      await api.logout()
    } catch {
      /* the local token goes either way; a failed revoke is not worth blocking on */
    }
    setToken(null)
    setUser(null)
  }, [])

  return { user, checked, offline, setUser, signOut }
}

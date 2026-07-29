/**
 * The two lists every scope control is built from: the schools this monitor
 * knows, and the levels one of them actually publishes.
 *
 * Three screens ask for these now (onboarding, the sidebar switcher and the
 * level filter), and they are public reads with no side effects, so a hook each
 * beats three copies of the same fetch and error handling.
 */

import { useEffect, useState } from 'react'
import { api, type Level, type School } from './api'

/** Empty on failure: a scope control with nothing in it is better than a crash. */
export function useSchools(): School[] {
  const [schools, setSchools] = useState<School[]>([])

  useEffect(() => {
    let cancelled = false
    api
      .schools()
      .then((res) => !cancelled && setSchools(res))
      .catch(() => !cancelled && setSchools([]))
    return () => {
      cancelled = true
    }
  }, [])

  return schools
}

/**
 * The levels a school's own catalog contains, never a list written in here.
 * Codes are per institution, and a hardcoded undergrad and grad pair is exactly
 * what leaves a law or medical student with nothing to tick.
 */
export function useLevels(school: string | null, term: string | null): Level[] {
  const [levels, setLevels] = useState<Level[]>([])

  useEffect(() => {
    let cancelled = false
    if (school === null) {
      setLevels([])
      return
    }
    api
      .levels(school, term)
      .then((res) => !cancelled && setLevels(res.levels))
      .catch(() => !cancelled && setLevels([]))
    return () => {
      cancelled = true
    }
  }, [school, term])

  return levels
}

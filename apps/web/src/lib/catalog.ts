/**
 * The two lists every scope control is built from: the schools this monitor
 * knows, and the levels one of them actually publishes.
 *
 * Three screens ask for these now (onboarding, the sidebar switcher and the
 * level filter), and they are public reads with no side effects, so a hook each
 * beats three copies of the same fetch and error handling.
 */

import { useCallback, useEffect, useState } from 'react'
import { api, type Level, type School, type Subject } from './api'

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

/**
 * The subjects a school publishes in a term, and a way to reload them.
 *
 * Separate from `useLevels` because it answers a different question. Levels are
 * a filter over sections we already hold; this is the list of things we have
 * not fetched yet, which is the only place a student can do anything about an
 * empty catalog. A term is required rather than optional: a seed names one, and
 * a list spanning every term would offer subjects that cannot be seeded from it.
 */
export function useSubjects(
  school: string | null,
  term: string | null
): { subjects: Subject[]; loading: boolean; reload: () => void } {
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [loading, setLoading] = useState(false)
  const [nonce, setNonce] = useState(0)

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    let cancelled = false
    if (school === null || term === null) {
      setSubjects([])
      return
    }
    setLoading(true)
    api
      .subjects(school, term)
      .then((res) => !cancelled && setSubjects(res.subjects))
      .catch(() => !cancelled && setSubjects([]))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [school, term, nonce])

  return { subjects, loading, reload }
}

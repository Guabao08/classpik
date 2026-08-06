import { useState } from 'react'
import { api, ApiError, type User } from '../lib/api'
import { useSchools } from '../lib/catalog'

/**
 * The school and term this account searches in, sitting in the sidebar because
 * it is context rather than a filter: it is true on every screen, so it should
 * be readable from every screen. A transfer student who opens the app to a
 * catalog they do not recognise can see why in the same glance.
 *
 * It edits the account rather than a query string, since the monitor scopes
 * search off the account and two sources for the same thing eventually
 * disagree. Nothing here touches the watchlist.
 */
export default function ScopeSwitcher({
  user,
  onUser,
}: {
  user: User
  onUser: (user: User) => void
}) {
  const schools = useSchools()
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const school = schools.find((s) => s.id === user.school) ?? null

  const save = async (patch: { school?: string | null; term?: string | null; levels?: string[] | null }) => {
    setSaving(true)
    try {
      const res = await api.updatePreferences(patch)
      onUser(res.user)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change what you are searching')
    } finally {
      setSaving(false)
    }
  }

  const control =
    'w-full appearance-none truncate  border border-rule bg-paper-2 px-2.5 py-1.5 text-xs text-ink outline-none transition-colors hover:border-ink/25 disabled:opacity-50'

  return (
    <div className="mt-6 border-t border-rule px-1 pt-5">
      <p className="label mb-2 px-1 text-ink-soft">
        Searching
      </p>

      <div className="space-y-1.5">
        <select
          aria-label="School to search"
          disabled={saving}
          value={user.school ?? ''}
          // Moving school clears the term and the levels rather than carrying
          // them. Both codes are institution-defined, so 202608 and UGRD mean
          // nothing at the next school and would filter its catalog to almost
          // nothing while looking like a school that failed to load.
          onChange={(e) => void save({ school: e.target.value || null, term: null, levels: null })}
          className={control}
        >
          <option value="">Every school</option>
          {schools.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>

        {school !== null && school.terms.length > 0 && (
          <select
            aria-label="Term to search"
            disabled={saving}
            value={user.term ?? ''}
            onChange={(e) => void save({ term: e.target.value || null })}
            className={control}
          >
            <option value="">Every term</option>
            {school.terms.map((t) => (
              <option key={t.code} value={t.code}>
                {t.description}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* The levels are ticked in Find classes, but they narrow the same search,
          so the sidebar says what they currently are rather than leaving a
          filter running out of sight. */}
      <p className="mt-2 px-1 text-[11px] leading-relaxed text-ink-soft">
        {user.levels.length === 0 ? 'Every level' : user.levels.join(', ')}
      </p>

      {error && <p className="mt-2 px-1 text-[11px] text-full">{error}</p>}
    </div>
  )
}

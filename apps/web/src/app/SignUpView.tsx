import { useEffect, useState, type FormEvent } from 'react'
import { api, ApiError, setToken, type User } from '../lib/api'
import { useLevels, useSchools } from '../lib/catalog'
import { navigate } from '../lib/router'
import { AuthCard, authField } from './AuthCard'

/**
 * Two steps: the account, then where this student is shopping.
 *
 * The account is created first even though POST /api/auth/signup accepts the
 * school, term and levels in the same body. The reason is which error lands
 * where: an address that is already taken and a password that is too short are
 * the monitor's rules, and finding out about either one after picking a school
 * and three levels is a form that punishes the person for finishing it.
 *
 * Abandoning step two leaves a working account scoped to every school, which is
 * a real answer rather than a broken state, and the sidebar changes it later.
 */
export default function SignUpView({
  user,
  onUser,
  onDone,
}: {
  user: User | null
  onUser: (user: User) => void
  /** Signup is finished, so hand the visitor back to wherever they were going. */
  onDone: () => void
}) {
  // Whether there was already a session when this screen opened. Step two signs
  // the new account in, so re-reading `user` instead would bounce a student out
  // of the step they are standing on.
  const [alreadySignedIn] = useState(() => user !== null)
  const [step, setStep] = useState<'account' | 'scope'>('account')

  useEffect(() => {
    if (alreadySignedIn) navigate('/app', { replace: true })
  }, [alreadySignedIn])

  if (alreadySignedIn) return null

  if (step === 'scope') {
    return (
      <ScopeStep
        onUser={onUser}
        onDone={onDone}
      />
    )
  }

  return (
    <AccountStep
      onCreated={(created) => {
        onUser(created)
        setStep('scope')
      }}
    />
  )
}

function AccountStep({ onCreated }: { onCreated: (user: User) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const session = await api.signup(email, password)
      setToken(session.token)
      onCreated(session.user)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthCard>
      <StepMark step={1} />
      <h1 className="text-lg font-bold tracking-[-0.02em]">Create an account</h1>
      <p className="mt-1.5 text-sm leading-relaxed text-muted">
        This is a ClassPik account, not your school login. We never ask for that.
      </p>

      <form onSubmit={submit} className="mt-5 space-y-3">
        <label className="block">
          <span className={authField.label}>Email</span>
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={authField.input}
            placeholder="you@school.edu"
          />
        </label>

        <label className="block">
          <span className={authField.label}>Password</span>
          <input
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={authField.input}
            placeholder="at least 10 characters"
          />
        </label>

        {error && (
          <p className="rounded-xl border border-full/25 bg-full/8 px-3.5 py-2.5 text-sm text-full">
            {error}
          </p>
        )}

        <button type="submit" disabled={busy} className={authField.submit}>
          {busy ? 'Working…' : 'Continue'}
        </button>
      </form>

      <a
        href="/login"
        className="mt-4 block text-center text-xs text-muted transition-colors hover:text-bright"
      >
        Already have an account? Sign in
      </a>
    </AuthCard>
  )
}

/**
 * Where this student is shopping: one school, one term, and any number of
 * levels.
 *
 * Levels are checkboxes because a senior taking a graduate seminar is two
 * answers, not one, and a radio group would make them choose which half of
 * their schedule to watch. Nothing is ticked by default, which the monitor
 * reads as every level, so an unusual student is never filtered out by a guess
 * we made on their behalf.
 */
function ScopeStep({ onUser, onDone }: { onUser: (user: User) => void; onDone: () => void }) {
  const schools = useSchools()
  const [school, setSchool] = useState('')
  const [term, setTerm] = useState('')
  const [levels, setLevels] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const available = useLevels(school === '' ? null : school, term === '' ? null : term)
  const chosen = schools.find((s) => s.id === school) ?? null

  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      // One patch at the end rather than one per control: this is a form being
      // submitted, not a setting being flipped, and a half-saved scope is a
      // catalog that looks wrong for reasons the student cannot see.
      const res = await api.updatePreferences({
        school: school === '' ? null : school,
        term: term === '' ? null : term,
        levels,
      })
      onUser(res.user)
      onDone()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save what you are searching')
      setBusy(false)
    }
  }

  return (
    <AuthCard wide>
      <StepMark step={2} />
      <h1 className="text-lg font-bold tracking-[-0.02em]">Where are you shopping?</h1>
      <p className="mt-1.5 text-sm leading-relaxed text-muted">
        This sets what Find classes shows you. Your watchlist is never filtered by it, and all of
        it is changeable later from the app.
      </p>

      <form onSubmit={save} className="mt-5 space-y-4">
        <label className="block">
          <span className={authField.label}>School</span>
          <select
            value={school}
            disabled={busy}
            // Moving school clears the term and the levels rather than carrying
            // them. Both codes are institution-defined, so a term or a level
            // from the last school means nothing at this one.
            onChange={(e) => {
              setSchool(e.target.value)
              setTerm('')
              setLevels([])
            }}
            className={authField.select}
          >
            <option value="">Every school</option>
            {schools.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>

        {chosen !== null && chosen.terms.length > 0 && (
          <label className="block">
            <span className={authField.label}>Term</span>
            <select
              value={term}
              disabled={busy}
              onChange={(e) => setTerm(e.target.value)}
              className={authField.select}
            >
              <option value="">Every term</option>
              {chosen.terms.map((t) => (
                <option key={t.code} value={t.code}>
                  {t.description}
                </option>
              ))}
            </select>
          </label>
        )}

        {available.length > 0 && (
          <fieldset>
            <legend className={authField.label}>Levels</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {available.map((l) => {
                const on = levels.includes(l.level)
                return (
                  <label
                    key={l.level}
                    className={`flex cursor-pointer items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm transition-colors ${
                      on ? 'border-open/30 bg-open/10' : 'border-line bg-white/3 hover:border-white/20'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={busy}
                      onChange={() =>
                        setLevels(
                          on ? levels.filter((x) => x !== l.level) : [...levels, l.level]
                        )
                      }
                      className="h-3.5 w-3.5 accent-[var(--color-open)]"
                    />
                    {/* The registrar's own code, never a word we invented for it. */}
                    <span className="font-medium">{l.level}</span>
                    <span className="num ml-auto text-[11px] text-muted">{l.sections}</span>
                  </label>
                )
              })}
            </div>
            <p className="mt-2 text-[11px] text-muted">
              {levels.length === 0
                ? 'Nothing ticked means every level, including sections your school does not label.'
                : 'Tick as many as you take classes at.'}
            </p>
          </fieldset>
        )}

        {error && (
          <p className="rounded-xl border border-full/25 bg-full/8 px-3.5 py-2.5 text-sm text-full">
            {error}
          </p>
        )}

        <button type="submit" disabled={busy} className={authField.submit}>
          {busy ? 'Saving…' : 'Start watching'}
        </button>
      </form>

      <button
        type="button"
        onClick={onDone}
        className="mt-4 w-full text-center text-xs text-muted transition-colors hover:text-bright"
      >
        Skip for now
      </button>
    </AuthCard>
  )
}

function StepMark({ step }: { step: 1 | 2 }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      {[1, 2].map((n) => (
        <span
          key={n}
          className={`h-1 w-7 rounded-full transition-colors ${n <= step ? 'bg-open' : 'bg-white/10'}`}
        />
      ))}
      <span className="num ml-1 text-[11px] text-muted">step {step} of 2</span>
    </div>
  )
}

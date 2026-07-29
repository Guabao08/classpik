# ClassPik: Architecture

Autonomous course registration for college students. Two things:

1. **Watch** a section and get pinged the moment a seat opens.
2. **Enroll** automatically, at your registration window, or the instant a seat frees up.

---

## The core principle: split on the credential line

The single most important decision in this system is that **watching and enrolling are separate products with separate trust models.**

At most schools, seat counts are visible in the *public* class search with no login. That means monitoring needs no credentials at all. Enrollment does.

| | Monitor | Agent |
|---|---|---|
| Runs | Cloud | Student's own machine |
| Credentials | **None, ever** | OS keychain, never transmitted |
| Scales to | Every school we can parse | One school at a time |
| Ships | Independently, early | After Phase 0 proves feasibility |

Keeping these apart means the broadly-deployable half carries zero password liability, and the half that holds credentials never puts them on our infrastructure. Do not merge these.

---

## System A: Monitor (cloud)

Unauthenticated crawler that tracks seat counts and notifies students. Built, in
`apps/monitor`. This section describes what is there, not a plan.

**Stack**
- Node 22+ / TypeScript, strict. One runtime dependency: `yaml`.
- Storage is `node:sqlite`, which ships with Node, so there is no database to run
  and no native module to build. Every SQL statement lives in `src/core/repo.ts`
  so the eventual move to Postgres is a repo rewrite rather than an app rewrite.
- No job queue. The poll loop is a `setInterval` over a `poll_targets` table, and
  work is divided between workers by leasing a row. A queue service would be a
  second thing to run for a workload measured in requests per minute.
- Delivery transports: console (the in-app record), webhook, and email over
  either SMTP or Resend. Web push and SMS are interface implementations away and
  are not written.
- Accounts are ours: `users` and `sessions`, scrypt hashes, bearer tokens stored
  as SHA-256. No school credential is ever involved. See the SIS adapter section.

**The scalability decision: poll per subject, not per section and not per watch.**

Watches are deduped into a global poll table keyed by `(school, term, subject)`.
One upstream request returns every section for a subject, so fifty students
watching fifty different CS sections cost **one** request, not fifty. Crawl load
scales with **distinct subjects watched**, which is a number in the dozens per
campus, rather than with sections or users.

The section is the wrong unit and it is worth being explicit about why: keying on
`(school, term, crn)` would have made a popular subject cost one request per
watched section in it, turning the busiest subjects into the most expensive ones.
That is the opposite of what a registrar should see from us.

**Politeness is a hard requirement.** 5 minute baseline interval, tightening to a
1 minute floor for a subject that just changed and relaxing to a 30 minute
ceiling for one where nothing moves, with jitter so a fleet never resynchronises.
Per-host concurrency caps and a floor on the gap between two requests, both
enforced in one place (`PoliteClient`), plus exponential backoff honouring
`Retry-After` and a hard ceiling on the total time one request may take. The
realistic failure mode is not legal. It is getting IP-blocked and silently going
dark for every user at that school. Every number here is in
`src/config/schools.ts` and is overridable per school.

### Subject discovery, and the refusal to poll what it finds

Hand-enumerating subject codes in YAML works for a pilot and does not survive a
second campus. `SisAdapter.listSubjects` already knows the answer, so a daily job
asks it and writes the result to a `subjects` table.

The trap is what to do with that answer. A large university publishes two hundred
or more codes, and turning them into two hundred poll targets would multiply our
request rate at that registrar by two orders of magnitude to serve students
watching three or four of them. So discovery creates **no polling work at all**.
A `subjects` row is a browsing catalogue entry.

That leaves a bootstrap problem, and it is circular: a watch names a section,
sections only exist after a fetch, and the fetch is what we are refusing to do.
The cut is an **on-demand seed**: browsing a subject buys it exactly one fetch,
claimed by the `subjects.seeded_at` UPDATE itself so any number of simultaneous
browsers converge on one request. The seed queues a poll target rather than
fetching, so the request happens on the loop's next tick under the same rate
limiting as everything else. A seeded subject nobody ends up watching is polled
once and then goes quiet.

### Running several workers

Several pollers can share one database, in one process or several on one host.
Work is divided by **leasing a target before fetching it**, so the fleet spends
one upstream request per subject per cycle however many workers are running. The
claim is a single `UPDATE ... RETURNING`, which SQLite runs in its own implicit
transaction with the write lock held, so two workers issuing it at the same
moment get disjoint sets. A `SELECT` followed by an `UPDATE` would hand both the
same rows.

Leases expire, and the holder renews its own while a fetch is in flight. Both
halves matter: without expiry a worker killed mid-poll holds a target forever and
the students watching it silently stop being told anything, and without renewal a
fetch that outlasts the expiry lets a second worker take the same subject at
exactly the moment the registrar is rate limiting us.

**Several machines is not solved.** SQLite over NFS or SMB does not lock
reliably, and unreliable locking is precisely what leasing depends on. That is
what the Postgres move is for.

### Search scoping

An account carries a school, a term, and a list of academic levels, and catalog
search defaults to them. Without that, the day a second university is configured
"Find classes" becomes two universities' catalogs shuffled together and no query
a student can type separates them.

Three things about it are deliberate:

- **Only search is scoped.** The watchlist, the events feed and delivery all
  ignore the scope, so a transfer student keeps every watch from their old school
  and a senior keeps the graduate seminar after unticking GRAD.
- **Level is a list, and its values are not ours to invent.** Banner installs
  answer UG and GR and also LW and MD; PeopleSoft answers UGRD, GRAD, LAW, MEDS.
  The boxes a client offers come from the catalog we hold, never from an enum. A
  section the registrar gave no level to matches every filter.
- **Term and level codes do not travel between schools.** 202608 is Fall 2026 at
  one school and nothing at all at the next. Pointing a search, or an account, at
  a different school drops both rather than filtering the new catalog on codes it
  has never published.

### Accounts and delivery

A ClassPik account is an email address and a password, and it is ours. It is
never presented to a student system, and there is nowhere in `SisAdapter` for it
to go even if somebody tried. Passwords are scrypt, hashed off the event loop
with a bounded queue so a burst of logins cannot stall the poll loop. Sessions
are bearer tokens stored as their SHA-256, so a database leak yields nothing
replayable.

Alerts go to the address on the account and nowhere else. A watch carries no
arbitrary destination, which closes the "point a watch at anyone" hole a
free-text target would open. The queue is UNIQUE on `(watch_id, event_id)`, so
idempotency is enforced by the schema rather than by hoping a retry gets it
right. What is not built is email verification and password reset: an address is
taken on trust at signup.

---

## System B: Agent (local)

Desktop app that holds the session and performs enrollment.

**Stack**
- Electron + TypeScript, shares adapter types with the backend. Tauri gives smaller binaries but costs us a second language; not worth it for a two-person team.
- Playwright driving the student's **installed Chrome** with a dedicated persistent profile, not a bundled Chromium. Smaller install, and the profile can inherit SSO/device-trust state the student already has. Falls back to downloading Chromium if Chrome is absent.
- Credentials in the OS keychain (Keychain on macOS, DPAPI on Windows).
- Scheduled hardware wake: `pmset schedule wake` (macOS), Task Scheduler wake timer (Windows). The computer wakes up early, not the student.

### The hot path

Browser for authentication, raw HTTP for the race:

1. Playwright completes SSO + MFA in a persistent context. (SSO is a SAML/CAS/OIDC redirect chain with JS in the middle. Reimplementing it in raw HTTP breaks constantly. Let a real browser do it.)
2. Lift session cookies out of the browser context.
3. At T-minus seconds: scrape fresh CSRF/state tokens, build the payload, open a keep-alive connection so TCP+TLS is already done.
4. Fire as raw HTTP. Milliseconds, and multiple sections can go in parallel.

**Sync to the server's clock, not ours.** Read the `Date` response header, compute the offset, fire on *their* time. 400ms of local clock skew loses seats.

---

## MFA: three strategies, every vendor

We never integrate with an MFA vendor. We drive a browser through whatever the school's IdP renders, which puts us one layer *below* Duo/Entra/Okta/Google. The abstraction is therefore behavioral, not per-vendor:

```ts
interface MfaStrategy {
  satisfy(page: Page, ctx: AuthContext): Promise<SessionState>
}
```

- **`DeviceTrust`**: persistent profile, tick "remember this device," reuse the cookie. Primary strategy. Identical across every vendor.
- **`PushWait`**: trigger auth, notify the student's phone, wait for the IdP page to advance. We watch for a DOM/navigation change; we never call anyone's API.
- **`InteractiveHandoff`**: open the window, human finishes it, agent takes over the session. Universal fallback. Covers passkeys, security questions, in-house SSO, anything we haven't seen.

Three strategies cover every MFA vendor that exists, including ones that don't exist yet.

**What actually varies is school policy, not vendor:** does this school permit "remember this device," and for how long? Some Duo schools disable it; some Entra schools allow 30 days. This is a per-school capability flag, discovered empirically.

**Known hard blocker:** schools mandating passkeys/FIDO2 only. The hardware ceremony can't be replayed from a stored profile. Still rare for general student accounts. Where it lands, that school is monitor-only.

**Explicitly not building:** TOTP seed extraction from authenticator apps, CAPTCHA solving, or bot-detection evasion. If a school gates registration behind a CAPTCHA, that school degrades to notify-only.

---

## SIS adapters

Three adapters cover the large majority of US four-year enrollment. Each school is then a **config file, not code**. That is how two people reach many campuses.

**There are two interfaces, and the split between them is the credential line
made structural.** `SisAdapter` is what the cloud monitor implements and it has
three methods, none of which can carry a password. There is nowhere in it to put
one. Authentication, prepare and fire belong to a separate agent-side interface
that only ever runs on the student's own machine.

```ts
// apps/monitor/src/adapters/types.ts. Public and unauthenticated.
// The cloud monitor uses ONLY this, and this is all there is.
interface SisAdapter {
  readonly id: SisId
  listTerms(school: SchoolConfig, opts?: FetchOptions): Promise<Term[]>
  listSubjects(school: SchoolConfig, term: string, opts?: FetchOptions): Promise<Subject[]>
  /** Every section for one subject in one term. The polling unit. */
  fetchSections(
    school: SchoolConfig,
    term: string,
    subject: string,
    opts?: FetchOptions
  ): Promise<RawSection[]>
}

// Agent-side only, and not written yet. It lives in the local app, never in
// the monitor, and nothing in the cloud imports it.
interface SisEnroller {
  authenticate(creds: Creds, mfa: MfaStrategy): Promise<Session>
  prepare(session: Session, targets: Section[]): Promise<PreparedEnroll>
  fire(prepared: PreparedEnroll): Promise<EnrollResult>
}
```

| Adapter | Difficulty | Notes |
|---|---|---|
| **Banner 9** | Easiest | Public class search is a JSON API underneath. Verified live at Georgia Tech on 2026-07-29, logged out. The registration app is at **`registration.banner.gatech.edu`**, not `oscar.gatech.edu`: OSCAR still serves the old Banner 8 pages and every `StudentRegistrationSsb` path there 404s. |
| **PeopleSoft CS** | Medium | Built for **HighPoint CX only**, which is where the clean JSON class search comes from; stock installs 404. Stateful for enrollment: `ICSID`/`ICStateNum` tokens increment. Has an **enrollment shopping cart**: pre-load the night before, the race is just "Finish Enrolling." **Duke (DukeHub)** is PeopleSoft. Never run against a live install. |
| **Workday Student** | Hardest | Obfuscated, heavily session-bound. Plan to stay in-browser. Not built. |

SIS can be auto-detected from URL shape: `/StudentRegistrationSsb/` → Banner 9, `/psc/` or `/psp/` → PeopleSoft, `*.myworkday.com` → Workday. `detectSis(url)` does this, and it only helps onboarding: the value actually used is whatever the config says.

### School config

The real schema, flat, validated by `src/config/schools.ts`. This is
`apps/monitor/schools/gatech.yaml` with its comments removed:

```yaml
id: gatech
name: Georgia Institute of Technology
sis: banner9
baseUrl: https://registration.banner.gatech.edu
# One request returns every section for a subject, so this list is the whole
# polling cost. Empty is fine and is the recommended way to onboard: discovery
# fills the browsable catalogue and browsing seeds what anyone opens.
subjects: [CS, MATH]
polling:
  baseIntervalMs: 300000    # 5 min
  minIntervalMs: 60000      # 1 min, used right after a change
  maxIntervalMs: 1800000    # 30 min where nothing moves
  hotWindowMs: 900000       # 15 min
  maxConcurrentRequests: 2
  minRequestGapMs: 500
enabled: false
```

There is no `auth:` block and no `catalog:` block, because the monitor
authenticates nothing and reads nothing that is not public. A PeopleSoft school
adds a `peoplesoft:` block with `scriptPath`, `institution` and `terms`, since
PeopleSoft term codes are institution-defined and cannot be discovered.

Adding a school = a config PR.

---

## Build order

**Phase 0, Feasibility spike.** Two halves. **Part B, is the catalog public, is
answered: yes**, verified live at `registration.banner.gatech.edu` on 2026-07-29
with a committed config. **Part A, will a replayed enrollment request be
accepted, is still open** and needs an active registration window. See
`PHASE0.md`.

**Phase 1, Monitor only.** Built. Banner + PeopleSoft catalog search, accounts,
watch a section, get told by console, webhook or email. No credentials anywhere.
Shippable and useful on its own; earns users while the risky half is unproven.

**Phase 2, Agent + enrollment.** One school (GT), registration-window sniping.

**Phase 3, Auto-grab.** Monitor detects seat → pushes to agent → agent fires. Needs both halves. This is the thing people pay for.

---

## Known risks

1. **Phase 0 may fail on some schools.** Some portals bind requests to browser state tightly enough that we must stay in-browser. Workday almost certainly will. Every adapter needs a slow-but-working DOM automation fallback.
2. **Public catalogs aren't universal.** Most schools expose seat counts without login; some don't. Those schools break the clean split and can only be monitored with credentials, or not at all. Check per school at onboarding.
3. **Registration windows are per-student time tickets.** You cannot enroll before your own assigned window, no matter how fast you are. "Sniping" means *firing the instant your own window opens*. Market it honestly.
4. **Session lifetime.** Portals expire idle sessions (Banner ~30 min) and often hard-cap absolute session length. Long waitlist watches will need re-auth, which is why `DeviceTrust` is the primary MFA strategy rather than a nicety.

---

## Policy posture

Most registration systems restrict automated access, and it varies meaningfully by school. The architecture is the mitigation:

- Credential-free monitoring reads public catalog pages at a polite rate.
- Enrollment runs on the student's own machine, under their own session, performing an action they are authorized to perform.

Check the school's stance before enabling enrollment there. Degrade to monitor-only rather than working around a control.

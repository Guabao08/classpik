# @classpik/monitor

The class watcher. Polls public course catalogs, detects when a seat opens, and
notifies whoever asked to be told.

**This service never touches a credential.** It reads public schedule-of-classes
data only. Anything that needs a student login lives in the local agent, which
is a separate program on the student's own machine. That split is the core
design decision, and it is enforced at the type level: there is nowhere in
`SisAdapter` to put a password.

```bash
npm install
npm test          # 211 tests
npm run typecheck
npm run serve -- --demo   # runs against a simulated SIS, no real registrar
```

---

## Try it in 60 seconds

Demo mode runs the entire service against a simulated student system, so you can
watch the whole loop without pointing traffic at a university.

```bash
npm run serve -- --demo
```

In another shell:

```bash
curl -s localhost:8787/api/sections?q=math221
```

```bash
curl -s -X POST localhost:8787/api/watches -H 'Content-Type: application/json' -d '{"userId":"roshan","sectionId":"demo-university:202608:30412"}'
```

MATH 221 B starts full. Within a minute the simulated registrar frees a seat,
and the service detects it, records an event, and delivers a notification:

```bash
curl -s localhost:8787/api/events?userId=roshan
```

```json
{ "events": [ { "kind": "seat_opened", "prev_seats": 0, "new_seats": 1, "detail": "1 seat opened" } ] }
```

---

## How it works

```
schools/*.yaml ──► SisAdapter ──► Poller ──► diff ──► events ──► Dispatcher ──► transports
                   (Banner 9)       │                   │                        console
                                    │                   └──► watches ──► queue    webhook
                                    └──► SQLite
```

### The polling unit is a subject, not a section

This is the decision that makes the economics work. One Banner request returns
every section for a subject, so `poll_targets` has one row per
`(school, term, subject)`. Fifty students watching different CS sections cost
**one** request, not fifty.

Cost therefore scales with *distinct subjects watched*, not with users. The
service gets cheaper per user as it grows.

### Change detection

`src/core/diff.ts` is pure and has no IO, because it is the part that must not
be wrong. A false positive wakes a student at 3 AM for nothing; a false negative
is the entire product failing silently.

The rule that matters most: **a section observed for the first time never emits
`seat_opened`**, even if it has seats free. We have no evidence it *opened*; we
just started looking. Without that rule, bringing a new subject under watch
would fire a notification for every open section in it.

Only `seat_opened` and `waitlist_opened` notify. Everything else
(`seat_closed`, `capacity_changed`, `section_added`, `section_removed`) is
recorded for history and debugging.

### Adaptive scheduling

`src/core/schedule.ts`, also pure. Three pressures, resolved in this order:

1. **Errors back off first**, exponentially, capped at one hour. Hammering a
   server that is already failing is how you get blocked.
2. **A target that changed recently polls at the floor.** A section that just
   moved is the one most likely to move again.
3. **Otherwise the interval decays toward the ceiling.** A section nobody has
   dropped in a week should not cost what a live one does.

Jitter is applied last, so a fleet of workers never resynchronises into a
thundering herd against one registrar.

You can see this working in the demo: after a change, MATH drops to a ~30s
interval while CS, where nothing moved, sits at ~63s.

### Politeness

The realistic way this service dies is not a crash. It is a registrar quietly
blocking our IP, after which every user at that school silently stops getting
alerts. So rate limiting lives in one place, `PoliteClient`, rather than in each
adapter:

- at most N in-flight requests per host
- a hard floor on the gap between two requests to a host
- exponential backoff with jitter on 429 and 5xx, honouring `Retry-After`
- an identifying `User-Agent` so an admin can find us instead of guessing

Config loading **rejects** a `minIntervalMs` below 30 seconds. That guard exists
so nobody can "optimise" this into a denial of service.

### Notifications

Queued in SQLite rather than sent inline, because a seat opening is the moment
the product either works or does not, and an inline send that fails is a seat
the student never hears about. The queue is `UNIQUE (watch_id, event_id)`, so
idempotency is enforced by the schema rather than by hoping the caller gets it
right. Failures retry with exponential backoff, then land in `failed`.

Transports ship: `console` and `webhook`. Web push and SMS slot in by
implementing the two-method `Transport` interface.

---

## Adding a school

A school is a config file, not code. That is the only way two people cover many
universities.

1. Copy `schools/example.yaml`.
2. **Verify the catalog is public.** Open the school's class search in a private
   window, without logging in, and confirm you can see seat counts. See
   `PHASE0.md` in the repo root.
3. **Check the school's terms of use** for automated access.
4. Set `enabled: true`.

```yaml
id: example-university
name: Example University
sis: banner9
baseUrl: https://banner.example.edu
subjects: [MATH, CS]
polling:
  baseIntervalMs: 300000
  minIntervalMs: 60000
  maxIntervalMs: 1800000
  hotWindowMs: 900000
enabled: true
```

The shipped example is `enabled: false` on purpose. Cloning this repo and
running `npm start` must not poll a real registrar.

### Supported systems

| Adapter | Status | Notes |
|---|---|---|
| `banner9` | Built, fixture-tested | Public class search is a JSON API underneath. Endpoint shapes verified against the [nubanned](https://jennydaman.gitlab.io/nubanned/) docs. **Not yet run against a live install**; that is Phase 0. |
| `peoplesoft` | Not built | Stateful `ICSID`/`ICStateNum` tokens; keep a browser page as the state source. |
| `workday` | Not built | Obfuscated and heavily session-bound. Deprioritised. |

`detectSis(url)` guesses the platform from a portal URL, which helps onboarding.
The value actually used is whatever the config file says.

#### On Banner's statefulness

Banner will not let you simply GET search results. You must hold a session
cookie and POST the term you intend to search, which authorises that session for
that term. **Results for an unauthorised term come back empty with a 200, not an
error.** A missing handshake looks exactly like "this subject has no classes".

The adapter treats a zero-row first page as a broken session and raises, rather
than accepting it. Silently accepting it would make the service report every
section as vanished. This is the single most likely way the adapter breaks
against a real install, so it is called out here and covered by a test.

---

## API

Base URL defaults to `http://localhost:8787`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness |
| `GET` | `/api/stats` | Counts across the service |
| `GET` | `/api/schools` | Configured schools and their terms |
| `GET` | `/api/sections` | Search. `?school=&term=&subject=&q=&status=&limit=` |
| `GET` | `/api/sections/:id` | One section plus its event history |
| `POST` | `/api/watches` | `{userId, sectionId, mode?, channel?, target?}` |
| `GET` | `/api/watches?userId=` | A user's active watches |
| `DELETE` | `/api/watches/:id` | Stop watching |
| `GET` | `/api/events` | `?userId=` or `?sectionId=` |
| `POST` | `/api/poll` | Force a cycle. Useful in development. |

Section ids are `{schoolId}:{term}:{crn}`.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP port |
| `CLASSPIK_DB` | `./classpik.db` | SQLite file |
| `CLASSPIK_DEMO` | unset | `1` runs the simulated SIS |
| `CLASSPIK_CORS_ORIGINS` | localhost dev ports | Comma-separated allowed origins |

---

## Storage

SQLite via `node:sqlite`, built into Node 22.5+. Zero native dependencies and
zero setup, with real SQL and real transactions. Every statement lives in
`src/core/repo.ts`, so moving to Postgres when this outgrows one box is a repo
rewrite rather than an app rewrite.

| Table | Holds |
|---|---|
| `schools`, `terms` | Loaded config |
| `poll_targets` | The polling unit, one per (school, term, subject) |
| `sections` | Current state, with `present` flagging sections that vanished upstream |
| `watches` | User requests, unique per (user, section) |
| `events` | Every detected change |
| `notifications` | Delivery queue, unique per (watch, event) |

A section that disappears from a fetch is flagged `present = 0`, never deleted.
The disappearance is ambiguous, cancelled section, or an upstream hiccup, and
nothing is lost if it comes back on the next poll.

---

## Tests

```bash
npm test
```

211 tests across nine files. The adapter is tested against recorded response
shapes rather than a live registrar: pointing load at a university to test our
own code would be rude, and a suite that depends on their uptime is a suite that
fails during their maintenance window.

| File | Covers |
|---|---|
| `diff.test.ts` | Change detection, including the never-notify-on-first-sight rule and negative seat counts from over-enrolled sections |
| `schedule.test.ts` | Interval policy, backoff ordering, bounds, jitter spread |
| `http.test.ts` | Rate limiting, per-host concurrency, retry, `Retry-After`, slot leaks |
| `banner.test.ts` | Handshake ordering, session reuse, paging, the empty-page trap, field mapping |
| `repo.test.ts` | Schema, transactions, dedupe, notification idempotency |
| `poller.test.ts` | The full loop, failure handling, adaptive intervals |
| `notify.test.ts` | Delivery, retry, backoff, transport routing, webhook safety |
| `api.test.ts` | Every route, validation, CORS |
| `config.test.ts` | Validation, including the politeness floor |

---

## What is not done

Stated plainly so nobody is surprised:

- **The Banner adapter has never run against a live install.** It is built to a
  documented contract and tested against recorded shapes. Phase 0 verifies it.
- **PeopleSoft and Workday adapters do not exist.**
- **Notification transports are console and webhook.** Web push and SMS are
  interface implementations away, but they are not written.
- **No authentication on the API.** `userId` is taken at face value. Fine for
  local development, not for anything public.
- **Single process.** The scheduler assumes one poller. Running two would double
  the request rate against registrars. Multi-worker needs target leasing.
- **No automatic subject discovery in the poll loop.** `listSubjects` exists on
  the adapter but targets are seeded from the config's `subjects` list.

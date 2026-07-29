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
npm test          # 604 tests
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

Searching the catalog needs no account. Watching a section does, so make one and
keep the token it hands back:

```bash
TOKEN=$(curl -s -X POST localhost:8787/api/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"you@example.edu","password":"a-good-long-password"}' | grep -o '"token": *"[^"]*"' | cut -d'"' -f4)
```

```bash
curl -s -X POST localhost:8787/api/watches -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" -d '{"sectionId":"demo-university:202608:30412"}'
```

MATH 221 B starts full. Within a minute the simulated registrar frees a seat,
and the service detects it, records an event, and delivers a notification:

```bash
curl -s localhost:8787/api/events -H "Authorization: Bearer $TOKEN"
```

```json
{ "events": [ { "kind": "seat_opened", "prev_seats": 0, "new_seats": 1, "detail": "1 seat opened" } ] }
```

---

## How it works

```
schools/*.yaml ──► SisAdapter ──► Poller ──► diff ──► events ──► Dispatcher ──► transports
               (Banner, PeopleSoft) │                   │                        console
                                    │                   └──► watches ──► queue    webhook
                                    └──► SQLite                                   email
```

### The polling unit is a subject, not a section

This is the decision that makes the economics work. One Banner request returns
every section for a subject, so `poll_targets` has one row per
`(school, term, subject)`. Fifty students watching different CS sections cost
**one** request, not fifty.

Cost therefore scales with *distinct subjects watched*, not with users. The
service gets cheaper per user as it grows.

### Subject discovery, and why finding a subject is not permission to poll it

A school no longer has to be onboarded by hand-enumerating its subject codes.
`SubjectDiscovery` asks the adapter's `listSubjects` once per (school, term) on
a daily timer and records what it finds in the `subjects` table.

**Discovery does not create poll targets.** A large university publishes two
hundred or more subject codes, and turning those into two hundred poll targets
would multiply our request rate at that registrar by two orders of magnitude to
serve students who are, typically, watching sections in three or four of them.
That is the exact impoliteness the per-subject polling unit exists to avoid, and
it is how a school blocks us and every student there goes dark. So a `subjects`
row is a browsing catalogue entry and costs nothing upstream. A subject earns a
poll target from demand.

That leaves a real bootstrap problem, and it is circular: a watch names a
section, sections only exist after a fetch, and the fetch is the thing we are
refusing to do. "Poll it once somebody watches it" can never start.

The cut is an **on-demand seed**. Browsing a subject buys it exactly one fetch:

```bash
curl -s -X POST localhost:8787/api/subjects/seed -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"school":"demo-university","term":"202608","subject":"CS"}'
```

The bound is how many subjects a person actually opens, which is a handful, not
how many the catalogue contains, which is unbounded from our point of view.
Four things hold that bound:

- **It only acts on a subject the school publishes**, from the discovered
  catalogue or the config's own list. A seed that acted on any string a caller
  sent would be an open instruction to make our server go and fetch things at a
  university.
- **It takes an account and a per-address budget** of twenty an hour. Reading
  the catalogue is public; this is the only route below the operator gate that
  turns into an upstream request.
- **It queues, it does not fetch.** The response is a 202. The poll loop
  performs the request on its next tick, under the same rate limiting as
  everything else, rather than an HTTP handler firing at a registrar while a
  student holds the connection open.
- **A seeded subject nobody watches is polled once and then goes quiet**,
  because a target that has already been polled is only claimed while a live
  watch points into it. Curiosity costs one request, not a subscription.

`GET /api/subjects?school=&term=` returns the catalogue with a `seeded` flag per
row, so a client can tell "no sections here yet" apart from "no sections".

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

### Running more than one worker

Several pollers may share one database, in one process or across machines. Work
is divided by **leasing a target before fetching it**, so the fleet still spends
exactly one upstream request per subject per cycle however many workers are
running. That is the property that matters: adding a worker must buy redundancy
and throughput, never a second request at the same registrar.

The claim is one statement, `UPDATE poll_targets ... RETURNING`. SQLite runs it
in its own implicit transaction with the write lock held, so two workers issuing
it at the same moment are serialised and the second one's subquery sees the rows
the first has already stamped. They get disjoint sets. A `SELECT` of due targets
followed by an `UPDATE` would not do this: both would read before either wrote,
and both would fetch the same subject.

Every lease carries an expiry, default two minutes. A worker killed between
claiming a target and recording the result would otherwise hold it forever, and
the students watching sections in it would simply stop being told anything, with
nothing anywhere saying why. Anything past its expiry is claimable again. A
target is claimed one at a time rather than in a batch, so the lease only has to
outlast a single fetch, and two workers interleave through the same due list
instead of one taking the whole batch.

```bash
CLASSPIK_DB=/data/classpik.db PORT=8787 npm start
CLASSPIK_DB=/data/classpik.db PORT=8788 npm start   # second worker, same file
```

Both processes serve the API and both poll. Two things to know before running
them on separate machines:

- **They must see the same database file.** SQLite over NFS or SMB does not lock
  reliably, and unreliable locking is exactly what leasing depends on. One host
  with several processes is fine. Several hosts is what the Postgres move in
  [Storage](#storage) is for.
- **Rate limits and the `/api/poll` cooldown are per process**, held in memory.
  N workers means up to N times those budgets for one source address. The
  expensive thing behind them, an upstream request, is still deduplicated by the
  target lease whichever worker asks, so this is a looseness rather than a hole.

`GET /api/stats` reports `leasedTargets`, which is roughly how much work the
fleet has in flight.

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

**Permanent failures skip the ladder.** A transport that throws
`PermanentDeliveryError` fails the notification on the first attempt. Retrying a
mistyped address or a 550 four more times does not deliver it, and it leaves
five identical rows where the real reason should be. This mirrors
`SisError.transient` on the fetch side rather than inventing a second vocabulary
for the same idea.

Transports ship: `console`, `webhook`, and `email`. Web push and SMS slot in by
implementing the two-method `Transport` interface. `GET /api/stats` reports the
`channels` this process can actually deliver, and the web app reads it: the
watchlist offers an Email toggle only where a provider is configured, so email
is no longer reachable by curl alone.

---

## What a search covers, and what a watchlist ignores

`GET /api/sections` used to return every section in the database. With one
school configured that looks correct. The moment a second one is added, Find
classes is one list with two universities' courses shuffled into it, and no
query a student can type separates them, because course codes collide across
campuses and CRNs collide in the same term.

So catalog search is scoped to three things, and for a signed-in student they
come from the account:

| Scope | Where it comes from | Widening it |
|---|---|---|
| School | `users.school_id` | `?school=<id>`, or `?school=any` |
| Term | `users.term` | `?term=<code>`, or `?term=any` |
| Level | `users.levels`, a list | `?level=GRAD`, repeated or comma separated, or `?level=any` |

**These are defaults, not suggestions.** An undergraduate who searches sees
undergraduate classes, in their own term, at their own school. Widening is
something the student does, by naming a school or ticking another level, and
`GET /api/sections` echoes the `scope` it applied so a client can show it rather
than leave a shorter list unexplained.

### Level is a list, and its values are not ours to invent

A senior takes a graduate seminar. A graduate student takes an undergraduate
prerequisite. A law or medical student is neither. So an account holds a *list*
of levels, and any of them matching is a match.

The codes themselves belong to the registrar. Banner installs answer UG and GR,
and also LW, MD and things nobody outside that campus has seen; PeopleSoft calls
the same idea Academic Career and answers UGRD, GRAD, LAW, MEDS. An enum of two
options would silently hide every level we had not enumerated, and the student
who loses their whole catalog is the law one. `sections.level` therefore stores
the registrar's own string for display, `sections.level_norm` stores it folded
for comparison, and `GET /api/levels?school=&term=` reads the available codes
off the catalog itself, which is where a client gets its checkboxes.

Two consequences worth stating:

- **A section the registrar never classified matches every level filter.** Null
  is not "undergraduate", it is "we were not told". An install that reports no
  level, or a field our mapping missed, would otherwise hand every scoped
  student an empty catalog that looks exactly like a school with no classes in
  it.
- **The account's term and levels only apply at the account's own school.**
  Both codes are institution-defined, so carrying `202608` and `UGRD` to a
  second school filters its catalog on codes that do not exist there. Naming a
  different school therefore drops them unless the caller sets them too.

### The watchlist is deliberately not scoped

`GET /api/watches`, `GET /api/events` and delivery ignore all three. A transfer
student keeps every watch from their old school and sees it alongside the new
ones; a senior who unticks GRAD keeps the seminar they are waiting on.

A watchlist is a record of what somebody already asked for, not a question about
what exists, and scoping it would silently drop watches while looking exactly
like the alerts working. That is the failure this whole service exists to
prevent, so there is a test asserting a watch at a school the account is no
longer set to still appears.

Because a public route's answer now depends on the credential, every response
carries `Vary: Authorization`, not only the authenticated ones. Without it a
cache in front of this could hand one student another student's scoped catalog.

---

## Email

The email is the product at the moment it matters. A student reads six words on
a lock screen and decides whether to open a laptop, so the subject carries the
whole decision (`MATH 221 B has a seat open`), the body repeats it, and the
facts needed to act sit underneath.

Both transports register on the `email` channel and one of them is chosen by
configuration, so nothing above `Transport` knows which is in use.

| Transport | Use it for |
|---|---|
| `resend` | Production. One HTTPS POST. The provider owns DKIM signing, MX resolution, bounces, and IP reputation. |
| `smtp` | Self-hosting, a corporate relay, or a local sink such as Mailpit. |

### On hand-rolling SMTP

`src/core/smtp.ts` is a real SMTP client on `node:net` and `node:tls`, not a
wrapper. That is defensible here because it does *submission*, not *delivery*:
one small message, one recipient, one known relay, one authenticated TLS socket.
It implements EHLO capability parsing, STARTTLS with the second EHLO that
RFC 3207 requires, AUTH PLAIN and AUTH LOGIN, `SIZE`, dot-stuffing, and a
timeout on every step: the TCP connect and the TLS handshake as well as each
reply. The first two used to be unbounded, and a relay that accepted the
connection and then never handshook left the send unsettled, which wedged the
notification queue and the poll loop with it for the life of the process.

Two things it deliberately does **not** do:

- **Direct-to-MX delivery.** MX lookup, DKIM signing, SPF alignment, bounce and
  complaint handling, and a warmed sending IP are a product, not a module. Use a
  relay.
- **Take nodemailer.** It is a good library with genuinely no runtime
  dependencies, and for most projects it is the right answer. Everything it
  earns its keep on (attachments, embedded images, XOAUTH2, connection pooling,
  DSN, SMTPUTF8) is absent from what ClassPik sends. Reverse this the day
  attachments or Gmail OAuth land, rather than slowly growing a worse nodemailer.

`src/core/mime.ts` is pure and has no IO, for the same reason `diff.ts` is:
these are the rules that fail silently rather than loudly. Dot-stuffing, CRLF
normalisation, RFC 2047 subject encoding with the 75-character and UTF-8
boundary rules, RFC 5322 dates built from fixed English tables, and CR/LF
rejection in every header. A course title comes from a registrar, so header
injection is a live path rather than a theoretical one.

### Configuration

Email is opt-in. With `CLASSPIK_EMAIL_PROVIDER` unset the service starts
normally and simply does not offer the channel: `GET /api/stats` omits `email`
from `channels`, and `POST /api/watches` with `"channel":"email"` returns 400.
Once the provider *is* set, a half-finished configuration is a startup error
rather than a quiet fallback, because silently not sending is the exact failure
this service exists to prevent.

| Variable | Default | Meaning |
|---|---|---|
| `CLASSPIK_EMAIL_PROVIDER` | unset | `resend` or `smtp`. Unset means no email channel. |
| `CLASSPIK_EMAIL_FROM` | required | `ClassPik <alerts@classpik.app>` or a bare address |
| `CLASSPIK_EMAIL_REPLY_TO` | unset | Where a student's reply should go |
| `RESEND_API_KEY` | required for `resend` | The `re_...` key |
| `CLASSPIK_SMTP_HOST` | required for `smtp` | Relay hostname |
| `CLASSPIK_SMTP_PORT` | `465`, or `587` with STARTTLS | Submission port |
| `CLASSPIK_SMTP_STARTTLS` | unset | `1` to use a cleartext port and upgrade. Default is implicit TLS. |
| `CLASSPIK_SMTP_USER` | unset | Set with `CLASSPIK_SMTP_PASS` or not at all |
| `CLASSPIK_SMTP_PASS` | unset | Never sent over an unencrypted socket, at any setting |
| `CLASSPIK_SMTP_REQUIRE_TLS` | on | `0` allows a cleartext send. Only for a local sink, and the startup log line says so. |

Implicit TLS is the default per RFC 8314: there is no plaintext phase and so no
downgrade window. Credentials come from the environment only. They are
ClassPik's own service credentials, never a school login, and nothing in
`src/core/email.ts`, `src/core/smtp.ts` or `src/config/email.ts` is reachable
from `src/adapters` or from a `schools/*.yaml`.

**TLS is required, not opportunistic.** STARTTLS is negotiated off a pre-TLS
EHLO, which is a reply anyone on the path can rewrite, so a stripped
`250-STARTTLS` line would otherwise put the student's address and the course
they are watching on the wire in plaintext. The transport refuses to continue in
the clear whether or not credentials are configured. `CLASSPIK_SMTP_REQUIRE_TLS=0`
is the only way past that, it exists for Mailpit, and it is printed at startup.

Watching by email is one field:

```bash
curl -s -X POST localhost:8787/api/watches -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"sectionId":"demo-university:202608:30412","channel":"email"}'
```

**Alerts go to the address on the account and nowhere else.** A caller-supplied
`target` is refused with a 403. Accepting one made this endpoint a mail bomb:
any account could aim every seat change on any section at a stranger, from our
own sending domain, and the stranger had no route that could touch the watch.
The account address itself is still unverified, which is in
[What is not done](#what-is-not-done).

### Testing it locally

The suite covers every branch with no network and no credentials: the HTTP
transport takes an injected `fetchImpl`, and the SMTP transport takes injected
`connect` and `upgrade` factories, so tests drive a real socket-shaped `Duplex`
against a scripted server transcript rather than mocking the parser out.

To watch a real message arrive, run [Mailpit](https://mailpit.axllent.org)
(or MailHog), which accepts SMTP on 1025 and serves a web inbox on 8025:

```bash
docker run --rm -p 1025:1025 -p 8025:8025 axllent/mailpit
```

```bash
CLASSPIK_EMAIL_PROVIDER=smtp \
CLASSPIK_EMAIL_FROM='ClassPik <alerts@classpik.test>' \
CLASSPIK_SMTP_HOST=localhost \
CLASSPIK_SMTP_PORT=1025 \
CLASSPIK_SMTP_STARTTLS=1 \
npm run serve -- --demo
```

Create an account, watch `demo-university:202608:30412` with
`"channel":"email"`, and the alert lands in the inbox at
http://localhost:8025 within a couple of poll cycles. This is a manual step on
purpose: `npm test` has to pass offline, so nothing in the suite talks to a
sink.

Mailpit accepts anything, which makes it useful for reading the message and
useless for judging deliverability. Alerts go to university mail filters, and a
brand-new sending domain has no reputation, so set SPF, DKIM and DMARC and warm
the domain before launch. From a student's point of view a quarantined alert and
a missing alert are the same failure.

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
5. **Give it something to poll.** A config file on its own polls nothing. Two
   routes to that, and they compose:

   ```bash
   npm run cli -- terms <schoolId>          # banner, which discovers terms upstream
   npm run cli -- subjects <schoolId> <term># record the catalogue; polls nothing
   npm run cli -- seed <schoolId> <term>    # one target per subject in the config
   ```

   `subjects` fills the browsable catalogue, which is what the service does on
   its own daily timer once the school has known terms. Nothing in it is polled
   until somebody browses a subject or watches a section, so `subjects: []` in
   the config is now a complete way to onboard a school. `seed` is still there
   for the subjects you want polled from the first tick regardless of demand.

   A PeopleSoft school lists its terms in config, so startup seeds its
   configured subjects for you. Either way, a school that ends up with zero poll
   targets says so in the startup log, naming both routes. It used to run
   silently forever instead.

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
running `npm start`, which is `tsx src/index.ts`, must not poll a real
registrar.

### Supported systems

| Adapter | Status | Notes |
|---|---|---|
| `banner9` | Built, fixture-tested | Public class search is a JSON API underneath. Endpoint shapes verified against the [nubanned](https://jennydaman.gitlab.io/nubanned/) docs. **Not yet run against a live install**; that is Phase 0. |
| `peoplesoft` | Built for **HighPoint CX only**, fixture-tested | Covers PeopleSoft schools that licensed HighPoint Campus Experience, which is where the clean JSON class search comes from. Stock installs do not have it and will 404. Field shapes reconstructed from two open-source consumers at two schools, not from a captured response. **Never run against a live install.** |
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

#### On PeopleSoft being two different systems

"PeopleSoft" names two class searches that share nothing but a vendor.

The one this adapter speaks is **HighPoint CX**, a licensed third-party add-on
whose `WEBLIB_HCX_*` scripts serve plain JSON over an unauthenticated GET: no
cookie, no term authorisation POST, no CSRF token. It preserves the economics
this whole service rests on, because one request still returns every section for
a subject.

The other is the stock `ICAction` HTML search, with a cookie jar, a monotonic
`ICStateNum` that two concurrent requests would corrupt, and numeric seat counts
only on a per-section detail page. That turns a forty-section subject into
roughly forty-five requests instead of one. It is deliberately **not** built, and
if it ever is it gets its own adapter id rather than a flag inside this one.

Three things follow, all of them covered by tests:

- **An empty first page is legitimate here.** It is how pagination ends, so it
  cannot also be the alarm Banner uses it as. The guarded failure is instead a
  200 whose body is HTML, which is what these installs answer with when
  something is wrong. Content type and parse are both checked, and either
  failing raises rather than reporting zero sections.
- **Term codes are configured, never derived.** UVA reads `1232` as Spring 2023;
  CSU Fullerton reads `2227` as Fall 2022. Same vendor, different scheme. So
  `listTerms` reads the config and makes no request. Automatic term discovery is
  unverified and therefore not attempted.
- **The subject filter is checked against what comes back.** If no returned row
  carries the subject we asked for, the adapter raises instead of quietly
  storing the entire term under one subject's target.

Config carries the per-install variation, because that is where it all lives:
`scriptPath` copied verbatim up to and including `/s/`, plus `institution`, plus
the term codes. Loading rejects a `/psp/` path, since the portal servlet
redirects to a sign-in page and would hand back HTML with a 200. See
`schools/example-peoplesoft.yaml`.

Reading a HighPoint CX install needs no account of any kind, so the
credential-free boundary is untouched. A school that exposes its class search
only behind a login cannot be monitored under this design and stays
`enabled: false`; signing in is not the workaround.

---

## API

Base URL defaults to `http://localhost:8787`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/health` | public | Liveness |
| `GET` | `/api/stats` | public | Counts across the service, plus the delivery `channels` this process offers |
| `GET` | `/api/schools` | public | Configured schools and their terms |
| `GET` | `/api/subjects` | public | The browsable catalogue. `?school=&term=`. `seeded` says whether it has ever been fetched. |
| `POST` | `/api/subjects/seed` | bearer | `{school, term, subject}`. Buys one subject its first fetch. 202 means queued, 200 means one was already bought, 404 means the school does not publish it. |
| `GET` | `/api/sections` | public | Search. `?school=&term=&subject=&level=&q=&status=&limit=`. Defaults to the caller's own school, term and levels; `any` clears one. |
| `GET` | `/api/levels` | public | The academic levels a school publishes. `?school=&term=` |
| `GET` | `/api/sections/:id` | public | One section plus its event history |
| `POST` | `/api/auth/signup` | public | `{email, password, school?, term?, levels?}`, returns a session |
| `POST` | `/api/auth/login` | public | `{email, password}`, returns a session |
| `POST` | `/api/auth/logout` | bearer | Revokes the presented session only |
| `GET` | `/api/auth/me` | bearer | The signed-in account, including what it searches in |
| `POST` | `/api/auth/preferences` | bearer | `{school?, term?, levels?}`. A patch: `null` clears a field, an absent one is left alone. |
| `POST` | `/api/watches` | bearer | `{sectionId, mode?, channel?, target?}`. `channel: "email"` always sends to the account address; a different `target` is a 403. A `webhook` target must be HTTPS and must not resolve to a private address. |
| `GET` | `/api/watches` | bearer | The caller's active watches |
| `DELETE` | `/api/watches/:id` | bearer | Stop watching. 404 for a watch you do not own. |
| `GET` | `/api/events` | bearer | The caller's events, or `?sectionId=` for one section |
| `POST` | `/api/poll` | operator | `X-Admin-Token: $CLASSPIK_ADMIN_TOKEN`. Disabled when that is unset. |

Section ids are `{schoolId}:{term}:{crn}`.

Every response carries `Cache-Control: no-store`, and authenticated ones also
`Vary: Authorization`, so no CDN in front of this can serve one account's
watches or address to another.

`POST /api/poll` is deliberately **not** something an account can do. Signup is
free and a tick fans out to a registrar with no cooldown, so "log in, then
hammer it" was a one-line way for a stranger to get our IP blocked, which is the
outcome the route's own comment claimed to prevent. It takes an operator token,
and it holds a floor of one cycle per 30 seconds however many operators ask.

### Authentication

ClassPik accounts, never a school login. The credential-free boundary is
unchanged: nothing in `src/core/auth.ts` is reachable from `src/adapters`, and
`SisAdapter` still has nowhere to put a password.

- Passwords are scrypt from `node:crypto`, per-user random salt, cost parameters
  stored alongside the digest so they can be raised without locking anyone out.
  The KDF runs on the libuv threadpool, never on the event loop: `scryptSync`
  held the whole process for ~40ms per attempt, and it is reachable from an
  unauthenticated route, so a burst of logins for addresses that do not exist
  stalled polling and delivery along with everything else. Work in flight is
  capped, and a full queue answers 503 rather than 401.
- Session tokens are 256 random bits, opaque, not JWTs. Only the SHA-256 of a
  token is stored, so a database leak yields nothing replayable. Revocation is
  a row update rather than a blocklist.
- Sessions last 30 days. Logout revokes the presented session only, so signing
  out on a laptop leaves a phone signed in. Expired rows are pruned hourly by
  the run loop.
- **The first rate limit is per source address**, not per account: 20 login or
  signup attempts a minute and 10 new accounts an hour, in memory, per process.
  An attacker who supplies addresses that do not exist has no account to limit,
  and a per-account lockout a stranger can trigger on a named victim is a denial
  of service rather than a defence.
- The per-account lockout is the secondary backstop: five consecutive failures
  lock the account for a minute, and a login arriving after the window has
  elapsed clears the counter. Without that reset the escalation ratcheted to its
  one hour cap across windows and a stranger could hold a named victim locked
  out forever, since clearing it needed the login the lock was refusing.
- **An unknown email, a wrong password and a locked account all answer 401 with
  the same message and roughly the same latency.** The one exception is a
  correct password during a lockout, which answers 429: that caller has already
  proved the account is theirs. The lockout used to answer 429 for any attempt
  on an existing account, which turned six requests per address into a bulk
  account-existence oracle.
- `POST /api/auth/signup` still answers 409 for an address that already has an
  account, which is a one-request existence oracle. It is unavoidable while
  signup is synchronous, since the alternative is silently not creating the
  account, and it is stated here rather than left in a code comment.

Routes are private by default. A new route is protected unless it says
`'public'`, which is the only default that fails safely.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP port |
| `CLASSPIK_DB` | `./classpik.db` | SQLite file |
| `CLASSPIK_DEMO` | unset | `1` runs the simulated SIS |
| `CLASSPIK_CORS_ORIGINS` | localhost dev ports | Comma-separated allowed origins |
| `CLASSPIK_ADMIN_TOKEN` | unset | Enables `POST /api/poll`, sent as `X-Admin-Token`. Unset means the route is off. |
| `CLASSPIK_ALLOW_PRIVATE_WEBHOOKS` | unset | `1` lets a watch point at loopback or an RFC1918 host. Development only: it is an SSRF primitive anywhere else. |

Email delivery has its own block of variables, all optional. See
[Email](#email).

---

## Storage

SQLite via `node:sqlite`, built into Node 22.5+. Zero native dependencies and
zero setup, with real SQL and real transactions. Every statement lives in
`src/core/repo.ts`, so moving to Postgres when this outgrows one box is a repo
rewrite rather than an app rewrite.

| Table | Holds |
|---|---|
| `users`, `sessions` | ClassPik accounts, their live bearer sessions, and the school, term and levels each account searches in |
| `schools`, `terms` | Loaded config |
| `subjects` | The browsable catalogue. A row here costs zero requests; `seeded_at` is what changed that. |
| `poll_targets` | The polling unit, one per (school, term, subject), plus the worker lease |
| `sections` | Current state, with `present` flagging sections that vanished upstream and `level` carrying the registrar's academic level |
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

604 tests across seventeen files. The adapter is tested against recorded response
shapes rather than a live registrar: pointing load at a university to test our
own code would be rude, and a suite that depends on their uptime is a suite that
fails during their maintenance window.

| File | Covers |
|---|---|
| `diff.test.ts` | Change detection, including the never-notify-on-first-sight rule and negative seat counts from over-enrolled sections |
| `schedule.test.ts` | Interval policy, backoff ordering, bounds, jitter spread |
| `http.test.ts` | Rate limiting, per-host concurrency, retry, `Retry-After`, slot leaks |
| `banner.test.ts` | Handshake ordering, session reuse, paging, the empty-page trap, field mapping |
| `peoplesoft.test.ts` | Seat mapping across the string and number spellings of the same field, paging, the HTML-with-a-200 trap, an ignored subject filter, config validation |
| `repo.test.ts` | Schema, migration over populated tables, nested transactions, target claiming, dedupe, notification idempotency |
| `lease.test.ts` | Two pollers on two connections to one database file: one request per subject across the fleet, disjoint claims, recovery from a worker that died holding one |
| `discovery.test.ts` | A 180 subject catalogue producing zero poll targets, the on-demand seed and its refusals, one fetch and then quiet |
| `poller.test.ts` | The full loop, failure handling, adaptive intervals, discovery on the run loop |
| `notify.test.ts` | Delivery, retry, backoff, transport routing, webhook SSRF refusals, permanent versus transient failure |
| `mime.test.ts` | Dot-stuffing, CRLF, encoded words and their UTF-8 boundaries, header injection, address validation, message assembly |
| `email.test.ts` | Alert copy, the Resend transport's every status branch, key leakage, env configuration, delivery through the real queue |
| `smtp.test.ts` | The full submission sequence against a scripted server: multiline replies, split and merged chunks, STARTTLS and the refusal to send without it, AUTH, 4xx versus 5xx, connect and handshake timeouts against real sockets, socket cleanup |
| `api.test.ts` | Every route, validation, CORS, cache headers, the operator gate on `/api/poll` |
| `scoping.test.ts` | Level normalisation, level from adapter to row, search scoped by school, term and level, account defaults and explicit widening, and the watchlist staying unscoped across a transfer |
| `auth.test.ts` | Hashing off the event loop, tokens, per-address and per-account limits, the absence of an enumeration oracle, expiry, revocation, and watch ownership between two accounts |
| `config.test.ts` | Validation including the politeness floor, and school registration seeding its poll targets |

---

## What is not done

Stated plainly so nobody is surprised:

- **Neither the Banner nor the PeopleSoft adapter has run against a live
  install.** Both are built to a documented contract and tested against recorded
  shapes. Phase 0 verifies them. The PeopleSoft one is the weaker of the two:
  its field names come from two open-source consumers of the API rather than
  from a response anyone captured, and the page size of its class search is
  unknown, so the per-subject request count is a guess until measured.
- **Academic level has never been read off a live install.** Both adapters map
  it to a documented field, Banner's `levels` and PeopleSoft's `acad_career`,
  and neither has been seen in a real response. A missing field leaves sections
  unclassified, which shows them to every level rather than hiding them, so
  being wrong here costs breadth and not classes.
- **A cross-listed section keeps only its first level.** Banner reports several
  and a section holds one here, so a graduate student searching for a section
  whose primary level is undergraduate will not find it under a GRAD filter.
  Widening to `?level=any` does find it.
- **Stock PeopleSoft is not covered**, only HighPoint CX. The `ICAction` HTML
  search is a different cost model and would be a separate adapter.
- **The Workday adapter does not exist.**
- **Notification transports are console, webhook and email.** Web push and SMS
  are interface implementations away, but they are not written.
- **No unsubscribe link in the alert email.** RFC 8058 one-click unsubscribe
  needs an idempotent HTTPS endpoint behind an HMAC-signed token, and Gmail
  requires it of any sender above 5,000 messages a day, which an add/drop window
  will cross. The alert says how to stop it in the app instead. A header
  pointing at a URL that does nothing would be worse than none.
- **No email verification and no password reset.** An address is taken on trust
  at signup, and a forgotten password currently means a new account. Alerts only
  ever go to the account's own address, so the old "point a watch at anyone"
  hole is closed, but somebody can still sign up as an address they do not own
  and mail themselves alerts at it. A confirmation step at signup is the fix and
  it is not written.
- **No way to revoke every session at once.** `Repo.revokeSessionsForUser`
  exists and nothing calls it, because there is no password change and no reset
  route to call it from. A user whose token leaks has to wait out the 30 day TTL
  on every session but the one they can log out of.
- **The SMTP client has never spoken to a production relay.** It has been run
  against a local sink over a real socket, and against scripted transcripts in
  the suite. It has not met a relay that enforces TLS, rate limits, or greylists,
  so `resend` is the supported production path today.
- **Multi-worker is one host.** Several pollers now share a database safely, and
  the fleet spends one request per subject however many are running. What is not
  solved is *several machines*: that needs a database that locks properly over a
  network, which SQLite is not. See
  [Running more than one worker](#running-more-than-one-worker). The
  per-process rate limiters and the `/api/poll` cooldown are also per worker,
  which is stated there rather than pretended away.
- **Subject discovery has only run against fixtures.** `listSubjects` is
  implemented on both adapters and neither has met a live install, so the shape
  and size of a real catalogue is a documented contract rather than a measured
  one. The refusal to poll what it finds does not depend on that being right.
- **Discovery runs on every worker.** Two workers means two catalogue requests
  per school per day instead of one. Left alone deliberately: it is a daily
  request, and leasing it would be more machinery than the saving is worth.
- **A browse-seeded subject nobody watches leaves a poll target behind.** It is
  polled once and then never again, so it costs no requests, but the row stays
  and counts toward `targets` in `/api/stats`. Nothing prunes it.

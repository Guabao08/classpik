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
npm test          # 793 tests
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

It asks about the **newest three terms per school, not every term stored**. The
terms table holds whatever the SIS volunteered, and Banner answers `getTerms`
with up to fifty including archived "View Only" ones. Discovering all of them is
roughly a hundred and fifty back-to-back requests at one registrar, long enough
that the tick budget aborted the run partway through and the tail of the list was
never reached. Nobody registers for a term from four years ago.

It also runs beside the poll tick rather than in front of it, and reschedules
from the outcome: a run that did not finish, or that finished with a school
unanswered, is retried in minutes rather than counted as done and left for a day.

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
  because a target that has *succeeded* at least once is only claimed while a
  live watch points into it. Curiosity costs one request, not a subscription.

That last rule is keyed on having succeeded, not on having been attempted, and
the difference is the whole feature. A subject's first fetch is the one that
creates its sections, and a watch can only name a section, so a single 503 on a
bootstrap fetch used to remove that subject from the catalog permanently: no
sections existed for a watch to point at, `active` stayed 1 because a transient
error is not a permanent one, `/api/stats` counted it as healthy, and browsing it
again answered "already". A target that has never once produced anything stays
claimable, on the error backoff `next_poll_at` already carries. `active = 0` is
still the permanent off switch for a genuine 4xx.

`GET /api/subjects?school=&term=` returns the catalogue with a `seeded` flag per
row, so a client can tell "no sections here yet" apart from "no sections". The
web app uses both routes: Find classes lists the discovered catalogue and opening
an unfetched subject posts the seed.

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

Several pollers may share one database, in one process or several on one host. Work
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

Every lease carries an expiry, default two minutes, and **the holder renews its
own while the fetch is in flight**. Both halves are load-bearing:

- Without the expiry, a worker killed between claiming a target and recording the
  result holds it forever, and the students watching sections in it simply stop
  being told anything with nothing anywhere saying why.
- Without renewal, the expiry is a fiction. One `fetchSections` is the session
  handshake plus two requests per page, each of which may retry, and each retry
  honours `Retry-After` up to a minute. A fetch can legitimately run several
  times two minutes, and the window where a second worker claims the same subject
  opens precisely when the registrar is rate limiting us, which is the worst
  possible moment to double our request rate. `PoliteClient` now also caps one
  `request()` at a total budget rather than at a product of limits, so there is a
  number to reason about.

A worker that has lost its lease anyway cannot take it back: renewal is scoped to
the current owner, and so is the lease-clearing half of recording a result, so a
late worker reporting back never unlatches the worker that replaced it. A target
is claimed one at a time rather than in a batch, so two workers interleave
through the same due list instead of one taking the whole batch.

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
than leave a shorter list unexplained. The web app renders that echo above the
results and names the part of it that emptied a list.

**Codes do not travel between schools, and moving school drops them.** Term and
level codes are institution-defined: 202608 is Fall 2026 at one school and
nothing at all at the next, and UGRD at a PeopleSoft school is UG at a Banner
one. Carried across, they filter the new school's catalog on codes it has never
published, which returns nothing and reads as a school we failed to load rather
than as a filter. So both the per-request path and `POST /api/auth/preferences`
drop them: patching only `school` clears the levels, and clears the term too
where the new school's known terms prove it meaningless. A request that states
levels itself is honoured, and clearing school to `null` keeps them, since an
account with levels and no school asked for undergraduate classes wherever they
are.

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

**Alerts go to the address on the account and nowhere else, and only once that
address has been proved.** A caller-supplied `target` is refused with a 403.
Accepting one made this endpoint a mail bomb: any account could aim every seat
change on any section at a stranger, from our own sending domain, and the
stranger had no route that could touch the watch. Restricting it to the account
address closed that door and left another one open, since signup took the
address on trust, so the channel now also needs
[a confirmed address](#account-recovery).

The provider configured here also carries the two account emails, the
confirmation link and the reset link. One provider, one set of credentials, one
sending domain: a reset link arriving from a different address than the alerts do
is one a student has every reason to distrust.

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

Create an account and the confirmation mail is the first thing in the inbox at
http://localhost:8025. Open its link, which needs the web app running or a
`curl` to `POST /api/auth/verify`, then watch `demo-university:202608:30412`
with `"channel":"email"` and the alert lands in the same inbox within a couple
of poll cycles. This is a manual step on purpose: `npm test` has to pass
offline, so nothing in the suite talks to a sink.

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
| `banner9` | Built, fixture-tested, **public search verified live** | Public class search is a JSON API underneath. Endpoint shapes verified against the [nubanned](https://jennydaman.gitlab.io/nubanned/) docs, and the full handshake this adapter performs was run against **Georgia Tech on 2026-07-29**, logged out: 1751 CS sections for Fall 2026 with every seat field present. `schools/gatech.yaml` is committed with every value read off those responses. Enrollment replay, Phase 0 Part A, is still unanswered. |
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
| `GET` | `/api/stats` | public | Counts across the service, the delivery `channels` this process offers, and `accountMail`: whether verification and reset links reach a mailbox or the log |
| `GET` | `/api/schools` | public | Configured schools and their terms |
| `GET` | `/api/subjects` | public | The browsable catalogue. `?school=&term=`. `seeded` says whether it has ever been fetched. |
| `POST` | `/api/subjects/seed` | bearer | `{school, term, subject}`. Buys one subject its first fetch. 202 means queued, 200 means one was already bought, 404 means the school does not publish it. |
| `GET` | `/api/sections` | public | Search. `?school=&term=&subject=&level=&q=&status=&limit=`. Defaults to the caller's own school, term and levels; `any` clears one. |
| `GET` | `/api/levels` | public | The academic levels a school publishes. `?school=&term=` |
| `GET` | `/api/sections/:id` | public | One section plus its event history |
| `POST` | `/api/auth/signup` | public | `{email, password, school?, term?, levels?}`, returns a session |
| `POST` | `/api/auth/login` | public | `{email, password}`, returns a session |
| `POST` | `/api/auth/logout` | bearer | Revokes the presented session only |
| `POST` | `/api/auth/password` | bearer | `{currentPassword, password}`. Revokes every **other** session and keeps yours. |
| `POST` | `/api/auth/verify/request` | bearer | Mails the confirmation link again |
| `POST` | `/api/auth/verify` | public | `{token}`. Proves the address. Single use, 24 hours. |
| `POST` | `/api/auth/reset/request` | public | `{email}`. Always 202, with the same body and the same timing whether or not the address exists. |
| `POST` | `/api/auth/reset` | public | `{token, password}`. Single use, one hour, and it revokes every session. |
| `GET` | `/api/auth/me` | bearer | The signed-in account, including what it searches in and whether its address is confirmed |
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
  **This is only true if the monitor can see the source address.** It reads
  `req.socket.remoteAddress`, which is the client on a direct listen and the
  proxy behind a load balancer, and behind a proxy every limiter here collapses
  into one global bucket: 20 sign-in attempts a minute for the entire user base,
  ten reset links an hour for everybody together. Naming the header the proxy
  writes, with `CLASSPIK_CLIENT_IP_HEADER`, is what restores the per-student
  behaviour. It is opt-in because a header no proxy overwrites is a rate limit
  every client picks for themselves. See
  [the deployment variables](#the-environment-variables-that-matter-in-a-deployment).
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

### Account recovery

Three gaps used to sit here, and they were the reasons a real student could not
use this: an address was taken on trust, a forgotten password meant a new
account, and `Repo.revokeSessionsForUser` existed with nothing calling it.

All three run on one mechanism, `auth_tokens`: a 256-bit opaque secret, stored
as its SHA-256 and never in the clear, single use, with an expiry and a purpose.
The purpose is part of the *lookup* rather than something read off the row
afterwards, so the 24 hour link mailed at signup can never be presented to the
reset route, which would make it a longer-lived and more powerful secret than
the one hour reset flow deliberately issues. Every refusal (unknown, spent,
expired, wrong purpose) is the same 400 with the same message.

**Consuming a token is one `UPDATE ... RETURNING`**, for exactly the reason
`claimTargets` is. SQLite runs it in its own implicit transaction with the write
lock held, so two requests carrying the same link are serialised and the second
sees `consumed_at` already set. A SELECT-then-UPDATE would let both read before
either wrote, and a reset that can be performed twice is one an attacker replays
out of a mail archive after the victim has already used it.

#### What being unverified actually costs

**An unverified account cannot send alerts to email.** That is the whole of it,
and it is the exact abuse: signup takes an address on trust, so without this
anyone can sign up as somebody else's address and have ClassPik mail them from
our own sending domain indefinitely, with no route the recipient can use to stop
it. It is the same hole the refused caller-supplied `target` closed, reached by a
different door.

Everything else keeps working. Signin is not blocked, search is not blocked, and
watches are not blocked; only the channel that reaches a mailbox nobody has
proved they read. Blocking signin would punish a student for a step they may
simply not have got to, and it would make a mail provider outage a total outage.
`GET /api/auth/me` reports `emailVerified`, and the web app shows a banner with a
resend button rather than a greyed-out toggle with no explanation.

#### The reset request route answers the same way to everyone

`POST /api/auth/reset/request` returns the identical 202 and the identical body
whether or not the address has an account, and it returns them in the same time.
All three are oracles. The login route already burns scrypt time on an unknown
address so its timing matches, and there is a test pinning it; a hole here would
undo that with an endpoint that needs no password at all.

Three things make it hold, and each is load-bearing:

- **Nothing about the outcome reaches the response.** The body is a constant.
- **No work behind the lookup happens before the response is written.** Not
  awaiting the send is one await too late on its own: an async function body runs
  synchronously up to its first await, and the first await inside `issueRecovery`
  is the send, so the budget check, the `randomBytes` and the `INSERT` all landed
  on the response path. Measured against 5000 rows that was a deterministic
  sub-millisecond difference between the two branches, which twenty samples per
  candidate address sort out cleanly. The whole call sits behind `setImmediate`.
  The cost is that the per-account budget becomes approximate rather than exact,
  since two simultaneous requests can both read the count before either writes.
  That is the right way round: an off-by-one on links per hour is a nuisance, an
  enumeration oracle over a campus is the thing this route exists to prevent.
- **The per-account throttle is silent, and the silence has a price.** A caller
  cannot tell a throttled request from a delivered one, which is the point, and
  it also means a student whose allowance somebody else drained gets a confident
  202, no link, and no way to distinguish that from a mail problem. So the budget
  is split rather than keyed on the account alone:
  **five links an hour per (account, errand, source address)**, which is what any
  one caller can spend, and **twenty an hour per account from everyone together**
  as the mail-bomb ceiling. A cron hammering `victim@school.edu` from one address
  therefore takes nothing from the victim asking from their own machine. Only the
  per-source-address limit, ten an hour, is allowed to answer 429, and it does not
  depend on which address was named.

#### The link is spent last, after everything that can fail

`POST /api/auth/reset` hashes the new password **before** it consumes the token,
not after. `hashPassword` throws once the KDF queue is full, and that queue is
reachable from the unauthenticated login route by design, so a burst of logins
used to turn any reset landing in the same window into a 503 with `consumed_at`
already set: a dead link, an unchanged password, and a student told to come back
later to a link that no longer works. Five such collisions exhaust an account's
whole hourly allowance. Hashing first costs nothing new, since the work is
already bounded by the length check and the per-address budget above it and is
exactly what `POST /api/auth/login` pays for an address it has never seen.

#### What a completed reset does

Sets the password, **revokes every session**, burns every other outstanding reset
link, clears the lockout, and marks the address verified. Each part matters: a
reset is what somebody does after losing control of their account, so leaving the
intruder's thirty-day bearer token alive would change nothing they would notice;
a panicked student clicks the button three times and two of those links are still
live keys; forgetting a password is how you get locked out in the first place;
and reading the link *is* the proof a verification link asks for, so requiring a
second round trip to establish a fact already established would be ceremony.

It hands back no session. Signing in with the new password is the step that
proves the reset worked.

#### Password change is the one that keeps you signed in

`POST /api/auth/password` needs the current password even though the session
already authenticates the caller, because those authenticate different things:
the session says this browser was signed in at some point, the password says the
person at the keyboard is the account holder. It revokes every **other** session
and spares the caller's, which is what makes a leaked token recoverable in one
request rather than by waiting out a thirty day TTL on a session nobody can name.
It deliberately does not touch the login lockout counter, since a borrowed tab
guessing here would otherwise lock the owner out through a route that already
needs their session.

#### With no email provider configured

The service still works and signup still succeeds: the link is **printed to the
log** instead of mailed. A verification step nobody can complete is worse than
none, and a monitor that refuses to sign anybody up because nobody has signed up
to Resend yet is a monitor nobody can try.

In that mode this process is the mail transport and its console is the inbox, so
**treat the log as sensitive**. It is printed at startup in those words, and
louder when `CLASSPIK_APP_URL` is not localhost, because then the people opening
those links are students who cannot read this log.

**`GET /api/stats` reports `accountMail`,** which is the honest answer to "will a
reset link reach a mailbox". It is a separate fact from `channels`, which is
about seat alerts and says nothing about account mail. The recovery screens read
it and say plainly that this instance cannot send mail, rather than rendering
"Check your email" over a link that is sitting in `docker logs`. Without that,
somebody who cannot sign in and never gets a link creates a second account, which
strands every watch on the first one and is the exact outcome this flow exists to
prevent.

Once a provider is set, a token reaches no log line on any path, including the
failure path. Both halves are covered by tests.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP port |
| `CLASSPIK_DB` | `./classpik.db` | SQLite file |
| `CLASSPIK_DEMO` | unset | `1` runs the simulated SIS |
| `CLASSPIK_CORS_ORIGINS` | localhost dev ports | Comma-separated allowed origins |
| `CLASSPIK_ADMIN_TOKEN` | unset | Enables `POST /api/poll`, sent as `X-Admin-Token`. Unset means the route is off. |
| `CLASSPIK_ALLOW_PRIVATE_WEBHOOKS` | unset | `1` lets a watch point at loopback or an RFC1918 host. Development only: it is an SSRF primitive anywhere else. |
| `CLASSPIK_APP_URL` | `http://localhost:5173` | Where the web app lives. Verification and reset links point here, so a deployment that leaves it at the default mails students a link to their own laptop. |
| `CLASSPIK_CLIENT_IP_HEADER` | unset | The header a **trusted** proxy writes the client address into, e.g. `Fly-Client-IP` or `X-Forwarded-For` (the last hop is read). Unset means the socket address, which is right only when this process is what clients connect to. Behind a proxy, unset turns every per-address rate limit into one global bucket. |

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
| `auth_tokens` | Verification and reset links, as digests. Single use, with an expiry and a purpose. A leak of this table performs no reset. |
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

## Deployment

The thing to hold in your head is that **this service is a process that owns a
file**. Not a request handler that happens to keep some state: a poll loop that
must still be running at 2 AM when a senior drops the seat somebody has been
waiting three weeks for, writing to a SQLite database that exists at one path on
one disk.

Both halves of that rule out the obvious hosts. A serverless platform ends the
process when the request ends, so the loop never ticks, and its filesystem is
scratch space, so the database is gone between invocations. What is needed is
dull: one container, one persistent disk, always on.

### It deploys as ONE instance

Say this out loud before reading the commands.

The database is a single file on a single machine's disk. Several poller
processes may share that file **on one host**, which is what
[Running more than one worker](#running-more-than-one-worker) describes and what
the target lease makes safe. Several *machines* is not supported, because
SQLite's locking is not reliable over a network filesystem and leasing is built
directly on that locking. Two hosts would either corrupt the file or, more
likely on a platform that gives each machine its own volume, quietly run two
independent services with two databases, two sets of accounts, and double the
request rate at every registrar.

So: `fly scale count 1`, one Kubernetes replica, one container. **Scaling past
one host means moving to Postgres.** That is a `src/core/repo.ts` rewrite, which
is exactly why every statement lives in that one file, and it is not done. Grow
this by making the machine bigger, not by adding machines.

### Build and run it locally

Build context is `apps/monitor`. Three stages: compile TypeScript, resolve
production dependencies cleanly, then assemble a runtime image that contains
node, `yaml`, the compiled `dist/`, and the school configs. No compiler, no test
runner, no `tsx`.

```bash
cd apps/monitor
docker build -t classpik-monitor .
docker volume create classpik_data
```

```bash
docker run -d --name classpik \
  -p 8787:8787 \
  -v classpik_data:/data \
  -e CLASSPIK_APP_URL=http://localhost:5173 \
  -e CLASSPIK_CORS_ORIGINS=http://localhost:5173 \
  -e CLASSPIK_ADMIN_TOKEN="$(openssl rand -hex 32)" \
  classpik-monitor
```

```bash
docker logs -f classpik
curl -s localhost:8787/health
docker inspect --format '{{.State.Health.Status}}' classpik
```

`/health` is what the image's `HEALTHCHECK` polls, using Node's built-in
`fetch` rather than a `curl` installed for the purpose.

**The volume is not optional.** Drop `-v` and the database lands in the
container's writable layer, where the next `docker run` of a rebuilt image
starts from an empty file: every account, watch and event gone, with no error
anywhere, because an empty database is a perfectly valid database. The image
declares `/data` as a volume so the worst case is an anonymous one rather than a
layer, but name it, so you can find it again.

To watch the whole loop without touching a registrar, add `--demo`, which is
passed straight through to the app:

```bash
docker run --rm -p 8787:8787 -v classpik_data:/data classpik-monitor --demo
```

**A fresh container polls nothing at all.** `schools/gatech.yaml` ships
`enabled: true`, but a Banner school has no terms until somebody fetches them
and no poll targets until somebody seeds one, so a container that has just
started makes zero upstream requests. Giving it work is the same two commands as
anywhere else, against the compiled CLI:

```bash
docker exec classpik node dist/cli.js terms gatech
docker exec classpik node dist/cli.js subjects gatech 202608
docker exec classpik node dist/cli.js seed gatech 202608
```

### The environment variables that matter in a deployment

The full list is in the Configuration table under [API](#api); these are the
ones whose default is wrong once this is not on your laptop.

| Variable | Set it to | What goes wrong otherwise |
|---|---|---|
| `CLASSPIK_DB` | A path inside the mount, `/data/classpik.db` | The database sits in an image layer and is discarded on the next deploy |
| `CLASSPIK_APP_URL` | The public web app origin | Verification and reset links point at `localhost:5173`, so every student gets a link to their own laptop |
| `CLASSPIK_CORS_ORIGINS` | The same origin, comma separated if several | The browser blocks every call and the app looks broken with nothing in the monitor's log |
| `CLASSPIK_CLIENT_IP_HEADER` | The header your proxy writes, `Fly-Client-IP` on Fly, `X-Forwarded-For` behind nginx, Caddy or an ALB | Every request looks like it came from the proxy, so all five rate limits become one global bucket: 20 sign-in attempts a minute for the whole user base, and a service-wide ceiling of ten reset links an hour that one loop can hold at zero |
| `CLASSPIK_EMAIL_PROVIDER` | `resend` (or `smtp`), with the rest of the [Email](#email) block | Nothing is mailed. Verification and reset links are printed to the container log, so a student who forgets their password cannot recover the account. The service starts fine and says so at startup, which is not the same as being usable |
| `CLASSPIK_ADMIN_TOKEN` | 32 random bytes, as a secret | See below |
| `PORT` | Whatever the platform routes to, `8787` in the image | Health checks fail against a port nothing is listening on |
| `CLASSPIK_ALLOW_PRIVATE_WEBHOOKS` | Leave unset | It is an SSRF primitive: a watch could aim our server at the platform's own metadata service |

`openssl rand -hex 32` is a fine way to produce the admin token. Never commit
it; on Fly it belongs in `fly secrets`, not in `[env]`.

#### CLASSPIK_ADMIN_TOKEN, and what a deployment without one gives up

`POST /api/poll` is the manual "go and look now" button, and it is **disabled
outright when `CLASSPIK_ADMIN_TOKEN` is unset**. That is the safe default and
the startup log says so in as many words, but the consequence is worth stating:
a deployed instance with no admin token has no way to force a poll. You wait for
the next tick, and after an error the ladder can have backed that off to an
hour. There is no route an account can use instead, deliberately, because signup
is free and a tick fans out to a registrar.

Set it if you expect to operate this thing:

```bash
curl -s -X POST https://your-monitor.example/api/poll -H "X-Admin-Token: $CLASSPIK_ADMIN_TOKEN"
```

It still holds a floor of one cycle per 30 seconds, per process, however many
operators ask.

#### Email

Alerts are the product, so configure this. The variables are documented in full
under [Email](#email); the deployment-shaped version is that
`CLASSPIK_EMAIL_PROVIDER` is unset by default, in which case the service starts
fine, drops `email` from `GET /api/stats` channels, refuses `"channel":"email"`
watches with a 400, and **prints verification and reset links to the log**. That
last part is why an unconfigured deployment's log is a credential store.

`resend` is the supported production path. One HTTPS POST, and the provider owns
DKIM, MX, bounces and IP reputation:

```bash
fly secrets set \
  CLASSPIK_EMAIL_PROVIDER=resend \
  CLASSPIK_EMAIL_FROM='ClassPik <alerts@classpik.app>' \
  RESEND_API_KEY=re_xxxxxxxxxxxx
```

`smtp` is there for a corporate relay or a local sink, and has never spoken to a
production relay. Either way the provider set here also carries the two account
emails, so the reset link and the alert arrive from the same domain.

Set SPF, DKIM and DMARC on the sending domain and warm it before launch. A
quarantined alert and a missing alert are the same failure to a student.

### Fly.io

`fly.toml` is committed and annotated. Fly is a reasonable default here for one
narrow reason: it will attach a persistent volume to a single machine and keep
that machine running, which is the entire requirement. **Render, Railway, a
plain VPS with `docker compose`, or Kubernetes with one replica and a
ReadWriteOnce volume are all equally correct.** What is not correct is Vercel,
Netlify, Cloudflare Workers, or Lambda, for the reasons at the top of this
section. Nothing in the image is Fly-specific.

```bash
cd apps/monitor
fly launch --no-deploy --copy-config --name classpik-monitor
fly volumes create classpik_data --region iad --size 1
```

```bash
fly secrets set \
  CLASSPIK_ADMIN_TOKEN="$(openssl rand -hex 32)" \
  CLASSPIK_EMAIL_PROVIDER=resend \
  CLASSPIK_EMAIL_FROM='ClassPik <alerts@classpik.app>' \
  RESEND_API_KEY=re_xxxxxxxxxxxx
```

Edit the two placeholder origins in `[env]` to your real web app URL, then:

```bash
fly deploy
fly logs
curl -s https://classpik-monitor.fly.dev/health
```

Three settings in that file are load-bearing, and changing them breaks the
service in ways that do not look like breakage:

- **`auto_stop_machines = false`.** Fly's default stops a machine when HTTP
  traffic goes quiet. This service does its real work with no traffic at all, so
  an idle-suspended machine is a monitor that has silently stopped monitoring.
- **`strategy = "immediate"`.** One machine, one volume, one writer. A strategy
  that runs old and new together cannot attach the volume twice.
- **`[[mounts]]` pointing at `/data`,** matching `CLASSPIK_DB`. A machine with a
  mount declared and no volume created does not start at all, which is the
  failure mode you want compared to the alternative.

If the first boot logs `the data directory /data is not writable`, the volume
came up owned by root and the process runs as uid 1000. The entrypoint prints
the fix; it is a one-time step, and Fly's SSH works even while the app is
restarting:

```bash
fly ssh console -C 'chown 1000:1000 /data'
```

Back it up. A single file on a single volume is a single thing to lose:

```bash
fly volumes snapshots list <volume-id>
```

### Pointing the web app at a deployed monitor

`apps/web` reads its API base from `VITE_API_URL`, falling back to
`http://localhost:8787`:

```bash
cd apps/web
echo 'VITE_API_URL=https://classpik-monitor.fly.dev' > .env.production
npm run build
```

Two things that catch people:

- **Vite bakes this in at build time.** It is not read from the environment when
  the page loads, so changing the monitor's URL means rebuilding and
  redeploying the web app, not restarting anything.
- **It must match `CLASSPIK_CORS_ORIGINS` on the monitor, from the other
  direction.** `VITE_API_URL` is where the browser sends requests;
  `CLASSPIK_CORS_ORIGINS` is the list of origins the monitor will answer. Get
  one wrong and every call fails in the browser with nothing in the monitor's
  log, because a rejected preflight never reaches a route.

### Serving the web app

Serve `apps/web/dist` from anywhere static. It has none of the constraints the
monitor does, and exactly one requirement:

**Every path must return `index.html`.** `/verify` and `/reset` are where the
emailed links land, `/app` is what a student bookmarks, and none of them is a
file in `dist/`. A host that looks for one returns 404, so the token was valid,
the monitor was healthy, the code was right, and the student still could not get
back into their account. Vite's dev server does this on its own because
`vite.config.ts` sets `appType: 'spa'`, which is a dev-and-preview setting and
carries nothing into a built bundle.

`apps/web/public/_redirects` is committed and Vite copies `public/` into `dist/`
verbatim, so **Netlify and Cloudflare Pages need nothing further**. Everything
else needs the one-line equivalent:

```nginx
# nginx
location / {
  root /srv/classpik;
  try_files $uri /index.html;
}
```

```caddyfile
# Caddy
root * /srv/classpik
try_files {path} /index.html
file_server
```

```json
// vercel.json
{ "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }
```

On S3 and CloudFront, set both the default root object and the 404 (and 403)
error response to `/index.html` with a 200 status. On GitHub Pages there is no
rewrite at all, so copy `index.html` to `404.html` at deploy time.

The way to check is to open `https://your-web-app.example/reset?token=whatever`
directly, not by clicking through from `/`. In-app navigation never touches the
host's router, so a broken rewrite looks perfect right up until the first email
goes out.

---

## Tests

```bash
npm test
```

793 tests across twenty-one files. The adapter is tested against recorded response
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
| `api.test.ts` | Every route, validation, CORS, cache headers, the operator gate on `/api/poll`, and which address a rate limit is charged to behind a proxy |
| `scoping.test.ts` | Level normalisation, level from adapter to row, search scoped by school, term and level, account defaults and explicit widening, and the watchlist staying unscoped across a transfer |
| `auth.test.ts` | Hashing off the event loop, tokens, per-address and per-account limits, the absence of an enumeration oracle, expiry, revocation, and watch ownership between two accounts |
| `recovery.test.ts` | Verification and reset end to end through a captured mailbox: single use, expiry, purpose scoping, a link that cannot act on another account, reset revoking every session, change keeping the caller signed in, the reset request route not leaking existence in status, body or timing, and a token appearing in no response body and no log line. Also that the reset request route writes its response before any work behind the address begins, that a reset failing mid-flight leaves the link spendable, and that one source draining an account's links leaves the account holder's own share intact |
| `config.test.ts` | Validation including the politeness floor, and school registration seeding its poll targets |
| `frontdoor.test.ts` | The claims a new reader meets first: the no em dash rule scanned over every text file including dotfiles, the root README's test count and gatech flag against what is actually committed, the SPA rewrite an emailed link lands on, and the resend copy telling the truth about a link that was not sent |

---

## What is not done

Stated plainly so nobody is surprised:

- **The PeopleSoft adapter has never run against a live install.** Its field
  names come from two open-source consumers of the API rather than from a
  response anyone captured, and the page size of its class search is unknown, so
  the per-subject request count is a guess until measured. The Banner adapter is
  in better shape: its public search path was verified live at Georgia Tech on
  2026-07-29 with a committed config, which is Phase 0 Part B. What neither has
  is enrollment, which is Part A and needs an open registration window.
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
- **There is no way to change the address on an account.** Verification, reset
  and the email channel are all built, but the address itself is whatever was
  typed at signup. A student who typos it, or who graduates off a university
  address, has to make a second account and re-create every watch. The token
  layer is already ready for it (each token records the address it was mailed to
  and refuses to act once that address has changed), so this is a route and a
  confirmation step, not a redesign.
- **Nothing reacts to a bounce.** A confirmed address can stop existing, and
  when it does the alerts fail into `notifications.failed` where only an
  operator looks. Resend reports bounces on a webhook we do not receive, and
  the SMTP transport would need the relay's DSN, so today the student's own
  address going dead looks the same to them as no seat ever opening.
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
- **The Dockerfile has never been built.** It was written on a machine with no
  Docker installed. What *is* verified is the part it depends on: `npm run
  build` compiles the whole of `src/` under the same strict settings as
  `npm run typecheck`, and the compiled `node dist/index.js --demo` starts,
  migrates a database and answers `/health` with a 200. The image assembly
  around that is unproven, so treat the first `docker build` as the test.
- **`fly.toml` has never been deployed.** No Fly app exists, no account was
  created, and the region, machine size and volume size in it are defaults
  rather than measurements.
- **Nothing backs the database up.** It is one file on one volume. Fly's volume
  snapshots are the fallback and they are a platform feature, not something this
  service arranges, checks, or restores from. There is no export command.
- **There is no CI.** The tests and both typechecks are things somebody runs.
  Nothing stops an image being built from a commit that fails them, other than
  the image build itself running `tsc`, which catches type errors and no test
  failures at all.

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
npm test          # 405 tests
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

**Permanent failures skip the ladder.** A transport that throws
`PermanentDeliveryError` fails the notification on the first attempt. Retrying a
mistyped address or a 550 four more times does not deliver it, and it leaves
five identical rows where the real reason should be. This mirrors
`SisError.transient` on the fetch side rather than inventing a second vocabulary
for the same idea.

Transports ship: `console`, `webhook`, and `email`. Web push and SMS slot in by
implementing the two-method `Transport` interface.

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
RFC 3207 requires, AUTH PLAIN and AUTH LOGIN, `SIZE`, dot-stuffing, and
per-command timeouts.

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

Implicit TLS is the default per RFC 8314: there is no plaintext phase and so no
downgrade window. Credentials come from the environment only. They are
ClassPik's own service credentials, never a school login, and nothing in
`src/core/email.ts`, `src/core/smtp.ts` or `src/config/email.ts` is reachable
from `src/adapters` or from a `schools/*.yaml`.

Watching by email is one field:

```bash
curl -s -X POST localhost:8787/api/watches -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"sectionId":"demo-university:202608:30412","channel":"email"}'
```

`target` defaults to the address the account signed up with. Pass one explicitly
to send somewhere else.

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
| `GET` | `/api/sections` | public | Search. `?school=&term=&subject=&q=&status=&limit=` |
| `GET` | `/api/sections/:id` | public | One section plus its event history |
| `POST` | `/api/auth/signup` | public | `{email, password}`, returns a session |
| `POST` | `/api/auth/login` | public | `{email, password}`, returns a session |
| `POST` | `/api/auth/logout` | bearer | Revokes the presented session only |
| `GET` | `/api/auth/me` | bearer | The signed-in account |
| `POST` | `/api/watches` | bearer | `{sectionId, mode?, channel?, target?}`. `channel: "email"` defaults `target` to the account address. |
| `GET` | `/api/watches` | bearer | The caller's active watches |
| `DELETE` | `/api/watches/:id` | bearer | Stop watching. 404 for a watch you do not own. |
| `GET` | `/api/events` | bearer | The caller's events, or `?sectionId=` for one section |
| `POST` | `/api/poll` | bearer | Force a cycle. Useful in development. |

Section ids are `{schoolId}:{term}:{crn}`.

### Authentication

ClassPik accounts, never a school login. The credential-free boundary is
unchanged: nothing in `src/core/auth.ts` is reachable from `src/adapters`, and
`SisAdapter` still has nowhere to put a password.

- Passwords are scrypt from `node:crypto`, per-user random salt, cost parameters
  stored alongside the digest so they can be raised without locking anyone out.
- Session tokens are 256 random bits, opaque, not JWTs. Only the SHA-256 of a
  token is stored, so a database leak yields nothing replayable. Revocation is
  a row update rather than a blocklist.
- Sessions last 30 days. Logout revokes the presented session only, so signing
  out on a laptop leaves a phone signed in.
- Login is rate limited per account: five consecutive failures lock it for a
  minute, doubling per further failure, capped at an hour and cleared by a
  success. The lock applies to the correct password too, otherwise it would not
  be a lock.
- An unknown email and a wrong password return the same status, the same
  message, and roughly the same latency, so the endpoint cannot be used to
  enumerate accounts.

Routes are private by default. A new route is protected unless it says
`'public'`, which is the only default that fails safely.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP port |
| `CLASSPIK_DB` | `./classpik.db` | SQLite file |
| `CLASSPIK_DEMO` | unset | `1` runs the simulated SIS |
| `CLASSPIK_CORS_ORIGINS` | localhost dev ports | Comma-separated allowed origins |

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
| `users`, `sessions` | ClassPik accounts and their live bearer sessions |
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

405 tests across thirteen files. The adapter is tested against recorded response
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
| `repo.test.ts` | Schema, transactions, dedupe, notification idempotency |
| `poller.test.ts` | The full loop, failure handling, adaptive intervals |
| `notify.test.ts` | Delivery, retry, backoff, transport routing, webhook safety, permanent versus transient failure |
| `mime.test.ts` | Dot-stuffing, CRLF, encoded words and their UTF-8 boundaries, header injection, address validation, message assembly |
| `email.test.ts` | Alert copy, the Resend transport's every status branch, key leakage, env configuration, delivery through the real queue |
| `smtp.test.ts` | The full submission sequence against a scripted server: multiline replies, split and merged chunks, STARTTLS, AUTH, 4xx versus 5xx, timeouts, socket cleanup |
| `api.test.ts` | Every route, validation, CORS |
| `auth.test.ts` | Hashing, tokens, lockout, expiry, revocation, and watch ownership between two accounts |
| `config.test.ts` | Validation, including the politeness floor |

---

## What is not done

Stated plainly so nobody is surprised:

- **Neither the Banner nor the PeopleSoft adapter has run against a live
  install.** Both are built to a documented contract and tested against recorded
  shapes. Phase 0 verifies them. The PeopleSoft one is the weaker of the two:
  its field names come from two open-source consumers of the API rather than
  from a response anyone captured, and the page size of its class search is
  unknown, so the per-subject request count is a guess until measured.
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
- **No email verification and no password reset.** An address is taken on
  trust at signup, and a forgotten password currently means a new account. So an
  email watch can be pointed at an address the account holder does not own.
- **The SMTP client has never spoken to a production relay.** It has been run
  against a local sink over a real socket, and against scripted transcripts in
  the suite. It has not met a relay that enforces TLS, rate limits, or greylists,
  so `resend` is the supported production path today.
- **Single process.** The scheduler assumes one poller. Running two would double
  the request rate against registrars. Multi-worker needs target leasing.
- **No automatic subject discovery in the poll loop.** `listSubjects` exists on
  the adapter but targets are seeded from the config's `subjects` list.

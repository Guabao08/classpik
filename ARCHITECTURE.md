# ClassPik — Architecture

Autonomous course registration for college students. Two things:

1. **Watch** a section and get pinged the moment a seat opens.
2. **Enroll** automatically — at your registration window, or the instant a seat frees up.

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

## System A — Monitor (cloud)

Unauthenticated crawler that tracks seat counts and notifies students.

**Stack**
- Postgres on Supabase (auth + realtime + hosting, free tier)
- Node/TypeScript workers on Fly.io
- BullMQ job queue on Upstash Redis
- Notifications: Web Push (free, works as installed PWA on iOS) + email via Resend
- SMS deferred to a paid tier — Twilio A2P 10DLC registration isn't worth the v1 friction

**The scalability decision: poll per section, not per watch.**

Watches are deduped into a global poll table keyed by `(school, term, crn)`. Fifty students watching the same section produce *one* request. Crawl load therefore scales with **distinct watched sections**, not with users — the system gets cheaper per user as it grows.

10k distinct sections at a 5-minute floor is ~33 req/s spread across every supported school. Comfortable on a hobby budget.

**Politeness is a hard requirement.** Adaptive intervals (15 min baseline, tightening near add/drop deadlines), per-school concurrency caps, exponential backoff on errors. The realistic failure mode is not legal — it's getting IP-blocked and silently going dark for every user at that school.

---

## System B — Agent (local)

Desktop app that holds the session and performs enrollment.

**Stack**
- Electron + TypeScript — shares adapter types with the backend. Tauri gives smaller binaries but costs us a second language; not worth it for a two-person team.
- Playwright driving the student's **installed Chrome** with a dedicated persistent profile — not a bundled Chromium. Smaller install, and the profile can inherit SSO/device-trust state the student already has. Falls back to downloading Chromium if Chrome is absent.
- Credentials in the OS keychain (Keychain on macOS, DPAPI on Windows).
- Scheduled hardware wake: `pmset schedule wake` (macOS), Task Scheduler wake timer (Windows). The computer wakes up early, not the student.

### The hot path

Browser for authentication, raw HTTP for the race:

1. Playwright completes SSO + MFA in a persistent context. (SSO is a SAML/CAS/OIDC redirect chain with JS in the middle — reimplementing it in raw HTTP breaks constantly. Let a real browser do it.)
2. Lift session cookies out of the browser context.
3. At T-minus seconds: scrape fresh CSRF/state tokens, build the payload, open a keep-alive connection so TCP+TLS is already done.
4. Fire as raw HTTP. Milliseconds, and multiple sections can go in parallel.

**Sync to the server's clock, not ours.** Read the `Date` response header, compute the offset, fire on *their* time. 400ms of local clock skew loses seats.

---

## MFA — three strategies, every vendor

We never integrate with an MFA vendor. We drive a browser through whatever the school's IdP renders, which puts us one layer *below* Duo/Entra/Okta/Google. The abstraction is therefore behavioral, not per-vendor:

```ts
interface MfaStrategy {
  satisfy(page: Page, ctx: AuthContext): Promise<SessionState>
}
```

- **`DeviceTrust`** — persistent profile, tick "remember this device," reuse the cookie. Primary strategy. Identical across every vendor.
- **`PushWait`** — trigger auth, notify the student's phone, wait for the IdP page to advance. We watch for a DOM/navigation change; we never call anyone's API.
- **`InteractiveHandoff`** — open the window, human finishes it, agent takes over the session. Universal fallback. Covers passkeys, security questions, in-house SSO, anything we haven't seen.

Three strategies cover every MFA vendor that exists, including ones that don't exist yet.

**What actually varies is school policy, not vendor:** does this school permit "remember this device," and for how long? Some Duo schools disable it; some Entra schools allow 30 days. This is a per-school capability flag, discovered empirically.

**Known hard blocker:** schools mandating passkeys/FIDO2 only. The hardware ceremony can't be replayed from a stored profile. Still rare for general student accounts. Where it lands, that school is monitor-only.

**Explicitly not building:** TOTP seed extraction from authenticator apps, CAPTCHA solving, or bot-detection evasion. If a school gates registration behind a CAPTCHA, that school degrades to notify-only.

---

## SIS adapters

Three adapters cover the large majority of US four-year enrollment. Each school is then a **config file, not code** — that's how two people reach many campuses.

```ts
interface SisAdapter {
  // public, unauthenticated — the cloud monitor uses ONLY this
  searchSections(term: Term, filter: Filter): Promise<SectionSnapshot[]>

  // authenticated — local agent only
  authenticate(creds: Creds, mfa: MfaStrategy): Promise<Session>
  prepare(session: Session, targets: Section[]): Promise<PreparedEnroll>
  fire(prepared: PreparedEnroll): Promise<EnrollResult>
}
```

| Adapter | Difficulty | Notes |
|---|---|---|
| **Banner 9** | Easiest | Self-service registration is a JSON API underneath. Clean HTTP after auth. **Georgia Tech (OSCAR)** is Banner. |
| **PeopleSoft CS** | Medium | Stateful — `ICSID`/`ICStateNum` tokens increment. Keep the browser page as state source, fire HTTP with freshly-scraped tokens. Has an **enrollment shopping cart**: pre-load the night before, race is just "Finish Enrolling." Build the adapter around the cart. **Duke (DukeHub)** is PeopleSoft. |
| **Workday Student** | Hardest | Obfuscated, heavily session-bound. Plan to stay in-browser. Deprioritize. |

SIS can be auto-detected from URL shape: `/StudentRegistrationSsb/` → Banner 9, `/psc/` or `/psp/` → PeopleSoft, `*.myworkday.com` → Workday.

### School config

```yaml
id: gatech
name: Georgia Institute of Technology
sis:
  type: banner9
  baseUrl: https://oscar.gatech.edu       # confirm in Phase 0
catalog:
  public: true                             # confirm in Phase 0
  seatFields: [capacity, actual, remaining]
auth:
  ssoType: cas
  mfa:
    vendor: duo                            # informational only
    deviceTrust: unknown                   # confirm in Phase 0
    trustDurationDays: null
```

Adding a school = a config PR.

---

## Build order

**Phase 0 — Feasibility spike.** Prove a replayed enrollment request is accepted by OSCAR. Nothing else is worth building until this is answered. See `PHASE0.md`.

**Phase 1 — Monitor only.** Banner + PeopleSoft catalog search, watch a section, get pinged. No credentials anywhere. Shippable and useful on its own; earns users while the risky half is unproven.

**Phase 2 — Agent + enrollment.** One school (GT), registration-window sniping.

**Phase 3 — Auto-grab.** Monitor detects seat → pushes to agent → agent fires. Needs both halves. This is the thing people pay for.

---

## Known risks

1. **Phase 0 may fail on some schools.** Some portals bind requests to browser state tightly enough that we must stay in-browser. Workday almost certainly will. Every adapter needs a slow-but-working DOM automation fallback.
2. **Public catalogs aren't universal.** Most schools expose seat counts without login; some don't. Those schools break the clean split and can only be monitored with credentials — or not at all. Check per school at onboarding.
3. **Registration windows are per-student time tickets.** You cannot enroll before your own assigned window, no matter how fast you are. "Sniping" means *firing the instant your own window opens*. Market it honestly.
4. **Session lifetime.** Portals expire idle sessions (Banner ~30 min) and often hard-cap absolute session length. Long waitlist watches will need re-auth, which is why `DeviceTrust` is the primary MFA strategy rather than a nicety.

---

## Policy posture

Most registration systems restrict automated access, and it varies meaningfully by school. The architecture is the mitigation:

- Credential-free monitoring reads public catalog pages at a polite rate.
- Enrollment runs on the student's own machine, under their own session, performing an action they are authorized to perform.

Check the school's stance before enabling enrollment there. Degrade to monitor-only rather than working around a control.

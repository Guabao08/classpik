# ClassPik

Autonomous course registration for college students.

1. **Watch** a section and get told the moment a seat opens.
2. **Claim** it automatically, at your registration window or the instant one frees up.

## Repo

| Path | What it is | Status |
|---|---|---|
| [`apps/monitor`](apps/monitor) | The class watcher. Polls public catalogs, detects seat openings, notifies watchers. | **Built, 793 tests** |
| [`apps/web`](apps/web) | Landing page and the watcher UI, wired to the monitor API. | Built |
| *(not started)* | The local agent that performs enrollment. | Blocked on Phase 0 |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Every design decision and why. | |
| [`PHASE0.md`](PHASE0.md) | The feasibility spike that unblocks enrollment. | Part B answered, Part A pending |

## Run it

Two processes. The monitor first:

```bash
cd apps/monitor && npm install && npm run serve -- --demo
```

Then the web app:

```bash
cd apps/web && npm install && npm run dev
```

Open `http://localhost:5173/` and click **Get early access**, or go straight to
`/signup`. Watching a section needs a ClassPik account, which is ours and never a
school login. Signup is two steps: an email address and a password of at least 10
characters, then the school, term and level you are shopping in. Nothing is
emailed to you, since email delivery is off unless the monitor is configured with
a provider.

Signing up drops you at `/app`. Search for `MATH 221`, watch section B (which
starts full), and within a minute the simulated registrar frees a seat and the
alert appears under Alerts. Demo mode runs against a simulated student system, so
nothing touches a real registrar.

`/app` is the product and it needs a session: visiting it signed out redirects to
`/login?next=/app`.

## The one decision that shapes everything

The system splits on the credential line.

**Monitoring needs no login.** At most schools, seat counts are visible in the
public class search. So the monitor runs in the cloud, holds zero passwords, and
can be pointed at any school we can parse.

**Enrollment does need a login.** So it runs as a local agent on the student's
own machine, under their own session. Credentials never reach our infrastructure.

Keeping those apart means the broadly deployable half carries no password
liability, and the half that holds credentials is never ours to leak. The two
should not be merged.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full reasoning, including the MFA
strategy, the SIS adapter design, and the known risks.

## Where things stand

The watcher is real and tested. The Banner public search path has been **run
against a live install**: Georgia Tech, on 2026-07-29, logged out, returning 1751
CS sections with real seat counts, and `apps/monitor/schools/gatech.yaml` is
committed with every value read off those responses.

That file ships **`enabled: true`**, and it is worth being exact about what that
does. Enabled alone costs zero upstream requests: a Banner school carries no term
list in its config, and `registerSchool` seeds poll targets only for schools that
already have terms, so a fresh install makes no request at Georgia Tech at all.
What starts real traffic is the CLI, in this order:

```bash
npm run cli -- terms gatech          # one discovery request
npm run cli -- subjects gatech 202608
npm run cli -- seed gatech 202608    # from here on, polling at a 5 minute floor
```

Turning it back off is the one flag. The PeopleSoft adapter has never met a live
install, and neither has enrollment.

The enrollment half is not started, and it is gated on one unanswered question:
**will a course registration system accept an enrollment request replayed by a
script?** That is Part A of [PHASE0.md](PHASE0.md), it needs an open registration
window, and it is the only thing there still outstanding. Until it is answered,
auto-claim is a stored preference rather than a working feature, and the UI says
so.

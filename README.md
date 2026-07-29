# ClassPik

Autonomous course registration for college students.

1. **Watch** a section and get told the moment a seat opens.
2. **Claim** it automatically, at your registration window or the instant one frees up.

## Repo

| Path | What it is | Status |
|---|---|---|
| [`apps/monitor`](apps/monitor) | The class watcher. Polls public catalogs, detects seat openings, notifies watchers. | **Built, 505 tests** |
| [`apps/web`](apps/web) | Landing page and the watcher UI, wired to the monitor API. | Built |
| *(not started)* | The local agent that performs enrollment. | Blocked on Phase 0 |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Every design decision and why. | |
| [`PHASE0.md`](PHASE0.md) | The feasibility spike that unblocks enrollment. | Pending |

## Run it

Two processes. The monitor first:

```bash
cd apps/monitor && npm install && npm run serve -- --demo
```

Then the web app:

```bash
cd apps/web && npm install && npm run dev
```

Open the app at `/#app`. It opens on a sign-in wall: watching a section needs a
ClassPik account, which is ours and never a school login. Create one with any
email address and a password of at least 10 characters. Nothing is emailed to
it, since email delivery is off unless the monitor is configured with a
provider.

Then search for `MATH 221`, watch section B (which starts full), and within a
minute the simulated registrar frees a seat and the alert appears under Alerts.
Demo mode runs against a simulated student system, so nothing touches a real
registrar.

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

The watcher is real and tested, though neither SIS adapter has been run against
a live install yet: both are built to a documented contract and tested against
recorded response shapes. The enrollment half is not started, and it is
gated on one unanswered question: **will a course registration system accept an
enrollment request replayed by a script?** [PHASE0.md](PHASE0.md) is the
experiment that answers it. Until it does, auto-claim is a stored preference
rather than a working feature, and the UI says so.

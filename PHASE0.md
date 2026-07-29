# Phase 0: Feasibility Spike

**Goal:** find out whether OSCAR will accept an enrollment request sent by a script instead of by a human clicking buttons.

**Why first:** every other decision in `ARCHITECTURE.md` assumes the answer is yes. If it's no, the enrollment half of ClassPik is a different (slower) product and we need to know that now, not in October. This is a few hours of clicking in DevTools, not a build.

**Owner:** Roshan (Georgia Tech / OSCAR / Banner 9)
**Also do:** Andy repeats Part A on DukeHub (PeopleSoft), which is different enough to need its own answer.

Nothing here is product code. It's a question we're answering with a browser and a terminal.

### Timing: what's blocked and what isn't

Banner won't let you complete an add without an active registration time ticket. That gates exactly **one step**: the final replay verification in A3. Everything else runs today.

| | Needs an open window? | Unblocks |
|---|---|---|
| **Part B**: public catalog | No | **Phase 1 (the entire monitor)** |
| **Part A1/A2**: capture request shape | No | Writing the Banner adapter |
| **Part A3**: verify replay is accepted | **Yes** | The raw-HTTP hot path |

Do B and A1/A2 now. A3 waits for your window. **Phase 1 does not depend on A3 at all**, so start building it.

---

## Part A: Can we replay an enrollment request?

### A1: Capture the request *(no window needed)*

**A rejected add is still a successful capture.** If your time ticket isn't active, OSCAR will refuse the enrollment, but the browser still *sends* the request, and that request has the same URL, headers, token, and body shape it will have when your window is open. The only thing that changes is the server's answer. So you can learn the entire request shape today and write the adapter against it.

Bonus: "you have no registration time ticket" is one of the error responses the product has to parse anyway. Capturing it now is real work, not a consolation prize.

#### Watch what the browser actually sends

1. Open Chrome → `oscar.gatech.edu` → log in (GT SSO + Duo).
2. Go to **Registration → Register for Classes** and select a term.
3. Open DevTools (`F12`) → **Network** tab.
   - Check **Preserve log**
   - Filter to **Fetch/XHR**
4. Clear the log, then **add one class.** Pick something you can drop immediately: an empty section of a class you'd never take. Do not test on your real schedule.
5. Watch the requests fire.

#### Find the request that does the work

On Banner 9 the registration calls live under `/StudentRegistrationSsb/ssb/...`. You're looking for two, roughly:

- one that stages the class into the summary panel (adds the pending row)
- one that **submits** the whole summary. This is the one that actually enrolls

The submit is the one you care about. You'll know it because it's the request that fires when you click **Submit**, and its response contains the new registration status.

#### Capture it

Right-click the submit request → **Copy → Copy as cURL**. That grabs the URL, method, headers, cookies, and body in one shot. Save it to a file.

### A2: Record the shape *(no window needed)*

Write the answers down in `notes/phase0-gatech.md`:

- [ ] Is there a **synchronizer / CSRF token**? Banner 9 typically sends `X-Synchronizer-Token`. Is it in a header or the body?
- [ ] Does the token change every request, or is it stable for the session?
- [ ] Which cookie carries the session? (Probably `JSESSIONID`.)
- [ ] **Is there a required setup step?** Banner usually makes you select a term first, which sets server-side session state. If replay fails, this is the most likely reason. Capture the term-selection request too and replay both in order.
- [ ] How long does an idle session survive before requests start failing? (Leave it 15 min, retry. Then 45.)
- [ ] What does a **failure** response look like for class full, time conflict, no time ticket, holds on account? We need to parse these to report useful errors.
- [ ] Response time of the submit request, roughly.

### A3: Verify the replay *(needs your window open)*

The actual experiment. When your time ticket is active:

1. Add the junk class in the UI. Capture the submit request again (tokens will be stale from A1).
2. **Drop the class.** Confirm you're not registered.
3. Paste the cURL into a terminal and run it.
4. Refresh OSCAR.

**Are you registered again?** That's the whole question.

- [ ] Did the plain replay work?
- [ ] If not, did it work after re-scraping the token / replaying term-select first?

### Interpreting the result

| Outcome | What it means | What we build |
|---|---|---|
| ✅ Plain replay enrolls you | Best case | Raw HTTP hot path exactly as designed |
| ⚠️ Works only after re-scraping a fresh token | Expected, normal | Scrape token → fire. Adds ~1 request of latency. Still fast. |
| ⚠️ Works only after replaying term-select first | Fine | Multi-step prepare phase in the adapter |
| ❌ Nothing works outside the browser | Bad but survivable | GT adapter falls back to Playwright DOM automation. Slower, still beats a human. |

---

## Part B: Is the catalog really public?

This validates the entire credential-free monitoring half, which is what Phase 1 ships.

1. Open an **incognito window.** Do not log in.
2. Reach GT's class schedule search from `oscar.gatech.edu` (the schedule-of-classes browse, not the registration app).
3. Search for a real course.
4. Confirm you can see **seat numbers**: capacity, actual enrolled, remaining. Waitlist counts too if they're shown.
5. DevTools → Network → capture the search request → **Copy as cURL** → run it from the terminal with no cookies at all.

**Does it return seat data with no session?** If yes, Phase 1 is unblocked and we can monitor GT, and every other Banner school, without ever touching a credential.

Record in `notes/phase0-gatech.md`:

- [ ] Seat counts visible logged-out? (y/n)
- [ ] Is it HTML to parse, or JSON?
- [ ] Can one request return **many sections at once** (a whole subject, e.g. all of CS)? This matters: the monitor batches per school, so one request covering 200 sections is the difference between cheap and expensive.
- [ ] Any rate limiting or blocking after ~20 requests? Go gently here; back off the moment anything looks throttled.

---

## Ground rules while testing

- Use a **junk section** you can drop instantly. Don't experiment on classes you need.
- **Don't loop.** A few dozen manual requests total, spaced out. We are not load-testing the registrar; getting our IP flagged before we have a product would be an unforced error.
- Note anything that looks like bot detection. If registration is CAPTCHA-gated, say so immediately, because that changes the plan.
- Keep raw captures out of git. They contain your live session cookie. Put them in `notes/` and make sure it's gitignored.

---

## Done when

`notes/phase0-gatech.md` answers every checkbox above and ends with a one-line verdict:

> **Verdict:** raw-HTTP hot path is / isn't viable at GT, because ___.

Then we start Phase 1.

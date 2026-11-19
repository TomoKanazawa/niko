# Status (2026-11-18)

Version 0.1.0. 36 automated tests pass on the test apps `fixtures/tiny-clinic` and `fixtures/tiny-news`. One public site
(demo.playwright.dev/todomvc, HTTPS) was recorded and replayed with the network disabled, with no console errors.

## Built and tested

| Stage | What works |
|---|---|
| Capture | A person's session, a scripted session (`--script`), or the crawl; `--after-reset` for test systems whose data was put back. Chrome with its own profile; every HTTP exchange with bodies; WebSocket frames; clicks, typing, submits; page snapshots (HTML + accessibility tree); HAR as a second copy; probe pass; session cookies kept between runs |
| Explore | Automatic crawl with no model. UI gate and network gate; a 60-action run on the test app changed nothing in it |
| Scrub | Cookies, tokens, passwords become placeholders. `--pii`: labelled fields and patterns replaced by consistent fakes |
| Analyze | Endpoint clusters with `{id}` path templates, six classes, volatile fields, value flow, held-out split, a small OpenAPI file, endpoints named in JS but never seen |
| Run | Replica behind a local intercepting proxy (HTTP and HTTPS) at the original URLs; Chrome launched with a DevTools port; a second client attached and used it; reset, state, log, ledger endpoints |
| Stateful copy | Handler contract, SQLite, hand-written replica of the test app passes L1, L2 and L3 |
| Verify | Deterministic comparison (JSON, HTML as DOM, volatile masks), ledger per endpoint and per action, replica hash check |
| Build | Supervisor with steps, saved state, resume, budget stop, repair loop, tool restrictions. Tested with a scripted stand-in for the model |
| Real-account mode | `init --real-account`: every capture gated (person, script, crawl); token-carrying links, social verbs, image pings and beacons refused; page stays put with a notice; pacing from robots.txt; stop on 429/503 or a slow-down page; `forget` and `--forget-after`; coverage.json per crawl. On tiny-news, a crawl and a script that votes, hides, comments, favorites and logs out change nothing |
| Stopped writes | Kept as endpoints with no answer (`analysis/blocked.json`); the builder writes inferred handlers for them, labelled `inferred`. Not yet run with a real model |
| Drift | Read-only re-check with the saved login; API shape, form fields and controls compared; severity; session-expiry stop; daily schedule file |

## Not yet run

- **`niko build` on a real app.** It ran with a real model on the test clinic only (2026-11-11, twice): all 11
  handlers written, 23 of 23 checks pass, 8 endpoints verified and 6 replayed-only, one repair cycle, about $1.10 and
  three minutes per run. The first run exposed two faults, both fixed: the agents could not run the check from their
  working folder, and a step could end without writing its handler. On 2026-11-18 it ran on a Gitea 1.23 in
  Docker (29 endpoints, $10 cap): the data model and ten handlers were written for about $4 before a handler for
  a large server-built page used up its $0.50 share and the SDK's budget error ended the whole build. Fixed: such a
  step is now retried once with twice the share, then left on replay, and the build continues. Resumed twice, the
  build wrote all 29 handlers and ran two repair cycles for about $18 in all: 141 of 213 checks pass, 16 endpoints
  verified, 6 still failing (large server-built pages: the dashboard, issue lists, the commit page). The new-issue
  handler does not read Gitea's multipart form, so a write through the copy's browser stores the recorded issue,
  not the submitted one; the model wrote that fallback to pass the check, which is a weakness of the check.
  The SDK stops a step only after the turn that passes its budget, so a build can end a little over `--max-usd`.
- **A large real app** (OpenEMR, OpenMRS). Expect problems with iframes, pop-up windows and server-built pages.

## Not built (in the plan, missing here)

| Item | Now |
|---|---|
| Model-guided exploration and form filling | The crawler clicks safe links and buttons only |
| Write learning on a named test record (`--allow-writes-on`) | Use `--explore --allow-writes` on systems you own, or a human session |
| Language-model detection of personal data | Field names and patterns only; a name that appears only in free text is missed. `scrub --review` lists candidates |
| Handlers for endpoints never observed (`inferred`) | They answer `501 uncaptured` |
| Triage agent | Failures go to the repair step as deterministic descriptions |
| Container isolation of the builder | Tool and path restrictions plus a hash check. Not a hard guarantee |
| L4 live comparison and the parity benchmark | Not started |
| WebSocket and server-sent-event replay | Recorded; the copy rejects WebSocket connections |
| Several copies at once, date shifting for `--today` | One copy; `--today` only switches to the real clock |
| Dockerfile, compose file, GitHub Action, Windows scheduling, pixel diff | Not started |
| Telemetry | None. The tool sends nothing |

## Changes from the plan

- One package instead of ten. Simpler to publish and to read.
- The recorder uses Playwright's network events, not a raw DevTools session. Response bodies are requested as soon
  as the response starts; a body the browser dropped is filled in from the probe pass.
- SQLite is Node's built-in module, so there is no native dependency.
- The proxy library listens on all interfaces; requests from other machines are refused in code.

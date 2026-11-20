# Guide: using Niko on your own app

Read [TUTORIAL.md](TUTORIAL.md) first if you have not run the tool yet. It takes 15 minutes on a bundled test
app and shows every part working. This guide is the reference for doing the same on a real app.

The tool is early. It has been run on its test app and one simple public site, not yet on a large real app.
[STATUS.md](STATUS.md) lists what is built and what is missing. Expect rough edges and please report them.

## Contents

1. [What you get](#1-what-you-get)
2. [Before you start](#2-before-you-start)
3. [Install](#3-install)
4. [Set up an app](#4-set-up-an-app)
5. [Record the app](#5-record-the-app)
6. [Run the copy and attach an agent](#6-run-the-copy-and-attach-an-agent)
7. [Make the copy keep state](#7-make-the-copy-keep-state)
8. [Know what to trust](#8-know-what-to-trust)
9. [Keep up with the real app](#9-keep-up-with-the-real-app)
10. [Record on one machine, build on another](#10-record-on-one-machine-build-on-another)
11. [Secrets and personal data](#11-secrets-and-personal-data)
12. [Command reference](#12-command-reference)
13. [Files](#13-files)
14. [Troubleshooting](#14-troubleshooting)
15. [Limits](#15-limits)

## 1. What you get

You point the tool at a web app you can log in to. It records the app while it is used, then runs a local copy
that serves the app's own pages and scripts at the app's own addresses. Your agent works in the copy instead of
the real app.

There are two kinds of copy:

| | Replay copy | Stateful copy |
|---|---|---|
| Made by | `niko capture` | `niko build` |
| Needs a model | No | Yes, with your Anthropic API key |
| Reads | Exactly the pages and records that were recorded | Any record, from a database |
| Writes | Answered as they were recorded; nothing changes | Change the database; later reads show it |
| Something never recorded | Status `501`, header `X-Niko: uncaptured` | The same |
| Cost | Free | Model usage, capped by `--max-usd` |

The copy never makes an answer up. If it has nothing recorded for a request, it says so.

## 2. Before you start

- **You need an account on the app** and the right to use it this way. Recording an app captures its pages and
  data onto your machine. Check the app's terms and your agreement with whoever owns the data.
- **Use a test account or a test record if you can.** A person's recording session does whatever that person
  does, including real changes.
- **Everything stays on your machine.** The tool sends nothing anywhere, with two exceptions. `niko build`
  sends recorded pages and responses (with secrets removed) to Anthropic, using your API key. And `niko record`,
  which you only run when the copy is built on another machine, sends the recording (with secrets removed) to
  the receiver you name (section 10).
- **The tool does not get around bot detection, CAPTCHAs or multi-factor login.** A person logs in; the tool
  reuses that session.

## 3. Install

Requirements: Node 22.13 or newer, pnpm 9 or newer, Google Chrome. Tested on macOS; Linux should work; Windows
is untested. It is not on npm yet, so install from the repository:

```bash
git clone https://github.com/TomoKanazawa/niko.git
cd niko
pnpm install
pnpm build
```

The command is `bin/niko` in the clone. Call it by its full path from the folder where you want the tool to
keep its files, or add an alias:

```bash
alias niko=/absolute/path/to/niko/bin/niko
niko doctor
```

`niko doctor` checks Node, Chrome, the API key, memory and disk. The API key and the Claude Agent SDK are
needed only for `niko build`.

The rest of this guide writes `niko` for that command.

## 4. Set up an app

Run this from your project folder (or any folder you choose):

```bash
niko init https://app.example.com
```

It does three things:

1. Creates `.niko/<app>/` in the current folder, and adds `.niko/` to that folder's `.gitignore` (creating
   the file if there is none).
   `<app>` is made from the address, for example `app.example.com`.
2. Opens a Chrome window with a profile used only by this tool.
3. Waits for you to log in and **close the window**. The login is kept for later commands.

Options:

- `--no-login` skips the browser. Use it when the app needs no login, or when a script will log in
  (section 5).
- `--origin <origin...>` adds other addresses the copy should answer for. See below.
- `--app <name>` chooses the name yourself.

### Which addresses the copy answers for

By default the copy answers only for the address you gave. Many apps load scripts, styles or data from other
addresses: a CDN, an API on another subdomain, a login service. In the copy, a request to an address that is
not in scope fails with status `502`.

Add the others when you set up:

```bash
niko init https://app.example.com --origin https://api.example.com https://cdn.example.com
```

or later, by editing `origins:` in `.niko/<app>/niko.config.yaml` and running `niko analyze`. An origin
is the scheme, host and port: `https://api.example.com`, with no path.

To find out which ones you need, run the copy (section 6), use the app, and look for entries marked `external`
in the request log.

### Several apps

Each app gets its own folder under `.niko/`. When there is more than one, add `--app <name>` to every
command.

## 5. Record the app

A recording is a **capture**. You can make as many as you like; the copy is built from all of them together.
There are three ways to record.

### A person uses the app

```bash
niko capture
```

A Chrome window opens, already logged in. Use the app the way your agent will have to: open the screens, run
the searches, and do each kind of change at least once. **Close the window to finish.**

What to cover, in order of value:

1. Every screen your agent will visit.
2. Several records of the same kind (four or five patients, orders, tickets). The tool learns what an address
   pattern looks like from seeing more than one, and holds some back to test the copy.
3. Each kind of change your agent will make, followed by looking at the result. A read after a write is the
   strongest evidence the copy can have.

### A script uses the app

```bash
niko capture --script my-session.mjs --headless
```

The file is an ES module whose default export receives a [Playwright](https://playwright.dev) page that is
already open at the app's start address:

```js
export default async function session(page, { context }) {
  // Log in only when the saved session is not valid any more.
  if (await page.locator("input[name=password]").count()) {
    await page.fill("input[name=user]", "test-user");
    await page.fill("input[name=password]", process.env.APP_TEST_PASSWORD);
    await page.click("button[type=submit]");
  }
  await page.goto(new URL("/orders/1001", page.url()).href);
  await page.waitForSelector("h1");
}
```

Use this when no person is available (an agent is running the tool, or in CI) and for sessions you want to
repeat exactly. Wait for the page to finish loading after each step, as the example does; a request that has
not finished when the script ends may be recorded without its response. A working example is
[`fixtures/tiny-clinic/session.mjs`](../fixtures/tiny-clinic/session.mjs). If the script throws, nothing is
saved.

### The tool explores by itself

```bash
niko capture --explore --headless --max-actions 100
```

The tool clicks through the app with no model, using the saved login. It is built to be safe on a real system:

- It does not press controls that look like they commit something (save, submit, delete, send, sign, pay).
- Requests other than plain reads are blocked before they leave the browser, unless `niko policy` marks
  them as reads. Unknown requests are blocked.

So exploring widens the coverage of screens and reads, and records no writes. It does not fill in forms. Run a
person's or a script's session first, so the login is valid and the policy has something to work from.

`--allow-writes` removes the second protection. Use it only on a system you own that can be reset.

### A real person's account

If the login may be someone's real account, set the app up so that nothing can change it:

```bash
niko init https://news.example.com --real-account
niko capture --explore --headless
niko forget
```

In real-account mode:

- **Every capture is read-only at the network,** whoever drives the browser: a person, a script or the
  crawl. `--allow-writes` is refused.
- **Links that act on the account are refused.** Many sites change things with a plain link: vote, hide,
  favorite, flag, follow, log out. Such links are refused when they carry the account's token (`auth=`,
  `csrf=`, `hmac=`...) or have a word like these in the path.
- **Image pings and beacons with a query string are blocked,** and so is anything the site's robots.txt
  disallows. Sites often list their own action links there.
- **You are told when something is stopped.** If a person or a script clicks something that is stopped, the
  page stays where it was and shows "Blocked by Niko ... Nothing was sent".
- **Requests are paced:** one page or data request every `Crawl-delay` seconds from the site's robots.txt,
  or every 2 seconds. Change it with `--delay <seconds>`.
- **The crawl stops when the site says to slow down:** an HTTP 429 or 503, or a short page saying so. What
  was recorded is kept.

Stopped requests are still kept, so `niko build` can make them work in the copy. They have no recorded
answer, so the builder infers one from the request and the pages around it, and the report labels them
`inferred`.

The login window that `init` and `login` open is not gated: only log in there. The saved profile is a live
login: delete it with `niko forget`, or add `--forget-after` to the capture.

Each crawl writes `coverage.json` next to the capture. It lists every kind of link seen (path plus parameter
names) and whether it was opened, refused (and why) or not reached.

### Test systems that get reset

The tool assumes each capture continues from where the previous one ended, which is how a real system behaves:
the note you added yesterday is still there today. If you record on a test system whose data was put back to
its starting state since the last capture (it was restarted, restored or re-seeded), say so:

```bash
niko capture --after-reset
```

It works with every way of recording. The check in section 8 then starts that capture from the copy's starting
data instead of carrying on. Without it, `niko verify` reports failures such as a new record getting a
different id than the one recorded.

### Reads that look like writes

Some apps send a search or a filter as a `POST`. The tool blocks those while exploring, because it cannot tell
them from a change. List its decisions and correct them:

```bash
niko policy
niko policy --set "POST app.example.com /api/search=read"
```

The key is the method, the host and the path pattern exactly as `niko policy` prints them. Decisions are
`read`, `write` or `unknown`. A decision you set is never overwritten.

### After every capture

The tool removes secrets from the capture (section 11) and regroups all captures into endpoints. `niko
analyze` prints the summary again at any time:

```
Endpoints: 15  (static 2, read 8, write 3, session 1, noise 1)
Exchanges: 55; kept back for checking: 10; read-after-write checks: 3
Named in the app's code but never seen (3): /notes, /sign, /ws
```

An **exchange** is one request with its response. An **endpoint** is a group of requests of the same kind, such
as every `GET /orders/{id}`; each has an id like `c_0007`, shown in `niko report`. (The files call an endpoint
a cluster.) A path segment is taken as an `{id}` when it looks like one (a number, a UUID, a long token), when it
takes several different values under the same neighbours, or when the app's own JSON answers name that exact value
as an id, so `/api/folders/clinic-ops` is `/api/folders/{id}` after `/api/folders` listed a folder with that uid.
In a single-page app every page address answers with the same HTML and the scripts draw the page; three such
addresses with identical HTML become one endpoint, `GET /{path}`, so the copy can answer an address nobody
visited while recording, such as a record made in the copy.

| Kind | Meaning | In the copy |
|---|---|---|
| static | The same bytes every time (scripts, styles, images) | The stored file |
| read | Depends on stored data | A handler, or the latest recording of the same request |
| write | Changes stored data | A handler, or the recording (then nothing changes) |
| session | Login, logout, keep-alive | The recorded success, whatever is typed |
| noise | Analytics and telemetry | An empty `204` |

"Named in the app's code but never seen" lists addresses found in the app's JavaScript that no capture used. It
is a hint about what you have not recorded yet.

## 6. Run the copy and attach an agent

```bash
niko up
```

```
The copy of app.example.com is running.
  App URL (unchanged):  https://app.example.com/
  Attach your agent to: http://127.0.0.1:9333   (Chrome DevTools address)
  Control:              POST http://127.0.0.1:8878/reset   GET http://127.0.0.1:8878/state | /log | /ledger
Press Ctrl-C to stop.
```

The command keeps running, and takes a few seconds to be ready. A script should wait until
`GET http://127.0.0.1:8878/health` returns `"ok": true` before attaching. It starts three things:

- **The copy**, behind a local proxy on port 8877.
- **A Chrome window** that sends every request to that proxy. Inside this Chrome, the app's real address shows
  the copy. Nothing reaches the real app. Other browsers on your machine are not affected.
- **A control address** on port 8878.

Stop it with Ctrl-C, or from another terminal with `niko down`. Only one copy runs at a time.

### Attach your agent

Your agent must drive the Chrome that `niko up` started; that is the only browser that sees the copy. Most
browser automation tools can attach to a running Chrome when given its DevTools address. The agent then uses
the app's real addresses and needs no other change.

Playwright:

```js
import { chromium } from "playwright";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const page = browser.contexts()[0].pages()[0];
await page.goto("https://app.example.com/");
```

Puppeteer:

```js
import puppeteer from "puppeteer";
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9333" });
```

For other frameworks, look for an option named something like "connect to an existing browser" or "CDP URL" and
give it `http://127.0.0.1:9333`.

In the copy nobody needs to log in: pages behind the login are served directly, and the login request is
answered with the recorded success whatever is typed. A replay copy may still open on the login page, because
that is what the app's start address showed when it was recorded; go straight to the page you want.

### Use your own browser

`niko up --no-chrome` starts the copy without Chrome and prints the flags a Chromium-based browser needs:

```
Start Chrome with:    --proxy-server=127.0.0.1:8877 --proxy-bypass-list=<-loopback> --ignore-certificate-errors-spki-list=... --user-data-dir=<empty dir>
```

Start your browser with those flags and a new, empty profile folder. The certificate flag makes that one
browser accept the copy's certificate for HTTPS addresses; nothing is installed on your system.

### The control address

| Request | What it does |
|---|---|
| `GET /health` | `{ "ok": true, "app": ..., "endpoints": ... }`. `ok` is `false` while the copy is still starting |
| `POST /reset` | Puts the copy's data back to the start. Same as `niko reset`. The request log is kept |
| `GET /state` | The copy's database as JSON, one key per table. Use it in test assertions |
| `GET /log` | Every request the app's pages and your agent made, in order, since `niko up`. The first few are the copy's Chrome opening the start page |
| `GET /ledger` | The trust labels (section 8) |

Each `/log` entry has a number `n`, a time `at`, `method`, `url`, `status`, the endpoint id `cluster` when the
request matched a known endpoint, and `served`:

| `served` | Meaning |
|---|---|
| `static` | A stored file |
| `replay` | A recording, repeated |
| `generated` | A handler answered from the database |
| `stub` | Login and similar: the recorded success |
| `noise` | Analytics, answered with nothing. Also the browser's own request for `/favicon.ico` when the app has none |
| `uncaptured` | Nothing recorded for this request. The endpoint may be known, but not with these parameters (this record, this search). Status `501` |
| `external` | An address that is not in scope (section 4). Status `502` |

After an agent run, filter the log for `uncaptured` and `external`. The first are the places where your agent
went beyond what the copy knows, and what to record next. The second are addresses the app needs that the copy
does not answer for yet. Chrome's own background requests (updates, sign-in checks) are refused and left out of
the log.

### Options

- `--headless` runs Chrome without a window.
- `--port`, `--control-port`, `--cdp-port` change the three ports (defaults 8877, 8878, 9333).
- `--replay-only` ignores the handlers and answers only from recordings.
- `--today` changes the clock the handlers use when they create dates (a new record's timestamp, for example).
  By default that clock continues from the end of the last capture, so new dates stay consistent with the
  recorded data; with `--today` it is the real time. The browser's own clock is never changed.

## 7. Make the copy keep state

A replay copy cannot show the result of a write. A stateful copy can: it has a SQLite database and one handler
file per endpoint.

```bash
niko build --max-usd 20
```

A coding agent (Claude, through the Claude Agent SDK) reads the recordings and writes the database schema, the
starting data and the handlers. The tool then checks the result and sends failures back for repair, until
everything passes, the repair limit is reached, or the money runs out.

It needs an Anthropic API key, in the environment or in a file named `.env` in the folder you run the command
from:

```
ANTHROPIC_API_KEY=sk-ant-...
```

What it prints:

```
11 endpoints to build. Rough cost $5-18; hard stop at $20. Uses your ANTHROPIC_API_KEY.
Start? [y/N]
  model: started (attempt 1)
  model: finished, $0.26
  implement:c_0001: started (attempt 1)
  ...
Build finished. Spent about $1.08 (the SDK's estimate, not a bill).
Endpoints: 8 verified, 6 replayed-only, 0 inferred, 0 uncaptured, 1 external
```

- The rough cost is a wide guess. `--max-usd` is the real limit; without it the limit is `budgets.buildUsd` in
  the config file (40 by default). The amount printed at the end is an estimate, not your bill.
- `--yes` skips the question. The question is also skipped when the command is not run from a terminal.
- `--resume` continues a build that was interrupted or ran out of money, without repeating finished steps.
- `--cluster c_0003,c_0007` builds only those endpoints. The ids are in `niko report`.
- Each endpoint gets a share of the cap, at least $0.50. A step that uses up its share is tried once more with
  twice as much, and if it still does not finish the endpoint stays on replay; the build goes on with the others.

Measured builds so far: the test app, 11 endpoints, about $1.10 and three minutes; a Gitea with 29 endpoints,
where large server-built pages cost $0.40 to $0.50 each and some need more; and a Grafana (a single-page app
talking to a JSON API) where the twelve endpoints that needed a handler cost $2.70 in all, most of them under ten
cents. `--cluster` is the lever: build the writes, the reads they change and the reads that take parameters, and
leave single-instance reads on replay. A large app will cost more and may not finish cleanly; start with a low
`--max-usd` and continue with `--resume`.

### Fix the copy by hand

Everything the build writes is a plain file under `.niko/<app>/replica/`: `schema.sql`, `seed.sql`, one
TypeScript file per endpoint in `routes/`, shared pieces in `templates/`. When a handler is wrong for your app,
edit it and check it:

```bash
niko verify
```

The rules a handler follows are in [CONTRACT.md](CONTRACT.md). A complete hand-written example is in
[`fixtures/tiny-clinic/replica/`](../fixtures/tiny-clinic/replica).

## 8. Know what to trust

```bash
niko verify
```

```
95/95 checks pass. Endpoints: 7 verified, 7 replayed-only, 0 inferred, 0 uncaptured, 1 external
```

`verify` replays every recorded session against the copy, in order, from the starting data, and compares each
answer with what the real app sent. It uses no model. Parts of a response that change by themselves
(timestamps, tokens, request ids) are ignored. It exits with code 1 when a check fails, and prints each failure
with the first difference:

```
FAIL c_0001 DELETE app.example.com /api/notes/{id} [l1] 20261111-201725:x74: status: expected 204, got 404
```

That line reads: endpoint id, endpoint, level of the check (below), capture id and exchange id, then what was
expected and what the copy answered. On a replay copy it has nothing to check and prints `0/0 checks pass`; the only endpoints it then counts as
verified are the static files, which are the same bytes every time.

There are three levels of check:

| Level | Question |
|---|---|
| L1 | Does the handler reproduce the recordings the builder was shown? |
| L2 | Does it answer correctly for a record the builder was never shown? |
| L3 | After a recorded write, do the recorded reads that followed still match? |

and each endpoint gets one label:

| Label | Meaning | Trust it for |
|---|---|---|
| verified | Passed L2 or L3. Static files always count as verified | Records and sequences beyond the ones recorded |
| replayed-only | Reproduces the recordings only | Exactly what was recorded |
| inferred | A handler exists but a check fails | Nothing yet |
| uncaptured | Never recorded | Nothing; it answers `501` |
| external | Analytics and the like | Nothing; it is ignored |

`niko report` prints the full table: every endpoint with its label and check counts, and every recorded
action (each click and form submit) with the label of the weakest endpoint it depends on. The same data is in
`.niko/<app>/replica/ledger.json` and at `GET /ledger`.

To raise a label from replayed-only to verified, record more: another record of the same kind, or a read after
the write. Then run `niko build --resume`.

## 9. Keep up with the real app

Real apps change. The drift check tells you when the copy has fallen behind.

```bash
niko drift
```

It opens the real app with the saved login, visits the recorded screens, repeats the recorded reads, and
compares the structure with the recordings: fields in API responses, form fields, and buttons and links on each
screen. It only reads. It prints a report and saves it to `.niko/<app>/drift/drift-report.md`.

| Exit code | Meaning |
|---|---|
| 0 | No drift |
| 1 | Behavioural or cosmetic changes only (something was added, or page markup changed) |
| 2 | Breaking changes (something your agent may rely on was removed or renamed) |
| 3 | The login has expired. Run `niko login`, then try again |

Changes in data alone (a new patient, a different total) are not drift.

- `niko drift --update` takes the new recording into the copy. If the copy is stateful, it rebuilds the
  affected endpoints with the model; cap that with `--max-usd`.
- `niko schedule daily --hour 6` writes a scheduled job that runs the check every morning and prints the
  command that turns it on (a launchd file on macOS, a cron line on Linux).
- `niko login` opens the browser so a person can log in again.

### Staying logged in without a stored password

Some apps end a session quickly, so a daily drift check keeps running into an expired login. Niko never stores
a password to solve this. Instead it reuses a session a person already made in their own browser, during their
normal use of the app. Niko does the recording and the drift check; a human does the logging in.

There are two ways to hand a fresh session over.

**Drop a cookies file.** Export the app's cookies from whatever browser the person uses (Firefox, Safari, Edge
or Chrome, through its developer tools or a cookie-export add-on) and take them in:

```bash
niko adopt cookies.json
```

Niko keeps only the cookies for the app's own address, writes them to the saved login, and then loads a
recorded page to check the session is really signed in. It prints whether the session is live. Nothing else in
the file is read, and no password is involved.

**Keep a receiver open.** For unattended monitoring, run a small receiver on your machine:

```bash
niko adopt --serve
```

It listens on `127.0.0.1` only, prints a one-line address and a token, and takes in a session each time one is
pushed to it, so whenever the person signs in during their day the fresh session flows straight to Niko. A
browser add-on, a cookie-export tool, or a line of `curl` can do the pushing. The token must be sent with every
push, so nothing else on the machine can inject a session.

Then let the daily check wait for that session instead of stopping:

```bash
niko drift --wait 480
```

If the saved login has expired, drift holds the receiver open for up to the given number of minutes, and runs
the moment a live session arrives. No one logs in to Niko itself.

One limit worth knowing: an app's session cookie is almost always marked **HttpOnly**, which means ordinary
page JavaScript cannot read it. A bookmarklet will not work. Exporting through the browser's developer tools or
an add-on does see HttpOnly cookies, which is why the hand-over is a file or a push, not a script in the page.

## 10. Record on one machine, build on another

Use this when the login belongs to someone else (a client, a customer, another office) and the copy is for you.
The recording is made on their machine, with the login they make there. The copy is built and run on yours.

```
Machine with the login                    Your server
----------------------                    -----------
niko record        -- scrubbed -->        niko serve
(read-only, uses      recording           (builds and checks the copy)
 the login made       over https          niko up
 on that machine)                         (the sandbox)
      |                                        ^
      v                                        |
 the real app                             your developers
                                          and their agent
```

Recording from their machine also means the app sees the address it always sees. A session used from two places
at once is what a stolen session looks like, and some apps end it.

### On your server

Register the app. This does not open a browser:

```bash
niko init https://app.example.com --remote
```

```
This app is recorded on another machine. Start the receiver here with: niko serve
On the machine that can log in to the app, run:
  niko record --server <this receiver's https address> --token <token>
The token is shown only now and is for this app only. Running this command again replaces it.
```

Then start the receiver and leave it running:

```bash
niko serve
```

```
Receiver listening on http://127.0.0.1:8787. Register an app with: niko init <url> --remote
No --max-usd: each recording updates a replay copy and nothing is spent.
Press Ctrl-C to stop.
```

- **Spending.** Without `--max-usd` the receiver never calls a model: every recording updates a replay copy.
  With `niko serve --max-usd 20` it builds the stateful copy from the first recording and rebuilds the changed
  endpoints from later ones. The amount is the most it may spend on one app in total, over all its builds. When
  it is spent, later recordings update the replay data only and the log says so.
- **Reaching it.** The receiver listens on this machine only. Other machines reach it through whatever
  already gives your server https: a reverse proxy, a load balancer, a tunnel. Or let it serve https itself:
  `niko serve --host 0.0.0.0 --cert cert.pem --key key.pem`. A recorder refuses a plain `http://` address
  unless it is `localhost`, because the recording and the token would cross the network unprotected.
- **Tokens.** A token is for one app. A recording sent with it is filed under that app whatever the sender
  claims, and is refused if it is a recording of other addresses. The receiver keeps only a hash of the token.

### On the machine with the login

Install Niko there (section 3), then:

```bash
niko record --server https://niko.yourcompany.com --token <token>
```

1. A browser window opens. The person logs in to the app as usual and closes the window. This happens once.
2. Niko crawls the app by itself, read-only, and sends the recording.
3. It stays running. Every hour it re-checks the app with the same login, and sends a new recording only when
   the app changed in a way an agent would notice (section 9). A change in data alone, or in page markup alone,
   sends nothing.

The app is always set up as a real person's account (section 5): nothing that changes it is sent, whoever
clicks, and requests are paced. The server address and the token are remembered, so later it is just
`niko record`.

| Option | What it does |
|---|---|
| `--once` | One round, then stop. Exit code 3 when there was no valid login |
| `--every <minutes>` | How often to re-check. Default 60 |
| `--human` | First recording: the person uses the app in the window, instead of the crawl. Covers more |
| `--max-actions <n>` | First recording: stop the crawl after this many actions. Default 300 |
| `--delay <seconds>` | Wait this long between requests to the app. Remembered |
| `--show` | Show the browser window while it records |
| `--no-login` | Do not open the login window |

`NIKO_SERVER` and `NIKO_TOKEN` can be set instead of `--server` and `--token`, which keeps the token out of the
shell history.

**When the login expires**, the recorder says so, tells the receiver, and tries again at the next round. Nothing
is sent meanwhile. A person logs in again with `niko login`, or hands over a session from their own browser with
`niko adopt` (section 9). No password is stored at any point.

**With no person at that machine**, run `niko record --once --no-login` to set the folder up, take a session in
with `niko adopt cookies.json`, then run `niko record`.

### What is sent and what stays

| Sent to your server | Stays on the machine with the login |
|---|---|
| The scrubbed recording: requests, responses and page snapshots, with cookies, tokens and passwords replaced by placeholders | The browser profile and the saved session cookies |
| The read/write decisions (`policy.yaml`) | The raw recording and its HAR file |
| For a re-check: which endpoints changed | The table of real values behind the placeholders (`pseudonyms.json`) |

The recording does hold the app's data: names, records, whatever the pages showed. Only secrets are removed by
default (section 11). Send it only to a server that is allowed to hold that data.

### Using the copy

The receiver prints one line per event:

```
127.0.0.1_4010: recording 20261120-063919 received (290 files, 0.4 MB)
127.0.0.1_4010: 20261120-063919 The copy replays the new recording. Nothing was built: no spending cap was given.
127.0.0.1_4010: recorder says recorded
```

From there the app is like any other under `.niko/` on your server: `niko up`, `niko reset`, `niko verify`,
`niko report`. After a new recording arrives, stop and start `niko up` to pick it up. `GET /status` on the
receiver, with the token, returns the number of recordings, the last job and what the recorder last said.

### Limits

- The recorder is this command-line tool. The machine with the login needs Node and a browser; there is no
  packaged installer yet.
- The crawl clicks safe links and buttons only. Use `--human` when screens are behind forms.
- The receiver does not start or restart `niko up`.
- A login that expires still needs a person to log in again, on that machine.

## 11. Secrets and personal data

**Secrets.** Before anything else reads a capture, session cookies, tokens, CSRF values and typed passwords are
replaced with placeholders such as `SBX_SESSION_1`. The analysis, the builder and the copy only ever see that
version. The untouched recording stays in `.niko/<app>/captures/<id>/` on your machine, with the Chrome
profile and the saved cookies. Treat that folder like a password and never commit it.

**Personal data.** By default the tool removes secrets only. If the app shows real people's data:

```bash
niko scrub --pii       # replace personal data with consistent fake values
niko scrub --review    # show what was replaced and what still looks personal
niko scrub --confirm   # say you have reviewed it; needed before `niko build` will run
```

Replacement works on labelled fields (a JSON key or form field called `name`, `dob`, `phone`, and so on) and on
patterns (emails, phone numbers, dates). **A name that appears only inside free text is missed.** `--review`
lists text that still looks like a name or a date so you can check. This is help, not a guarantee: decide for
yourself whether the result may be sent to a model.

`niko scrub --off` goes back to secrets only, for apps whose data is fictional.

## 12. Command reference

Every command accepts `--app <name>`, needed only when `.niko/` holds more than one app.

| Command | What it does | Needs |
|---|---|---|
| `niko doctor` | Checks the machine | |
| `niko init <url>` | Creates `.niko/<app>/` and opens Chrome for a login. `--no-login`, `--origin <origin...>`, `--real-account` | A person, unless `--no-login` |
| `niko login` | Opens Chrome with the saved profile to log in again | A person |
| `niko forget` | Deletes the saved login (the tool's Chrome profile and session cookies) | |
| `niko adopt [file]` | Takes in a login made in a person's own browser (a cookies file), or `--serve` to receive pushed sessions. `--port <n>`, `--no-probe` | A cookies export |
| `niko capture` | Records a person's session until the window is closed. `--screenshots`, `--label <text>`, `--after-reset`, `--delay <s>`, `--forget-after` | A person |
| `niko capture --script <file>` | Records a scripted session. `--headless` | |
| `niko capture --explore` | Records an automatic read-only crawl. `--max-actions <n>` (default 300), `--headless`, `--allow-writes` | A valid login |
| `niko policy` | Lists read/write decisions. `--set "<key>=<read\|write\|unknown>"` | |
| `niko scrub` | Re-runs secret removal. `--pii`, `--off`, `--review`, `--confirm` | |
| `niko analyze` | Regroups all captures into endpoints and prints the summary | |
| `niko build` | Has a model write the stateful copy, then checks it. `--max-usd <x>`, `--yes`, `--resume`, `--cluster <ids>` | API key |
| `niko verify` | Checks the copy against the recordings. `--json`, `--cluster <ids>`, `--no-write`. Exit 1 on failure | |
| `niko report` | Prints the labels per endpoint and per action as Markdown; also saved as `replica/report.md` | |
| `niko up` | Runs the copy and a Chrome attached to it. `--headless`, `--no-chrome`, `--replay-only`, `--today`, `--port`, `--control-port`, `--cdp-port` | |
| `niko reset` | Puts the running copy's data back to the start | A running copy |
| `niko down` | Stops the running copy | A running copy |
| `niko drift` | Compares the real app with the recordings. `--headless`, `--update`, `--max-usd <x>`, `--wait <minutes>`, `--port <n>`. Exit 0, 1, 2 or 3 | A valid login, or an adopted one |
| `niko schedule daily` | Writes a daily drift job. `--hour <h>` | |
| `niko init <url> --remote` | Registers an app that is recorded on another machine and prints its token. Opens no browser | |
| `niko serve` | Receives recordings from `niko record` and keeps each app's copy up to date. `--port <n>` (default 8787), `--host <address>`, `--cert <file>`, `--key <file>`, `--max-usd <x>` (total per app; without it nothing is built). Runs until stopped | API key, only with `--max-usd` |
| `niko record` | Records the app read-only and sends the scrubbed recording to a receiver, then re-checks every hour. `--server <url>`, `--token <token>`, `--every <minutes>`, `--once`, `--human`, `--show`, `--no-login`, `--max-actions <n>`, `--delay <s>`. Runs until stopped unless `--once` | A person to log in once |

Errors are printed as `niko: <message>` and the command exits with code 1.

## 13. Files

Everything for an app is under `.niko/<app>/`. The parts you may want to read or edit:

| Path | What it is |
|---|---|
| `niko.config.yaml` | Start address, origins in scope, scrub mode, model names, budgets |
| `policy.yaml` | Read or write decision per request kind |
| `captures/<id>/` | One recording: events, bodies, page snapshots, a HAR file, and the scrubbed version |
| `analysis/` | Endpoints, what changes by itself, the held-back set, an OpenAPI file for the JSON endpoints |
| `replica/` | The stateful copy: `schema.sql`, `seed.sql`, `routes/`, `templates/`, `ledger.json`, `report.md` |
| `drift/` | The latest drift report |
| `profile/`, `session-cookies.json`, `ca/` | The saved login and the copy's certificate. Private |
| `recorder.json` | On a recording machine: the receiver's address, its token, and which recordings were sent. Private |
| `upload-token.sha256` | On a receiving server: the hash of the app's token |

The complete list with formats is in [FORMATS.md](FORMATS.md).

To start an app again from nothing, delete `.niko/<app>/`. To remove one recording, delete its folder under
`captures/` and run `niko analyze`.

## 14. Troubleshooting

| What you see | Why | What to do |
|---|---|---|
| A page in the copy is blank or half-loaded | A script or data file comes from an address that is not in scope | Look for `external` entries in `GET /log`, add those origins (section 4), run `niko analyze`, restart the copy |
| `501` with `X-Niko: uncaptured` | That request was never recorded with those parameters | Record a session that makes it, then restart the copy |
| The copy shows a record but not the one your agent asked for | Replay copies only know recorded records | Record that record, or build the stateful copy |
| A write "works" but nothing changes | It is a replay copy, or that endpoint is replayed-only | Build the stateful copy; record a read after the write |
| `The app's session has expired` | The app logged the tool out | `niko login`, or re-run a `--script` capture that logs in |
| `capture --explore` reports `Explored 1 states with 0 actions` | It landed on the login page | The same: log in again |
| `Capture <id> has not been scrubbed` | A capture folder is incomplete | `niko scrub`; if it persists, delete that folder under `captures/` |
| `Capture <id> holds personal data and has not been reviewed` | `scrub --pii` was used | `niko scrub --review`, then `niko scrub --confirm` |
| `ANTHROPIC_API_KEY is not set` | `niko build` has no key | Put it in `.env` in the folder you run from, or export it |
| `The copy is not running` | `reset` or `down` without `up` | `niko up` |
| `listen EADDRINUSE: address already in use` from `niko up` | A copy is already running, or the port is taken | `niko down`, or choose other ports |
| Chrome does not open | Chrome is not installed where the tool looks | Install Chrome, or `pnpm --filter useniko exec playwright install chromium` |
| Live updates do not arrive in the copy | WebSockets are recorded but not replayed | Nothing yet; see Limits |
| `verify` fails with different ids or stale values, on a test system | The system's data was reset between captures | Record with `--after-reset` (section 5). To fix an existing capture, delete its folder under `captures/` and record again |
| `verify` reports failures after you edited a handler | The handler's answer differs from the recording | Read the printed difference; it shows the first place they diverge |
| `niko verify` prints `0/0 checks pass` | There is no stateful copy yet | Normal for a replay copy |

When something else goes wrong, the most useful things to send with a report are the command, its full output,
`niko report`, and the `uncaptured` and `external` lines from `GET /log`. Do not send the `captures/` folder: it
holds the unscrubbed recording.

## 15. Limits

The full list is in [STATUS.md](STATUS.md). The ones you are most likely to meet:

- **Not yet run on a large real app.** Apps built from frames, pop-up windows and pages assembled on the server
  are the likely trouble spots.
- **Chromium-based browsers only.**
- **WebSockets and server-sent events are not replayed.** The copy refuses those connections. While recording,
  an open stream is ignored when the tool waits for a page to settle after an action: an `EventSource`, a
  `text/event-stream` response, or any response whose body is still arriving two seconds after its headers. A
  request the server holds without sending headers at all is still waited for, up to the 10-second cap.
- **Service workers are switched off** while recording.
- **Exploring does not fill in forms**, so writes are learned only from a person's or a script's session.
- **Requests the app never made are not guessed.** An endpoint nobody recorded answers `501`.
- **One copy at a time** per machine with the default ports.
- **The proxy port is open on every network interface**, because of the library it uses. Requests from other
  machines are refused with `403`; only this machine gets answers.
- **Personal-data removal is partial** (section 11).
- **The builder is restricted, not sealed.** It can only write inside the copy's folder and cannot read the
  held-back recordings, but it does not run in a container.

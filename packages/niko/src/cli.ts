#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import { totalmem } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command } from "commander";
import { adoptCookies, parseCookies, serveAdopt } from "./adopt/index.js";
import { analyze } from "./analyze/index.js";
import { build, estimateBuild } from "./builder/index.js";
import { type CaptureOptions, capture, forgetSession, launchBrowser, loadPolicy, savePolicy } from "./capture/index.js";
import { SessionExpired, adoptDriftCapture, drift, scheduleDaily } from "./drift/index.js";
import { initApp } from "./init.js";
import { checkServer, connect, hasLogin, recordOnce, savedRemote } from "./remote/recorder.js";
import { issueToken, serveRecordings } from "./remote/server.js";
import { up } from "./runtime/server.js";
import { reviewSample, scrubCapture } from "./scrub/index.js";
import type { Ledger, Manifest } from "./types.js";
import {
  TOOL_VERSION,
  appPaths,
  listCaptures,
  loadConfig,
  readJson,
  resolveApp,
  saveConfig,
  writeJson,
} from "./util.js";
import { reportMarkdown, verify } from "./verify/index.js";

const CLI = fileURLToPath(import.meta.url);

// A .env file in the working directory may hold ANTHROPIC_API_KEY. Variables already set win.
if (existsSync(".env")) {
  try {
    process.loadEnvFile(".env");
  } catch {
    // An unreadable .env is ignored; `niko doctor` reports a missing key.
  }
}
const out = (s: string) => process.stdout.write(`${s}\n`);

function ctx(opts: { app?: string }) {
  const app = resolveApp(opts.app);
  const paths = appPaths(app);
  return { app, paths, config: loadConfig(paths) };
}

const program = new Command();
program
  .name("niko")
  .description("An exact working copy of any web app, as a sandbox for testing AI agents.")
  .version(TOOL_VERSION);
const withApp = (c: Command) => c.option("--app <name>", "which app under .niko/ (needed only when there are several)");

withApp(program.command("init <url>").description("Set up a new app and open Chrome so you can log in once"))
  .option("--origin <origin...>", "extra origins the copy should answer for (default: the URL's origin)")
  .option("--no-login", "do not open the browser now")
  .option(
    "--real-account",
    "the login is (or may be) a real person's account: every capture is read-only, paced, and never sends a change",
  )
  .option(
    "--remote",
    "the app is recorded on another machine: print the token its recorder needs, and do not log in here",
  )
  .action(
    async (
      url: string,
      o: { app?: string; origin?: string[]; login: boolean; realAccount?: boolean; remote?: boolean },
    ) => {
      const u = new URL(url);
      const { paths, config } = initApp(url, {
        app: o.app,
        origins: o.origin ? [u.origin, ...o.origin] : undefined,
        realAccount: o.realAccount,
      });
      out(`Created ${paths.root}`);
      if (o.remote) {
        out("This app is recorded on another machine. Start the receiver here with: niko serve");
        out("On the machine that can log in to the app, run:");
        out(`  niko record --server <this receiver's https address> --token ${issueToken(paths)}`);
        out("The token is shown only now and is for this app only. Running this command again replaces it.");
        return;
      }
      if (config.realAccount)
        out(
          "Real-account mode: nothing that changes the account (posting, voting, saving, deleting, logging out) is ever sent, whoever clicks it.",
        );
      if (o.login) await openForLogin(paths, config.startUrl, !!config.realAccount);
      out("Next: niko capture");
    },
  );

withApp(program.command("login").description("Open Chrome with the saved profile to log in again")).action(
  async (o) => {
    const { paths, config } = ctx(o);
    await openForLogin(paths, config.startUrl, !!config.realAccount);
  },
);

withApp(
  program.command("forget").description("Delete the saved login (the tool's Chrome profile and session cookies)"),
).action((o) => {
  const { paths } = ctx(o);
  out(forgetSession(paths) ? "The saved login was deleted." : "There was no saved login.");
});

withApp(
  program
    .command("adopt [file]")
    .description("Take in a login a person made in their own browser, instead of logging in here"),
)
  .option("--serve", "keep a localhost receiver open and take in each session as it is pushed")
  .option("--port <n>", "receiver port (with --serve)", (v) => Number.parseInt(v, 10), 8899)
  .option("--no-probe", "do not check the session against the live app")
  .action(async (file: string | undefined, o) => {
    const { paths, config } = ctx(o);
    if (o.serve) {
      const h = await serveAdopt(paths, config, { port: o.port });
      out(`Session receiver for ${config.app} is listening. No password is ever sent or stored.`);
      out(`  Push a session to:  POST ${h.url}/session`);
      out(`  With the header:    Authorization: Bearer ${h.token}`);
      out("  Body:               the app's cookies as a JSON array exported from any browser.");
      out("Press Ctrl-C to stop.");
      await new Promise<void>((done) => process.on("SIGINT", () => h.close().then(done)));
      return;
    }
    if (!file) throw new Error("Give a cookies file, or use --serve. See `niko adopt --help`.");
    const r = await adoptCookies(paths, config, parseCookies(readFileSync(resolve(file), "utf8")), {
      probe: o.probe,
    });
    if (!r.kept) {
      out(`None of those cookies are for ${config.origins.join(", ")}. Nothing was taken in.`);
      process.exitCode = 1;
      return;
    }
    out(`Took in ${r.kept} cookies for ${config.app}${r.dropped ? ` (ignored ${r.dropped} for other sites)` : ""}.`);
    if (r.probe) {
      out(r.probe.live ? `The session is live: ${r.probe.reason}.` : `The session looks dead: ${r.probe.reason}.`);
      if (!r.probe.live) process.exitCode = 1;
    }
  });

/** With --wait, hold a receiver open for a fresh human login and return once one proves live. */
async function waitForLiveSession(
  paths: ReturnType<typeof appPaths>,
  config: ReturnType<typeof loadConfig>,
  minutes: number,
  port: number,
): Promise<boolean> {
  let live = false;
  const h = await serveAdopt(paths, config, {
    port,
    onAdopt: (r) => {
      if (r.probe?.live) live = true;
    },
  });
  out(
    `The saved login has expired. Waiting up to ${minutes} min for a fresh one: push the app's cookies to POST ${h.url}/session (header Authorization: Bearer ${h.token}).`,
  );
  const deadline = Date.now() + minutes * 60_000;
  while (!live && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
  await h.close();
  return live;
}

async function openForLogin(paths: ReturnType<typeof appPaths>, url: string, realAccount = false) {
  out(
    "A Chrome window is opening. Log in, then close the window. The session is kept in a profile used only by this tool.",
  );
  if (realAccount)
    out(
      "This window is not gated: only log in here. The saved profile is a live login to your account: anyone who can read this folder can use it. Delete it with `niko forget` when you are done.",
    );
  const context = await launchBrowser(paths, {});
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(url).catch(() => {});
  await new Promise<void>((r) => context.on("close", () => r()));
}

withApp(program.command("capture").description("Record the live app"))
  .option("--human", "you use the app; everything is recorded (default)")
  .option("--explore", "automatic read-only crawl; writes are blocked")
  .option(
    "--script <file>",
    "run this session instead of a person: a module whose default export is async (page) => {}",
  )
  .option("--allow-writes", "with --explore: let writes through (only for apps you own that reset)")
  .option("--max-actions <n>", "with --explore: stop after this many actions", (v) => Number.parseInt(v, 10))
  .option("--headless", "no visible window (not for --human)")
  .option("--screenshots", "also save a screenshot with each snapshot")
  .option("--label <text>", "a note stored with the capture")
  .option("--after-reset", "the app's data was put back to its starting state before this session (test systems)")
  .option("--delay <seconds>", "wait this long between page and data requests to the live app", (v) =>
    Number.parseFloat(v),
  )
  .option("--forget-after", "delete the saved login when the capture ends")
  .action(async (o) => {
    const { paths, config } = ctx(o);
    if (o.script && o.explore) throw new Error("Use --script or --explore, not both.");
    if (config.realAccount && o.allowWrites)
      throw new Error(
        "This app is set up as a real account: --allow-writes is refused. Nothing that changes it is sent.",
      );
    let script: CaptureOptions["script"];
    if (o.script) {
      const mod = await import(pathToFileURL(resolve(String(o.script))).href);
      if (typeof mod.default !== "function")
        throw new Error(`${o.script} must have a default export: async (page, { context }) => { ... }`);
      script = mod.default;
    }
    const id = await capture(paths, config, {
      mode: o.script ? "script" : o.explore ? "explore" : "human",
      script,
      allowWrites: config.realAccount ? undefined : o.explore ? !!o.allowWrites : true,
      maxActions: o.maxActions,
      delaySeconds: o.delay,
      forgetAfter: !!o.forgetAfter,
      headless: !!o.headless,
      screenshots: !!o.screenshots,
      label: o.label,
      afterReset: !!o.afterReset,
    });
    const a = analyze(paths, config);
    out(`Capture ${id} saved. ${a.coverage.exchanges} exchanges in ${a.coverage.clusters} endpoints so far.`);
    out("Next: niko up (replay as recorded), or niko build (make it stateful).");
  });

withApp(program.command("policy").description("Show or change which endpoints are reads and which are writes"))
  .option("--set <key=decision...>", 'for example --set "POST example.com /api/search=read"')
  .action((o) => {
    const { paths } = ctx(o);
    const policy = loadPolicy(paths);
    for (const s of (o.set as string[] | undefined) ?? []) {
      const i = s.lastIndexOf("=");
      const decision = s.slice(i + 1);
      if (!["read", "write", "unknown"].includes(decision))
        throw new Error(`Decision must be read, write or unknown: ${s}`);
      policy[s.slice(0, i)] = { decision: decision as "read" | "write" | "unknown", by: "user" };
    }
    if (o.set) savePolicy(paths, policy);
    for (const [k, v] of Object.entries(policy))
      out(`${v.decision.padEnd(8)} ${v.by.padEnd(10)} ${k}${v.note ? `  (${v.note})` : ""}`);
    if (!Object.keys(policy).length) out("No decisions yet. They are added as requests other than GET are seen.");
    out(`\nFile: ${join(paths.root, "policy.yaml")}`);
  });

withApp(program.command("scrub").description("Remove secrets (and optionally personal data) from the captures"))
  .option("--pii", "also replace personal data with consistent fakes")
  .option("--off", "only strip secrets (for apps with fictional data)")
  .option("--review", "show what was replaced and what still looks personal")
  .option("--confirm", "mark the review as done, which allows a build on personal data")
  .action(async (o) => {
    const { paths, config } = ctx(o);
    const mode = o.pii ? "pii" : o.off ? "secrets" : config.scrub;
    for (const id of listCaptures(paths)) {
      // A recording received from `niko record` has no raw copy here: there is nothing to scrub it again from.
      if (!existsSync(join(paths.captures, id, "episodes")))
        out(`${id}: recorded on another machine and scrubbed there; it cannot be scrubbed again here`);
      else {
        const r = await scrubCapture(paths, id, mode);
        out(`${id}: ${r.secrets} secrets, ${r.pii} personal values, ${r.replacements} replacements`);
        if (o.review) {
          out("  Replaced with (sample):");
          for (const s of r.samples) out(`    ${s.kind}: ${s.fake}`);
        }
      }
      if (o.review) {
        out("  Still present and looks like a name or date (check these):");
        for (const s of reviewSample(paths, id)) out(`    ${s}`);
      }
      if (o.confirm) {
        const file = join(paths.captures, id, "manifest.json");
        writeJson(file, { ...readJson<Manifest>(file), reviewed: true });
      }
    }
    if (mode === "pii") out("Automated de-identification is not a guarantee. Keep captures on this machine.");
  });

withApp(program.command("analyze").description("Group requests into endpoints and classify them (no model)")).action(
  (o) => {
    const { paths, config } = ctx(o);
    const a = analyze(paths, config);
    out(
      `Endpoints: ${a.coverage.clusters}  (static ${a.coverage.static ?? 0}, read ${a.coverage.read ?? 0}, write ${a.coverage.write ?? 0}, session ${a.coverage.session ?? 0}, noise ${a.coverage.noise ?? 0})`,
    );
    out(
      `Exchanges: ${a.coverage.exchanges}; kept back for checking: ${a.split.heldOut.length}; read-after-write checks: ${a.split.l3.length}`,
    );
    if (a.codeEndpoints.length)
      out(
        `Named in the app's code but never seen (${a.codeEndpoints.length}): ${a.codeEndpoints.slice(0, 8).join(", ")}${a.codeEndpoints.length > 8 ? ", ..." : ""}`,
      );
    out(`Files: ${paths.analysis}`);
  },
);

withApp(program.command("build").description("Generate the stateful copy with a coding agent, then check it"))
  .option("--max-usd <x>", "stop when this much has been spent", Number.parseFloat)
  .option("--resume", "continue an interrupted build")
  .option("--cluster <ids>", "only these endpoints, comma-separated")
  .option("--yes", "do not ask before spending")
  .action(async (o) => {
    const { paths, config } = ctx(o);
    for (const id of listCaptures(paths)) {
      const m = readJson<Manifest>(join(paths.captures, id, "manifest.json"));
      if (m.phi && !m.reviewed)
        throw new Error(
          `Capture ${id} holds personal data and has not been reviewed. Run: niko scrub --review, then niko scrub --confirm`,
        );
    }
    analyze(paths, config);
    const est = estimateBuild(paths, o.cluster?.split(","));
    const cap = o.maxUsd ?? config.budgets.buildUsd;
    out(
      `${est.endpoints} endpoints to build. Rough cost $${est.lowUsd}-${est.highUsd}; hard stop at $${cap}. Uses your ANTHROPIC_API_KEY.`,
    );
    if (!o.yes && process.stdin.isTTY) {
      process.stdout.write("Start? [y/N] ");
      const answer = await new Promise<string>((r) => process.stdin.once("data", (d) => r(String(d).trim())));
      process.stdin.pause();
      if (!/^y/i.test(answer)) return;
    }
    const r = await build(paths, config, {
      maxUsd: cap,
      resume: !!o.resume,
      clusters: o.cluster ? String(o.cluster).split(",") : undefined,
      onProgress: (l) => out(`  ${l}`),
    });
    out(
      `Build ${r.stoppedBecause === "done" ? "finished" : `stopped (${r.stoppedBecause})`}. Spent about $${r.costUsd.toFixed(2)} (the SDK's estimate, not a bill).`,
    );
    out(summaryLine(r.ledger));
  });

const summaryLine = (l: Ledger) =>
  `Endpoints: ${Object.entries(l.summary)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ")}`;

withApp(program.command("verify").description("Check the copy against the recordings (no model)"))
  .option("--json", "print the full result as JSON")
  .option("--no-write", "do not update ledger.json")
  .option("--cluster <ids>", "only report these endpoints, comma-separated")
  .option("--build-only", "hide expected content of held-back exchanges (what the builder sees)")
  .action(async (o) => {
    const { paths, config } = ctx(o);
    const r = await verify(paths, config, {
      write: o.write,
      onlyClusters: o.cluster ? String(o.cluster).split(",") : undefined,
      buildOnly: !!o.buildOnly,
    });
    if (o.json) {
      out(JSON.stringify(r));
      return;
    }
    out(`${r.passed}/${r.checked} checks pass. ${summaryLine(r.ledger)}`);
    for (const c of r.ledger.clusters)
      for (const f of c.failures.slice(0, 3)) out(`FAIL ${c.cluster} ${c.key} [${f.level}] ${f.exchange}: ${f.diff}`);
    if (r.failures.length) process.exitCode = 1;
  });

withApp(program.command("report").description("Ledger and coverage as Markdown")).action(async (o) => {
  const { paths, config } = ctx(o);
  const ledgerFile = join(paths.replica, "ledger.json");
  const ledger = existsSync(ledgerFile) ? readJson<Ledger>(ledgerFile) : (await verify(paths, config)).ledger;
  const coverageFile = join(paths.analysis, "coverage.json");
  const md = reportMarkdown(ledger, existsSync(coverageFile) ? readJson(coverageFile) : undefined);
  writeFileSync(join(paths.replica, "report.md"), md);
  out(md);
});

withApp(program.command("up").description("Run the copy; any browser agent can use it at the app's original URLs"))
  .option("--port <p>", "proxy port", (v) => Number.parseInt(v, 10), 8877)
  .option("--control-port <p>", "port for /reset, /state, /log, /ledger", (v) => Number.parseInt(v, 10), 8878)
  .option("--cdp-port <p>", "DevTools port of the Chrome we launch", (v) => Number.parseInt(v, 10), 9333)
  .option("--no-chrome", "do not launch Chrome; print the flags instead")
  .option("--headless", "launch Chrome without a window")
  .option("--today", "use the real clock instead of continuing from the capture time")
  .option("--replay-only", "ignore generated handlers; answer only from recordings")
  .action(async (o) => {
    const { paths, config } = ctx(o);
    if (!existsSync(join(paths.analysis, "clusters.json"))) analyze(paths, config);
    const s = await up(paths, config, {
      proxyPort: o.port,
      controlPort: o.controlPort,
      cdpPort: o.cdpPort,
      launchChrome: o.chrome,
      headless: !!o.headless,
      clock: o.today ? "today" : "capture",
      replayOnly: !!o.replayOnly,
    });
    out(`The copy of ${config.app} is running.`);
    out(`  App URL (unchanged):  ${config.startUrl}`);
    if (s.cdpUrl) out(`  Attach your agent to: ${s.cdpUrl}   (Chrome DevTools address)`);
    else out(`  Start Chrome with:    ${s.chromeArgs.join(" ")} --user-data-dir=<empty dir>`);
    out(`  Control:              POST ${s.controlUrl}/reset   GET ${s.controlUrl}/state | /log | /ledger`);
    out("Press Ctrl-C to stop.");
    const stop = async () => {
      await s.stop();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });

const running = (paths: ReturnType<typeof appPaths>) => {
  const file = join(paths.run, "up.json");
  if (!existsSync(file)) throw new Error("The copy is not running. Start it with: niko up");
  return readJson<{ pid: number; controlPort: number }>(file);
};

withApp(program.command("reset").description("Restore the copy's data to the seed")).action(async (o) => {
  const { paths } = ctx(o);
  const r = await fetch(`http://127.0.0.1:${running(paths).controlPort}/reset`, { method: "POST" });
  out(r.ok ? "Reset." : `Reset failed: ${r.status}`);
});

withApp(program.command("down").description("Stop the running copy")).action((o) => {
  const { paths } = ctx(o);
  process.kill(running(paths).pid, "SIGTERM");
  out("Stopped.");
});

withApp(program.command("drift").description("Re-check the live app and report what changed"))
  .option("--headless", "no visible window")
  .option("--update", "take the new recording into the copy and rebuild the affected endpoints")
  .option("--max-usd <x>", "with --update: spending cap for the rebuild", Number.parseFloat)
  .option(
    "--wait <minutes>",
    "if the saved login has expired, hold a receiver open this long for a fresh one (see `niko adopt`)",
    Number.parseFloat,
  )
  .option("--port <n>", "receiver port (with --wait)", (v) => Number.parseInt(v, 10), 8899)
  .action(async (o) => {
    const { paths, config } = ctx(o);
    const run = async () => {
      const r = await drift(paths, config, { headless: !!o.headless });
      out(readFileSync(join(paths.drift, "drift-report.md"), "utf8"));
      if (o.update && r.items.length) {
        adoptDriftCapture(paths, r.capture);
        analyze(paths, config);
        const hasRoutes = existsSync(join(paths.replica, "routes"));
        if (hasRoutes && r.affectedClusters.length) {
          const b = await build(paths, config, {
            maxUsd: o.maxUsd,
            resume: true,
            clusters: r.affectedClusters,
            onProgress: (l) => out(`  ${l}`),
          });
          out(
            `Rebuilt ${r.affectedClusters.length} endpoints for about $${b.costUsd.toFixed(2)}. ${summaryLine(b.ledger)}`,
          );
        } else out("The copy now replays the new recording.");
      }
      process.exitCode = r.worst === "breaking" ? 2 : r.worst === "none" ? 0 : 1;
    };
    try {
      await run();
    } catch (e) {
      if (!(e instanceof SessionExpired)) throw e;
      if (o.wait && (await waitForLiveSession(paths, config, o.wait, o.port))) {
        try {
          await run();
          return;
        } catch (e2) {
          if (!(e2 instanceof SessionExpired)) throw e2;
        }
      }
      out(e.message);
      process.exitCode = 3;
    }
  });

program
  .command("serve")
  .description("Receive recordings made on other machines (niko record) and keep each app's copy up to date")
  .option("--port <n>", "port to listen on", (v) => Number.parseInt(v, 10), 8787)
  .option("--host <address>", "address to listen on; other machines reach it through your TLS proxy", "127.0.0.1")
  .option("--cert <file>", "serve https yourself: the certificate (with --key)")
  .option("--key <file>", "serve https yourself: the private key (with --cert)")
  .option("--max-usd <x>", "build the stateful copy, spending at most this much per app in total", Number.parseFloat)
  .action(async (o) => {
    if (!!o.cert !== !!o.key) throw new Error("Give --cert and --key together.");
    const local = ["127.0.0.1", "localhost", "::1"].includes(o.host);
    const h = await serveRecordings(process.cwd(), {
      port: o.port,
      host: o.host,
      tls: o.cert ? { cert: readFileSync(resolve(o.cert)), key: readFileSync(resolve(o.key)) } : undefined,
      maxUsd: o.maxUsd,
      log: out,
    });
    out(`Receiver listening on ${h.url}. Register an app with: niko init <url> --remote`);
    if (!local && !o.cert)
      out(
        "This is plain http on a network address. Recorders only talk https: put a TLS proxy in front, or use --cert and --key.",
      );
    out(
      o.maxUsd === undefined
        ? "No --max-usd: each recording updates a replay copy and nothing is spent."
        : `Each recording is built into a stateful copy, for at most $${o.maxUsd} per app in total. Uses your ANTHROPIC_API_KEY.`,
    );
    out("Press Ctrl-C to stop.");
    await new Promise<void>((done) => process.on("SIGINT", () => h.close().then(done)));
  });

withApp(
  program
    .command("record")
    .description("Record the app on this machine, read-only, and send the scrubbed recording to a niko serve receiver"),
)
  .option("--server <url>", "the receiver's https address (or NIKO_SERVER); needed the first time only")
  .option("--token <token>", "the token printed by `niko init <url> --remote` (or NIKO_TOKEN); first time only")
  .option("--every <minutes>", "how often to re-check the app", Number.parseFloat, 60)
  .option("--once", "one round, then stop")
  .option("--human", "first recording: you use the app in the window, instead of the automatic crawl")
  .option("--show", "show the browser window while it records")
  .option("--no-login", "do not open a window to log in when there is no saved login")
  .option("--max-actions <n>", "first recording: stop the crawl after this many actions", (v) => Number.parseInt(v, 10))
  .option("--delay <seconds>", "wait this long between page and data requests to the app; remembered", (v) =>
    Number.parseFloat(v),
  )
  .action(async (o) => {
    const server = o.server ?? process.env.NIKO_SERVER;
    const token = o.token ?? process.env.NIKO_TOKEN;
    let paths: ReturnType<typeof appPaths>;
    let config: ReturnType<typeof loadConfig>;
    if (server && token) ({ paths, config } = await connect({ server, token }));
    else if (server || token) throw new Error("Give both --server and --token (or NIKO_SERVER and NIKO_TOKEN).");
    else ({ paths, config } = ctx(o));
    const remote = savedRemote(paths);
    if (!remote)
      throw new Error("This app is not connected to a receiver yet. Run: niko record --server <url> --token <token>");
    checkServer(remote.server);
    if (o.delay !== undefined) {
      config = { ...config, delaySeconds: o.delay };
      saveConfig(paths, config);
    }
    out(`Recording ${config.app} for ${remote.server}. Read-only: nothing that changes the app is sent.`);
    out(
      "The login, the raw recording and the browser profile stay on this machine. Only the scrubbed recording is sent.",
    );
    if (!hasLogin(paths) && o.login) await openForLogin(paths, config.startUrl, true);
    for (;;) {
      const round = recordOnce(paths, config, remote, {
        human: !!o.human,
        headless: !o.show,
        maxActions: o.maxActions,
        log: out,
      });
      // Left running, one bad round (the receiver is down, the network dropped) must not end the recorder:
      // what was recorded is kept and sent at the next round.
      const t = o.once
        ? await round
        : await round.catch((e: Error) => {
            out(`This round failed: ${e.message} Trying again at the next one.`);
            return undefined;
          });
      if (!t) {
        await new Promise((r) => setTimeout(r, o.every * 60_000));
        continue;
      }
      out(
        {
          recorded: `First recording ${t.capture} made and sent.`,
          unchanged: "Checked: the app has not changed.",
          drift: `The app changed (${t.detail}). Recording ${t.capture} sent.`,
          "session-expired":
            "The login has expired. Log in again with `niko login`, or hand over a session with `niko adopt`.",
          "not-logged-in":
            "Only a login page was seen, so nothing was recorded. Log in with `niko login`, or hand over a session with `niko adopt`.",
        }[t.state],
      );
      if (o.once) {
        if (t.state === "session-expired" || t.state === "not-logged-in") process.exitCode = 3;
        return;
      }
      await new Promise((r) => setTimeout(r, o.every * 60_000));
    }
  });

withApp(program.command("schedule <when>").description("Run the drift check every day (when: daily)"))
  .option("--hour <h>", "hour of the day, 0-23", (v) => Number.parseInt(v, 10), 6)
  .action((when: string, o) => {
    if (when !== "daily") throw new Error("Only `daily` is supported.");
    const { app } = ctx(o);
    const s = scheduleDaily(process.cwd(), app, CLI, o.hour);
    out(`Wrote ${s.file}\nTurn it on with:\n  ${s.enable}`);
    out(
      "The check uses the saved login. When the app's session expires, feed it a fresh one with `niko adopt` (no re-login here needed), or add `--wait <minutes>` to hold a receiver open for one.",
    );
  });

program
  .command("doctor")
  .description("Check that this machine can run the tool")
  .action(async () => {
    const ok = (good: boolean, label: string, hint = "") =>
      out(`${good ? "ok  " : "FAIL"} ${label}${good || !hint ? "" : `  -> ${hint}`}`);
    const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
    ok(major > 22 || (major === 22 && minor >= 13), `Node ${process.versions.node}`, "Node 22.13 or newer is needed");
    const chrome =
      process.platform === "darwin"
        ? existsSync("/Applications/Google Chrome.app")
        : ["google-chrome", "google-chrome-stable", "chromium"].some((b) => has(b));
    ok(chrome, "Google Chrome", "install Chrome, or run: npx playwright install chromium");
    ok(
      !!process.env.ANTHROPIC_API_KEY || !!process.env.CLAUDE_CODE_USE_BEDROCK || !!process.env.CLAUDE_CODE_USE_VERTEX,
      "ANTHROPIC_API_KEY (needed for `niko build` only)",
      "export ANTHROPIC_API_KEY=...",
    );
    const sdk = await import("@anthropic-ai/claude-agent-sdk" as string).then(() => true).catch(() => false);
    ok(sdk, "Claude Agent SDK (needed for `niko build` only)", "npm install @anthropic-ai/claude-agent-sdk");
    ok(
      totalmem() >= 6 * 2 ** 30,
      `Memory ${(totalmem() / 2 ** 30).toFixed(0)} GB`,
      "builds run up to 4 agents at about 1 GB each",
    );
    try {
      const fs = statfsSync(process.cwd());
      const free = (fs.bavail * fs.bsize) / 2 ** 30;
      ok(free > 2, `Disk ${free.toFixed(0)} GB free`, "captures need a few GB");
    } catch {}
    ok(has("docker"), "Docker (optional)", "only needed to run copies in CI containers");
  });

function has(bin: string) {
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

program.parseAsync().catch((e: Error & { code?: string }) => {
  if (e.code === "EADDRINUSE")
    e.message = `${e.message}\n  A copy may already be running: stop it with \`niko down\`, or choose other ports with --port, --control-port and --cdp-port.`;
  process.stderr.write(`niko: ${e.message}\n`);
  process.exit(1);
});

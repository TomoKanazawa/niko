import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import YAML from "yaml";
import { analyze } from "../analyze/index.js";
import { type BuildOptions, type BuildState, build } from "../builder/index.js";
import { loadPolicy, savePolicy } from "../capture/index.js";
import { initApp } from "../init.js";
import type { AppConfig, Cluster, Manifest, Policy } from "../types.js";
import {
  type AppPaths,
  TOOL_VERSION,
  appPaths,
  ensureDir,
  listCaptures,
  loadConfig,
  readJson,
  sandboxRoot,
  writeJson,
} from "../util.js";
import { PackError, unpack } from "./pack.js";

/**
 * The receiving side of a recording made on another machine.
 *
 * `enrollApp` registers an app and hands out a token for it. `serveRecordings` takes in packs sent with that
 * token, files each one as a capture of that app, and then analyzes and (when a spending cap was given) builds,
 * one job at a time. A token only ever reaches the app it was issued for: the app is read from the token, never
 * from what the sender says.
 */

const TOKEN_FILE = "upload-token.sha256";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Make a new upload token for an app. Only its hash is kept here; the token itself is returned once. */
export function issueToken(paths: AppPaths): string {
  const token = randomBytes(24).toString("base64url");
  writeFileSync(join(ensureDir(paths.root), TOKEN_FILE), `${sha(token)}\n`, { mode: 0o600 });
  return token;
}

/** Register an app whose recordings will arrive from another machine. */
export function enrollApp(
  url: string,
  opts: { cwd?: string; app?: string; origins?: string[] } = {},
): { paths: AppPaths; config: AppConfig; token: string } {
  const { paths, config } = initApp(url, opts);
  return { paths, config, token: issueToken(paths) };
}

/** The app a token was issued for, if any. */
function appForToken(root: string, token: string): string | undefined {
  if (!token || !existsSync(root)) return undefined;
  const given = Buffer.from(sha(token));
  let found: string | undefined;
  for (const d of readdirSync(root, { withFileTypes: true })) {
    const file = join(root, d.name, TOKEN_FILE);
    if (!d.isDirectory() || !existsSync(file)) continue;
    const kept = Buffer.from(readFileSync(file, "utf8").trim());
    // Every app is compared, so the time taken does not say which one matched.
    if (kept.length === given.length && timingSafeEqual(kept, given)) found = d.name;
  }
  return found;
}

export interface JobResult {
  app: string;
  capture: string;
  kind: "capture" | "drift";
  at: string;
  endpoints: number;
  built: boolean;
  costUsd: number;
  note: string;
  error?: string;
}

export interface RecorderStatus {
  state: string;
  detail?: string;
  at: string;
}

export interface ServeOptions {
  port?: number;
  /** Default 127.0.0.1. Put TLS in front before listening anywhere else, or pass `tls`. */
  host?: string;
  tls?: { cert: Buffer; key: Buffer };
  /** The most the builds for one app may cost in total. Without it nothing is built: the copy replays. */
  maxUsd?: number;
  /** Largest pack taken, counted unpacked. */
  maxBytes?: number;
  runner?: BuildOptions["runner"];
  check?: BuildOptions["check"];
  /** Stands in for the builder (tests). */
  builder?: typeof build;
  onJob?: (job: JobResult) => void;
  log?: (line: string) => void;
}

export interface ServeHandle {
  url: string;
  port: number;
  /** Resolves when every job queued so far has finished. */
  idle(): Promise<void>;
  close(): Promise<void>;
}

const send = (res: ServerResponse, status: number, value?: unknown) => {
  if (value === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};

async function readSmall(req: IncomingMessage, limit = 16 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new PackError("The request is too large.");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Keep only what a manifest is allowed to say, checked against the app it claims to be a recording of. */
function cleanManifest(raw: unknown, config: AppConfig): Manifest {
  const m = raw as Partial<Manifest>;
  if (!m || typeof m !== "object" || typeof m.id !== "string" || !/^\d{8}-\d{6}$/.test(m.id))
    throw new PackError("The manifest has no valid capture id.");
  if (
    !Array.isArray(m.origins) ||
    !m.origins.every((o) => typeof o === "string") ||
    !sameSet(m.origins, config.origins)
  )
    throw new PackError(`The recording is not of ${config.origins.join(", ")}.`);
  const mode = m.mode === "human" || m.mode === "explore" ? m.mode : "script";
  const text = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : undefined);
  return {
    toolVersion: text(m.toolVersion, 40) ?? TOOL_VERSION,
    id: m.id,
    origins: config.origins,
    startUrl: config.startUrl,
    startedAt: text(m.startedAt, 40) ?? new Date().toISOString(),
    endedAt: text(m.endedAt, 40),
    browser: text(m.browser, 80),
    viewport:
      m.viewport && Number.isFinite(m.viewport.width) && Number.isFinite(m.viewport.height) ? m.viewport : undefined,
    mode,
    allowWrites: m.allowWrites === true,
    episodes: Number.isInteger(m.episodes) ? (m.episodes as number) : 1,
    scrub: m.scrub === "pii" ? "pii" : "secrets",
    phi: m.phi === true || undefined,
    // A review done on another machine does not count here.
    reviewed: undefined,
    label: text(m.label) ?? "from a recorder",
    afterReset: m.afterReset === true || undefined,
  };
}

/** Add the sender's read/write decisions where this side has none of its own. */
function mergePolicy(paths: AppPaths, file: string) {
  let theirs: Policy;
  try {
    theirs = (YAML.parse(readFileSync(file, "utf8")) as Policy) ?? {};
  } catch {
    return;
  }
  const mine = loadPolicy(paths);
  let changed = false;
  for (const [key, entry] of Object.entries(theirs).slice(0, 5000)) {
    if (mine[key] || key.length > 500 || !entry || !["read", "write", "unknown"].includes(entry.decision)) continue;
    // A decision made by a person over there is evidence here, not an order.
    mine[key] = { decision: entry.decision, by: entry.by === "user" ? "evidence" : "heuristic" };
    changed = true;
  }
  if (changed) savePolicy(paths, mine);
}

export async function serveRecordings(cwd: string, opts: ServeOptions = {}): Promise<ServeHandle> {
  const root = sandboxRoot(cwd);
  const say = opts.log ?? (() => {});
  const runBuild = opts.builder ?? build;
  let queue: Promise<void> = Promise.resolve();

  const stateFile = (paths: AppPaths) => join(paths.run, "serve.json");
  const readState = (paths: AppPaths): { recorder?: RecorderStatus; lastJob?: JobResult } =>
    existsSync(stateFile(paths)) ? readJson(stateFile(paths)) : {};
  const patchState = (paths: AppPaths, patch: { recorder?: RecorderStatus; lastJob?: JobResult }) =>
    writeJson(stateFile(paths), { ...readState(paths), ...patch });

  /** Turn a filed recording into an up-to-date copy. */
  const job = async (app: string, id: string, kind: JobResult["kind"]) => {
    const paths = appPaths(app, cwd);
    const config = loadConfig(paths);
    const result: JobResult = {
      app,
      capture: id,
      kind,
      at: new Date().toISOString(),
      endpoints: 0,
      built: false,
      costUsd: 0,
      note: "",
    };
    try {
      const a = analyze(paths, config);
      result.endpoints = a.coverage.clusters ?? 0;
      const buildState = join(paths.build, "state.json");
      const prior = existsSync(buildState) ? readJson<BuildState>(buildState) : undefined;
      const unreviewed = listCaptures(paths).some((c) => {
        const m = readJson<Manifest>(join(paths.captures, c, "manifest.json"));
        return m.phi && !m.reviewed;
      });
      if (opts.maxUsd === undefined)
        result.note = "The copy replays the new recording. Nothing was built: no spending cap was given.";
      else if (unreviewed)
        result.note =
          "The copy replays the new recording. Nothing was built: a recording holds personal data that has not been reviewed here (niko scrub --review, then --confirm).";
      else if (prior && opts.maxUsd - prior.costUsd < 0.05)
        result.note = `The copy replays the new recording. Nothing was built: the $${opts.maxUsd} cap for this app is spent.`;
      else {
        // The sender names changed endpoints by their stable key; ids are this side's own.
        let clusters: string[] | undefined;
        const driftFile = join(paths.captures, id, "drift.json");
        if (kind === "drift" && prior && existsSync(driftFile)) {
          const named = readJson<{ affectedKeys?: unknown }>(driftFile).affectedKeys;
          const keys = new Set(Array.isArray(named) ? named.filter((k) => typeof k === "string") : []);
          const all = readJson<Cluster[]>(join(paths.analysis, "clusters.json"));
          // Plus endpoints the new recording shows for the first time: no build has tried them yet.
          const untried = (c: Cluster) =>
            (c.class === "read" || c.class === "write") && !prior.steps[`implement:${c.id}`];
          const ids = all.filter((c) => keys.has(c.key) || untried(c)).map((c) => c.id);
          if (ids.length) clusters = ids;
        }
        const r = await runBuild(paths, config, {
          // With `resume`, what earlier builds cost counts against the cap, so it is a total for the app.
          maxUsd: opts.maxUsd,
          resume: true,
          clusters,
          maxCycles: (prior?.cycles ?? 0) + (prior ? 3 : 8),
          runner: opts.runner,
          check: opts.check,
          onProgress: (l) => say(`  ${app}: ${l}`),
        });
        result.built = true;
        result.costUsd = r.costUsd - (prior?.costUsd ?? 0);
        result.note = `Build ${r.stoppedBecause === "done" ? "finished" : `stopped (${r.stoppedBecause})`}. About $${result.costUsd.toFixed(2)} this time, $${r.costUsd.toFixed(2)} of $${opts.maxUsd} in all.`;
      }
    } catch (e) {
      result.error = (e as Error).message;
      result.note = "The job failed; the recording is kept.";
    }
    patchState(paths, { lastJob: result });
    say(`${app}: ${id} ${result.error ? `failed: ${result.error}` : result.note}`);
    opts.onJob?.(result);
  };

  const receive = async (app: string, req: IncomingMessage, res: ServerResponse) => {
    const paths = appPaths(app, cwd);
    const config = loadConfig(paths);
    const tmp = join(ensureDir(join(paths.root, "incoming")), randomBytes(6).toString("hex"));
    try {
      const { files, bytes } = await unpack(req.pipe(createGunzip()), tmp, { maxBytes: opts.maxBytes });
      const manifest = cleanManifest(readJson(join(tmp, "manifest.json")), config);
      const dest = join(ensureDir(paths.captures), manifest.id);
      if (existsSync(dest)) return send(res, 200, { id: manifest.id, already: true });
      const kind: JobResult["kind"] = files.includes("drift.json") ? "drift" : "capture";
      writeJson(join(tmp, "manifest.json"), manifest);
      if (files.includes("policy.yaml")) {
        mergePolicy(paths, join(tmp, "policy.yaml"));
        rmSync(join(tmp, "policy.yaml"));
      }
      renameSync(tmp, dest);
      say(`${app}: recording ${manifest.id} received (${files.length} files, ${(bytes / 2 ** 20).toFixed(1)} MB)`);
      // One job at a time, and a job that throws must not stop the ones after it.
      queue = queue.then(() => job(app, manifest.id, kind)).catch((e) => say(`${app}: job error: ${e.message}`));
      send(res, 202, { id: manifest.id, queued: true });
    } catch (e) {
      // A refused pack is the sender's fault; anything else is ours. Neither leaves files behind.
      send(res, e instanceof PackError ? 422 : (e as { code?: string }).code?.startsWith("Z_") ? 400 : 500, {
        error: e instanceof PackError ? e.message : "The recording could not be taken in.",
      });
      if (!(e instanceof PackError)) say(`${app}: a recording could not be taken in: ${(e as Error).message}`);
      // Stop reading what is left of a refused upload, once the answer is out.
      res.once("finish", () => req.destroy());
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true, tool: TOOL_VERSION });
    const app = appForToken(root, /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "");
    if (!app) {
      res.once("finish", () => req.destroy());
      return send(res, 401, { error: "Missing or wrong token." });
    }
    const paths = appPaths(app, cwd);
    if (req.method === "GET" && path === "/app") {
      const c = loadConfig(paths);
      return send(res, 200, { app: c.app, startUrl: c.startUrl, origins: c.origins });
    }
    if (req.method === "POST" && path === "/recordings") return receive(app, req, res);
    if (req.method === "POST" && path === "/status") {
      const body = JSON.parse(await readSmall(req)) as { state?: unknown; detail?: unknown };
      // What the sender says ends up in this server's log: printable characters only.
      const plain = (v: unknown, max: number) =>
        String(v)
          .replace(/[^\x20-\x7e]/g, " ")
          .slice(0, max);
      const recorder: RecorderStatus = {
        state: plain(body.state ?? "unknown", 40),
        detail: typeof body.detail === "string" ? plain(body.detail, 300) : undefined,
        at: new Date().toISOString(),
      };
      patchState(paths, { recorder });
      say(`${app}: recorder says ${recorder.state}${recorder.detail ? ` (${recorder.detail})` : ""}`);
      return send(res, 204);
    }
    if (req.method === "GET" && path === "/status")
      return send(res, 200, {
        app,
        captures: listCaptures(paths).length,
        maxUsd: opts.maxUsd ?? null,
        ...readState(paths),
      });
    send(res, 404, {
      error: "Unknown address.",
      endpoints: ["GET /app", "POST /recordings", "POST /status", "GET /status"],
    });
  };

  const listener = (req: IncomingMessage, res: ServerResponse) =>
    void handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 400, { error: "Bad request." });
      else res.end();
    });
  const server: Server = opts.tls ? createTlsServer(opts.tls, listener) : createServer(listener);
  // A large recording over a slow line takes longer than Node's five-minute default.
  server.requestTimeout = 60 * 60_000;
  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(opts.port ?? 0, host, () => done());
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `${opts.tls ? "https" : "http"}://${host.includes(":") ? `[${host}]` : host}:${port}`,
    port,
    idle: async () => {
      // Jobs may queue more jobs; wait until the tail stops moving.
      for (let tail: Promise<void> | undefined; tail !== queue; ) {
        tail = queue;
        await tail;
      }
    },
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { analyze } from "../analyze/index.js";
import { type CaptureOptions, capture } from "../capture/index.js";
import { LOGIN_RE, SessionExpired, adoptDriftCapture, drift } from "../drift/index.js";
import { initApp } from "../init.js";
import type { AppConfig, Cluster, Manifest } from "../types.js";
import {
  type AppPaths,
  appPaths,
  listCaptures,
  loadConfig,
  readEvents,
  readJson,
  saveConfig,
  writeJson,
} from "../util.js";
import { packEntries, packStream } from "./pack.js";

/**
 * The recording side, for a machine that can reach the app with a person's own login but is not where the copy
 * is built. It records read-only, keeps the login and the raw recording here, and sends the scrubbed recording
 * to a `niko serve` receiver. After the first recording it only re-checks the app and sends what changed.
 */

export interface Remote {
  server: string;
  token: string;
}

interface RecorderState extends Remote {
  uploaded: string[];
  /** The changes last sent, so a change that keeps showing is sent once and not at every check. */
  lastChanges?: string;
}

const stateFile = (paths: AppPaths) => join(paths.root, "recorder.json");
const loadState = (paths: AppPaths): RecorderState | undefined =>
  existsSync(stateFile(paths)) ? readJson<RecorderState>(stateFile(paths)) : undefined;
const saveState = (paths: AppPaths, state: RecorderState) =>
  writeFileSync(stateFile(paths), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });

/** The server and token this folder's app was connected with, if it was. */
export function savedRemote(paths: AppPaths): Remote | undefined {
  const s = loadState(paths);
  return s && { server: s.server, token: s.token };
}

/** A login made here: the tool's browser profile, or a session taken in with `niko adopt`. */
export const hasLogin = (paths: AppPaths) =>
  existsSync(paths.profile) || existsSync(join(paths.root, "session-cookies.json"));

/**
 * The recording and the token must not cross a network in the clear, so only https is taken, or plain http to
 * this machine itself.
 */
export function checkServer(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Not an address: ${url}`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local))
    throw new Error(
      "The server address must start with https://. Plain http is taken only for this machine (localhost): the recording and the token would otherwise cross the network unprotected.",
    );
  return u.origin;
}

const auth = (remote: Remote) => ({ authorization: `Bearer ${remote.token}` });

async function refusal(res: Response): Promise<string> {
  if (res.status === 401) return "the server did not accept the token";
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `status ${res.status}`;
}

/** Ask the server which app this token is for. */
export async function remoteApp(remote: Remote): Promise<{ app: string; startUrl: string; origins: string[] }> {
  const res = await fetch(`${remote.server}/app`, { headers: auth(remote) });
  if (!res.ok) throw new Error(`Could not connect to ${remote.server}: ${await refusal(res)}.`);
  return (await res.json()) as { app: string; startUrl: string; origins: string[] };
}

/**
 * Set this folder up as the recorder of the app the token is for. The app is always treated as a real person's
 * account: nothing that changes it is sent.
 */
export async function connect(remote: Remote, cwd = process.cwd()): Promise<{ paths: AppPaths; config: AppConfig }> {
  const server = checkServer(remote.server);
  const info = await remoteApp({ server, token: remote.token });
  const paths = appPaths(info.app, cwd);
  let config: AppConfig;
  if (existsSync(paths.config)) {
    config = loadConfig(paths);
    if (config.origins.length !== info.origins.length || !config.origins.every((o) => info.origins.includes(o)))
      throw new Error(
        `This folder already has an app named ${info.app}, for ${config.origins.join(", ")}; the server's is for ${info.origins.join(", ")}.`,
      );
    if (!config.realAccount) saveConfig(paths, { ...config, realAccount: true });
    config = { ...config, realAccount: true };
  } else config = initApp(info.startUrl, { cwd, app: info.app, origins: info.origins, realAccount: true }).config;
  saveState(paths, { server, token: remote.token, uploaded: loadState(paths)?.uploaded ?? [] });
  return { paths, config };
}

async function upload(remote: Remote, paths: AppPaths, id: string) {
  const res = await fetch(`${remote.server}/recordings`, {
    method: "POST",
    headers: { ...auth(remote), "content-type": "application/x-niko-pack" },
    body: Readable.toWeb(packStream(packEntries(paths, id))) as unknown as BodyInit,
    duplex: "half",
  } as RequestInit);
  if (!res.ok) throw new Error(`The server did not take recording ${id}: ${await refusal(res)}.`);
}

/** Tell the server how the recorder is doing. Best effort: a failed note never stops a recording. */
export async function sendStatus(remote: Remote, state: string, detail?: string) {
  await fetch(`${remote.server}/status`, {
    method: "POST",
    headers: { ...auth(remote), "content-type": "application/json" },
    body: JSON.stringify({ state, detail }),
  }).catch(() => {});
}

/** True when every page the capture saw was a login page: there was no session to record with. */
function sawOnlyLogin(paths: AppPaths, id: string): boolean {
  const pages = readEvents(join(paths.captures, id, "scrubbed")).filter((e) => e.type === "snapshot");
  return pages.length > 0 && pages.every((e) => e.type === "snapshot" && LOGIN_RE.test(new URL(e.url).pathname));
}

export interface RecordOptions extends Pick<CaptureOptions, "headless" | "bundledBrowser" | "maxActions"> {
  /** First recording: a person uses the app in the window instead of the automatic crawl. */
  human?: boolean;
  log?: (line: string) => void;
}

export interface Tick {
  state: "recorded" | "unchanged" | "drift" | "session-expired" | "not-logged-in";
  capture?: string;
  /** Recordings that reached the server during this tick. */
  uploaded: string[];
  detail?: string;
}

/**
 * One round: send anything that has not arrived yet, then make the first recording, or re-check the app and send
 * the new recording when it changed in a way that matters to an agent.
 */
export async function recordOnce(
  paths: AppPaths,
  config: AppConfig,
  remote: Remote,
  opts: RecordOptions = {},
): Promise<Tick> {
  const say = opts.log ?? (() => {});
  const state = loadState(paths) ?? { ...remote, uploaded: [] };
  const sent: string[] = [];
  const push = async (id: string) => {
    await upload(remote, paths, id);
    state.uploaded.push(id);
    saveState(paths, state);
    sent.push(id);
    say(`Recording ${id} sent.`);
  };
  const recorded = () =>
    listCaptures(paths).filter((id) => readJson<Manifest>(join(paths.captures, id, "manifest.json")).mode !== "drift");
  for (const id of recorded()) if (!state.uploaded.includes(id)) await push(id);

  const headless = opts.headless ?? true;
  if (!recorded().length) {
    const id = await capture(paths, config, {
      mode: opts.human ? "human" : "explore",
      headless: opts.human ? false : headless,
      bundledBrowser: opts.bundledBrowser,
      maxActions: opts.maxActions,
      label: "recorder",
    });
    if (sawOnlyLogin(paths, id)) {
      rmSync(join(paths.captures, id), { recursive: true, force: true });
      await sendStatus(remote, "not-logged-in");
      return { state: "not-logged-in", uploaded: sent };
    }
    analyze(paths, config);
    await push(id);
    await sendStatus(remote, "recorded");
    return { state: "recorded", capture: id, uploaded: sent };
  }

  const clustersFile = join(paths.analysis, "clusters.json");
  if (!existsSync(clustersFile)) analyze(paths, config);
  const before = readJson<Cluster[]>(clustersFile);
  let report: Awaited<ReturnType<typeof drift>>;
  try {
    report = await drift(paths, config, { headless, bundledBrowser: opts.bundledBrowser });
  } catch (e) {
    if (!(e instanceof SessionExpired)) throw e;
    await sendStatus(remote, "session-expired");
    return { state: "session-expired", uploaded: sent };
  }
  // Markup that shifts with nothing else changed is not worth a new recording, and may shift on every load.
  const changes = report.items.filter((i) => i.severity !== "cosmetic");
  // The receiver may spend money on every recording it gets, so the same set of changes is never sent twice.
  const signature = changes
    .map((i) => `${i.severity} ${i.what}`)
    .sort()
    .join("\n");
  if (!changes.length || signature === state.lastChanges) {
    rmSync(join(paths.captures, report.capture), { recursive: true, force: true });
    await sendStatus(remote, "unchanged", changes.length ? "the changes already sent still show" : undefined);
    return { state: "unchanged", uploaded: sent };
  }
  state.lastChanges = signature;
  // Endpoint ids differ between machines; their keys do not.
  writeJson(join(paths.captures, report.capture, "drift.json"), {
    affectedKeys: before.filter((c) => report.affectedClusters.includes(c.id)).map((c) => c.key),
    items: changes.map((i) => ({ severity: i.severity, area: i.area, what: i.what })),
  });
  adoptDriftCapture(paths, report.capture);
  analyze(paths, config);
  await push(report.capture);
  const detail = `${changes.length} change${changes.length === 1 ? "" : "s"}, worst: ${report.worst}`;
  await sendStatus(remote, "drift", detail);
  return { state: "drift", capture: report.capture, uploaded: sent, detail };
}

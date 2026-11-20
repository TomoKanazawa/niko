import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Cookie, adoptCookies } from "../src/adopt/index.js";
import type { BuildOptions, BuildResult } from "../src/builder/index.js";
import { PackError, packEntries, packStream, unpack } from "../src/remote/pack.js";
import { checkServer, connect, recordOnce } from "../src/remote/recorder.js";
import { type JobResult, type ServeHandle, enrollApp, serveRecordings } from "../src/remote/server.js";
import type { AppConfig, Cluster, Ledger, Manifest } from "../src/types.js";
import { type AppPaths, listCaptures, readJson, writeJson } from "../src/util.js";
import { type Clinic, startClinic } from "./helpers.js";

const tmp = () => mkdtempSync(join(tmpdir(), "sbx-"));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Log into the live clinic the way a person's browser would, and hand back the session cookie it set. */
async function freshSession(clinic: Clinic): Promise<Cookie> {
  const res = await fetch(`${clinic.url}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "user=dr.test&password=test-password",
    redirect: "manual",
  });
  const sid = /sid=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
  if (!sid) throw new Error("clinic did not set a session cookie");
  return {
    name: "sid",
    value: sid,
    domain: new URL(clinic.url).hostname,
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: false,
  };
}

/** Every file under a folder, as paths relative to it. */
function walk(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p, base) : [p.slice(base.length + 1)];
  });
}

describe("pack", () => {
  const manifest = { name: "manifest.json", data: Buffer.from("{}") };
  const open = (entries: Parameters<typeof packStream>[0], opts?: Parameters<typeof unpack>[2]) =>
    unpack(packStream(entries).pipe(createGunzip()), tmp(), opts);

  it("carries a recording across and back, byte for byte", async () => {
    const body = "the body of a response";
    const entries = [
      manifest,
      { name: "scrubbed/episodes/1.jsonl", data: Buffer.from('{"type":"console"}\n') },
      { name: `scrubbed/bodies/${sha(body)}`, data: Buffer.from(body) },
      { name: "scrubbed/snapshots/s1.aria.txt", data: Buffer.from('- button "Save"') },
    ];
    const dest = tmp();
    const r = await unpack(packStream(entries).pipe(createGunzip()), dest);
    expect(r.files).toEqual(entries.map((e) => e.name));
    expect(readFileSync(join(dest, "scrubbed", "bodies", sha(body)), "utf8")).toBe(body);
    expect(statSync(join(dest, "manifest.json")).mode & 0o777).toBe(0o600);
  });

  it("refuses a file outside the recording, a body that is not what its name says, and an oversized pack", async () => {
    for (const name of ["../evil", "/etc/passwd", "session-cookies.json", "profile/Cookies", "scrubbed/../../x"])
      await expect(open([manifest, { name, data: Buffer.from("x") }])).rejects.toBeInstanceOf(PackError);
    await expect(open([manifest, { name: `scrubbed/bodies/${sha("one")}`, data: Buffer.from("two") }])).rejects.toThrow(
      /does not match its name/,
    );
    await expect(
      open([manifest, { name: "scrubbed/episodes/1.jsonl", data: Buffer.alloc(5000) }], { maxBytes: 1000 }),
    ).rejects.toThrow(/larger than/);
    await expect(open([{ name: "scrubbed/episodes/1.jsonl", data: Buffer.from("") }])).rejects.toThrow(/no manifest/);
    await expect(unpack(Readable.from([Buffer.from("not a pack at all")]), tmp())).rejects.toBeInstanceOf(PackError);
  });
});

describe("a recorder on one machine, the copy on another", () => {
  let clinic: Clinic;
  let server: ServeHandle;
  let serverCwd: string;
  let serverPaths: AppPaths;
  let remote: { server: string; token: string };
  let paths: AppPaths;
  let config: AppConfig;
  let session: Cookie;
  const jobs: JobResult[] = [];
  const builds: BuildOptions[] = [];
  const opts = { bundledBrowser: true, maxActions: 40 };

  beforeAll(async () => {
    clinic = await startClinic();
    serverCwd = tmp();
    const enrolled = enrollApp(`${clinic.url}/`, { cwd: serverCwd, app: "tiny-clinic" });
    serverPaths = enrolled.paths;
    server = await serveRecordings(serverCwd, {
      port: 0,
      maxUsd: 5,
      onJob: (j) => jobs.push(j),
      // Stands in for the model: notes what it was asked and what it "spent", and marks every endpoint as tried.
      builder: async (p, _config, o = {}) => {
        builds.push(o);
        const steps = Object.fromEntries(
          readJson<Cluster[]>(join(p.analysis, "clusters.json")).map((c) => [
            `implement:${c.id}`,
            { done: true, costUsd: 0, attempts: 1 },
          ]),
        );
        const state = { startedAt: "", updatedAt: "", costUsd: 1.5 * builds.length, cycles: 1, steps };
        writeJson(join(p.build, "state.json"), state);
        return { state, ledger: {} as Ledger, costUsd: state.costUsd, stoppedBecause: "done" } satisfies BuildResult;
      },
    });
    remote = { server: server.url, token: enrolled.token };
    const mine = await connect(remote, tmp());
    paths = mine.paths;
    // The recorder paces itself on a real account; the test app does not need that.
    config = { ...mine.config, delaySeconds: 0 };
  });
  afterAll(async () => {
    await server.close();
    await clinic.close();
  });

  it("sets the recording side up as a real account, read-only", () => {
    expect(config.realAccount).toBe(true);
    expect(config.origins).toEqual([new URL(clinic.url).origin]);
    expect(statSync(join(paths.root, "recorder.json")).mode & 0o777).toBe(0o600);
  });

  it("sends nothing when all it can see is the login page", async () => {
    const t = await recordOnce(paths, config, remote, opts);
    expect(t.state).toBe("not-logged-in");
    expect(listCaptures(paths)).toEqual([]);
    expect(listCaptures(serverPaths)).toEqual([]);
  });

  it("sends the first recording, and the login stays behind", async () => {
    session = await freshSession(clinic);
    await adoptCookies(paths, config, [session], { probe: false });
    const before = JSON.stringify(clinic.state());
    const t = await recordOnce(paths, config, remote, opts);
    expect(t.state).toBe("recorded");
    expect(t.uploaded).toEqual([t.capture]);
    expect(JSON.stringify(clinic.state())).toBe(before); // recording changed nothing in the app
    await server.idle();

    expect(listCaptures(serverPaths)).toEqual([t.capture]);
    const clusters = readJson<Cluster[]>(join(serverPaths.analysis, "clusters.json"));
    expect(clusters.some((c) => c.class === "read" && c.pathTemplate.startsWith("/patients"))).toBe(true);
    expect(jobs[0]).toMatchObject({ kind: "capture", capture: t.capture, built: true });
    expect(builds[0]).toMatchObject({ maxUsd: 5, resume: true, clusters: undefined });

    // The session is on the recording machine and nowhere on the receiving one.
    expect(readFileSync(join(paths.root, "session-cookies.json"), "utf8")).toContain(session.value);
    const received = walk(serverCwd);
    for (const f of received) expect(readFileSync(join(serverCwd, f), "latin1")).not.toContain(session.value);
    for (const kept of ["profile", "session-cookies.json", "pseudonyms.json", "recorder.json", "/har/", "incoming/"])
      expect(received.filter((f) => f.includes(kept))).toEqual([]);
    // Only the scrubbed recording arrived: no raw episodes or bodies beside it.
    const dir = join(serverPaths.captures, t.capture!);
    expect(readdirSync(dir).sort()).toEqual(["coverage.json", "manifest.json", "scrubbed"]);
  });

  it("re-checks without sending when the app has not changed", async () => {
    const t = await recordOnce(paths, config, remote, opts);
    expect(t).toMatchObject({ state: "unchanged", uploaded: [] });
    expect(listCaptures(paths)).toHaveLength(1); // the check's own recording is not kept
    await server.idle();
    expect(listCaptures(serverPaths)).toHaveLength(1);
    const status = await fetch(`${server.url}/status`, { headers: { authorization: `Bearer ${remote.token}` } });
    expect(await status.json()).toMatchObject({ app: "tiny-clinic", captures: 1, recorder: { state: "unchanged" } });
  });

  it("sends a new recording when the app changes, and only the changed endpoints are rebuilt", async () => {
    clinic.setVariant("v2");
    const t = await recordOnce(paths, config, remote, opts);
    expect(t.state).toBe("drift");
    expect(t.uploaded).toEqual([t.capture]);
    await server.idle();

    expect(listCaptures(serverPaths)).toHaveLength(2);
    expect(readJson<Manifest>(join(serverPaths.captures, t.capture!, "manifest.json")).mode).toBe("script");
    expect(jobs[1]).toMatchObject({ kind: "drift", built: true, costUsd: 1.5 });
    // The renamed button's page and the notes API whose fields changed: some endpoints, not all of them.
    const all = readJson<Cluster[]>(join(serverPaths.analysis, "clusters.json"));
    const changed = all.filter((c) => builds[1]!.clusters!.includes(c.id));
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.length).toBeLessThan(all.filter((c) => c.class === "read" || c.class === "write").length);
    expect(changed.some((c) => c.pathTemplate.includes("notes"))).toBe(true);
    expect(builds[1]).toMatchObject({ maxUsd: 5, resume: true, maxCycles: 4 });

    // The new recording is now the baseline here too, so the same change is not sent twice.
    const again = await recordOnce(paths, config, remote, opts);
    expect(again).toMatchObject({ state: "unchanged", uploaded: [] });
  });

  it("stops building once the app's cap is spent", async () => {
    writeJson(join(serverPaths.build, "state.json"), {
      startedAt: "",
      updatedAt: "",
      costUsd: 4.99,
      cycles: 2,
      steps: {},
    });
    clinic.setVariant("v1");
    const t = await recordOnce(paths, config, remote, opts);
    expect(t.state).toBe("drift");
    await server.idle();
    expect(builds).toHaveLength(2);
    expect(jobs[2]).toMatchObject({ built: false, costUsd: 0 });
    expect(jobs[2]!.note).toMatch(/cap for this app is spent/);
  });

  it("tells the receiver when the login has expired, and sends nothing", async () => {
    clinic.dropSessions();
    const t = await recordOnce(paths, config, remote, opts);
    expect(t).toMatchObject({ state: "session-expired", uploaded: [] });
    const status = await fetch(`${server.url}/status`, { headers: { authorization: `Bearer ${remote.token}` } });
    expect(await status.json()).toMatchObject({ recorder: { state: "session-expired" } });
  });

  it("takes a recording only with a token, and only for the app the token is for", async () => {
    const id = listCaptures(paths)[0]!;
    const post = (token: string) =>
      fetch(`${server.url}/recordings`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: Readable.toWeb(packStream(packEntries(paths, id))) as unknown as BodyInit,
        duplex: "half",
      } as RequestInit);

    expect((await fetch(`${server.url}/health`)).status).toBe(200);
    expect((await fetch(`${server.url}/app`)).status).toBe(401);
    expect((await post("not-the-token")).status).toBe(401);

    // Another app on the same receiver: its token cannot file a recording of the clinic.
    const other = enrollApp("https://other.test/", { cwd: serverCwd, app: "other" });
    const info = await fetch(`${server.url}/app`, { headers: { authorization: `Bearer ${other.token}` } });
    expect(await info.json()).toMatchObject({ app: "other", origins: ["https://other.test"] });
    const refused = await post(other.token);
    expect(refused.status).toBe(422);
    expect(listCaptures(other.paths)).toEqual([]);
    expect(existsSync(join(other.paths.root, "incoming")) && readdirSync(join(other.paths.root, "incoming"))).toEqual(
      [],
    );

    // The same recording sent twice is filed once.
    const twice = await post(remote.token);
    expect(twice.status).toBe(200);
    expect(await twice.json()).toMatchObject({ id, already: true });
    // The receiver keeps only the hash of a token.
    expect(readFileSync(join(serverPaths.root, "upload-token.sha256"), "utf8")).not.toContain(remote.token);
  });

  it("sends only over https, or to this machine", () => {
    expect(checkServer("https://niko.example.com/")).toBe("https://niko.example.com");
    expect(checkServer("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(() => checkServer("http://niko.example.com")).toThrow(/https/);
    expect(() => checkServer("niko.example.com")).toThrow(/Not an address/);
  });
});

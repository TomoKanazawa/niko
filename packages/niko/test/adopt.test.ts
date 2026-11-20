import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Cookie,
  adoptCookies,
  cookiesForApp,
  importSession,
  parseCookies,
  probeSession,
  probeUrl,
  serveAdopt,
} from "../src/adopt/index.js";
import { analyze } from "../src/analyze/index.js";
import { SessionExpired, drift } from "../src/drift/index.js";
import { type Clinic, captureClinic, startClinic } from "./helpers.js";

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

describe("parseCookies", () => {
  it("reads a browser's JSON export, a {cookies} wrapper and a Netscape file alike", () => {
    const one = { name: "sid", value: "abc", domain: "app.test", path: "/", httpOnly: true, secure: true };
    const fromArray = parseCookies(JSON.stringify([one]));
    const fromWrapper = parseCookies(JSON.stringify({ cookies: [one] }));
    const fromNetscape = parseCookies("#HttpOnly_app.test\tTRUE\t/\tTRUE\t0\tsid\tabc");
    for (const c of [fromArray[0], fromWrapper[0], fromNetscape[0]]) {
      expect(c).toMatchObject({ name: "sid", value: "abc", domain: "app.test", httpOnly: true });
      expect(c!.expires).toBe(-1); // no expiry given -> a session cookie
    }
  });

  it("maps an expiry and leaves a dotted domain alone", () => {
    const [c] = parseCookies(
      JSON.stringify([{ name: "t", value: "1", domain: ".app.test", expirationDate: 2000000000 }]),
    );
    expect(c).toMatchObject({ domain: ".app.test", expires: 2000000000 });
  });
});

describe("cookiesForApp", () => {
  const config = { app: "x", origins: ["https://app.test"] } as never;
  it("keeps the app's cookies and drops the rest", () => {
    const kept = cookiesForApp(
      [
        { name: "a", value: "1", domain: "app.test", path: "/", expires: -1, httpOnly: true, secure: true },
        { name: "b", value: "2", domain: "evil.test", path: "/", expires: -1, httpOnly: true, secure: true },
        { name: "c", value: "3", domain: ".app.test", path: "/", expires: -1, httpOnly: true, secure: true },
      ],
      config,
    );
    expect(kept.kept.map((c) => c.name).sort()).toEqual(["a", "c"]);
    expect(kept.dropped).toBe(1);
  });
});

describe("adopt against the live clinic", () => {
  let clinic: Clinic;
  let ctx: Awaited<ReturnType<typeof captureClinic>>;

  beforeAll(async () => {
    clinic = await startClinic();
    ctx = await captureClinic(clinic);
    analyze(ctx.paths, ctx.config);
  });
  afterAll(() => clinic.close());

  it("picks a logged-in read page to probe, not the login screen", () => {
    const url = probeUrl(ctx.paths, ctx.config);
    expect(url).toBeDefined();
    expect(url).not.toMatch(/login/i);
  });

  it("calls a fresh session live and an expired one dead", async () => {
    const url = probeUrl(ctx.paths, ctx.config)!;
    const live = await freshSession(clinic);
    expect((await probeSession(url, [live])).live).toBe(true);
    const dead = { ...live, value: "not-a-real-sid" };
    expect((await probeSession(url, [dead])).live).toBe(false);
  });

  it("writes the store read-only to its owner and merges by name", () => {
    const file = join(ctx.paths.root, "session-cookies.json");
    importSession(ctx.paths, [
      { name: "sid", value: "one", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false },
    ]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    importSession(ctx.paths, [
      { name: "sid", value: "two", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false },
    ]);
    const saved: Cookie[] = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.filter((c) => c.name === "sid")).toHaveLength(1);
    expect(saved.find((c) => c.name === "sid")!.value).toBe("two");
  });

  it("recovers drift after the saved login expires: no re-login here, just a fresh session", async () => {
    // The saved login dies.
    clinic.dropSessions();
    await expect(drift(ctx.paths, ctx.config, { headless: true, bundledBrowser: true })).rejects.toBeInstanceOf(
      SessionExpired,
    );
    // A person logs into the app in their own browser; we take that session in.
    const live = await freshSession(clinic);
    const r = await adoptCookies(ctx.paths, ctx.config, [live]);
    expect(r.kept).toBe(1);
    expect(r.probe?.live).toBe(true);
    // Drift now runs with the adopted session and does not ask anyone to log in here.
    const report = await drift(ctx.paths, ctx.config, { headless: true, bundledBrowser: true });
    expect(report.probed).toBeGreaterThan(0);
  });
});

describe("adopt receiver", () => {
  let clinic: Clinic;
  let ctx: Awaited<ReturnType<typeof captureClinic>>;

  beforeAll(async () => {
    clinic = await startClinic();
    ctx = await captureClinic(clinic);
    analyze(ctx.paths, ctx.config);
  });
  afterAll(() => clinic.close());

  it("takes a pushed session only with the right token, for the app's host only", async () => {
    const h = await serveAdopt(ctx.paths, ctx.config, { port: 0 });
    try {
      const live = await freshSession(clinic);
      const post = (token: string, body: unknown) =>
        fetch(`${h.url}/session`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });

      expect((await fetch(`${h.url}/health`)).status).toBe(200);
      expect((await post("wrong-token", [live])).status).toBe(401);

      const foreign = { ...live, domain: "evil.test" };
      expect((await post(h.token, [foreign])).status).toBe(422);

      const ok = await post(h.token, [live]);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ kept: 1, live: true });
    } finally {
      await h.close();
    }
  });
});

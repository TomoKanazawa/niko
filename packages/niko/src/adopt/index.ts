import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { type Ex, loadAnalysis } from "../analyze/index.js";
import type { AppConfig } from "../types.js";
import { type AppPaths, ensureDir, log } from "../util.js";

/** A cookie in the shape Playwright's `addCookies` wants, which is what the capture restore reads. */
export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number; // seconds since epoch, or -1 for a session cookie
  httpOnly: boolean;
  secure: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

const LOGIN_RE = /(^|[/_.-])(login|signin|sign-in|sso|authenticate|auth)([/_.-]|$)/i;

/** A host is covered by a cookie domain: an exact match, or a parent of a dotted domain. */
function domainCovers(cookieDomain: string, host: string): boolean {
  const d = cookieDomain.replace(/^\./, "").toLowerCase();
  const h = host.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

function normSameSite(v: unknown): Cookie["sameSite"] {
  const s = String(v ?? "").toLowerCase();
  if (s === "strict") return "Strict";
  if (s === "lax") return "Lax";
  if (s === "none" || s === "no_restriction") return "None";
  return undefined;
}

/**
 * Read cookies out of whatever a browser's export gave us. Accepts a JSON array,
 * a `{ "cookies": [...] }` wrapper, or a Netscape `cookies.txt`. Browser-neutral on purpose:
 * the human exports from Firefox, Safari, Edge or Chrome, we only read the result.
 */
export function parseCookies(text: string): Cookie[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const data = JSON.parse(trimmed);
    const list: Record<string, unknown>[] = Array.isArray(data)
      ? data
      : Array.isArray((data as { cookies?: unknown }).cookies)
        ? (data as { cookies: Record<string, unknown>[] }).cookies
        : [];
    return list.map(oneJsonCookie).filter((c): c is Cookie => c !== null);
  }
  return parseNetscape(trimmed);
}

function oneJsonCookie(c: Record<string, unknown>): Cookie | null {
  const name = c.name as string;
  const domain = (c.domain as string) ?? "";
  if (!name || !domain) return null;
  const session = c.session === true || (c.expires === undefined && c.expirationDate === undefined);
  const rawExp = (c.expires ?? c.expirationDate) as number | undefined;
  return {
    name,
    value: String(c.value ?? ""),
    domain,
    path: (c.path as string) || "/",
    expires: session || rawExp === undefined || rawExp < 0 ? -1 : Math.floor(rawExp),
    httpOnly: !!(c.httpOnly ?? c.httponly),
    secure: !!c.secure,
    sameSite: normSameSite(c.sameSite),
  };
}

function parseNetscape(text: string): Cookie[] {
  const out: Cookie[] = [];
  for (const line of text.split("\n")) {
    const l = line.startsWith("#HttpOnly_") ? line.slice("#HttpOnly_".length) : line;
    if (!l.trim() || l.startsWith("#")) continue;
    const f = l.split("\t");
    if (f.length < 7) continue;
    const exp = Number(f[4]);
    out.push({
      name: f[5]!,
      value: f[6]!.replace(/\r$/, ""),
      domain: f[0]!,
      path: f[2] || "/",
      expires: exp > 0 ? exp : -1,
      httpOnly: line.startsWith("#HttpOnly_"),
      secure: f[3]!.toUpperCase() === "TRUE",
    });
  }
  return out;
}

/** Keep only cookies that belong to the app's own origins; report how many were dropped. */
export function cookiesForApp(cookies: Cookie[], config: AppConfig): { kept: Cookie[]; dropped: number } {
  const hosts = config.origins.map((o) => new URL(o).hostname);
  const kept = cookies.filter((c) => hosts.some((h) => domainCovers(c.domain, h)));
  return { kept, dropped: cookies.length - kept.length };
}

/** Merge a fresh session into the store the capture/drift restore already reads. Secrets never logged. */
export function importSession(paths: AppPaths, cookies: Cookie[]): void {
  const file = join(paths.root, "session-cookies.json");
  const prior: Cookie[] = existsSync(file) ? safeRead(file) : [];
  const byKey = new Map(prior.map((c) => [`${c.name}\t${c.domain}\t${c.path}`, c]));
  for (const c of cookies) byKey.set(`${c.name}\t${c.domain}\t${c.path}`, c);
  writeFileSync(file, JSON.stringify([...byKey.values()]), { mode: 0o600 });
}

function safeRead(file: string): Cookie[] {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

/** A recorded, logged-in page to test a session against: a read HTML page that is not the login screen. */
export function probeUrl(paths: AppPaths, config: AppConfig): string | undefined {
  let analysis: ReturnType<typeof loadAnalysis>;
  try {
    analysis = loadAnalysis(paths, config);
  } catch {
    return undefined;
  }
  const classOf = new Map(analysis.clusters.map((c) => [c.id, c]));
  const reads = analysis.corpus.exchanges.filter(
    (x: Ex) =>
      x.inScope &&
      x.method === "GET" &&
      x.status === 200 &&
      classOf.get(x.cluster ?? "")?.class === "read" &&
      !LOGIN_RE.test(new URL(x.url).pathname),
  );
  const doc = reads.find((x) => x.resourceType === "document") ?? reads[0];
  return doc?.url;
}

/** Hit a logged-in page with the cookies and see whether the app still treats us as signed in. */
export async function probeSession(url: string, cookies: Cookie[]): Promise<{ live: boolean; reason: string }> {
  const host = new URL(url).hostname;
  const header = cookies
    .filter((c) => domainCovers(c.domain, host))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  if (!header) return { live: false, reason: "no cookies for the app's host" };
  let res: Response;
  try {
    res = await fetch(url, { headers: { cookie: header }, redirect: "manual" });
  } catch (e) {
    return { live: false, reason: `could not reach the app (${(e as Error).message})` };
  }
  if (res.status === 401 || res.status === 403) return { live: false, reason: `app answered ${res.status}` };
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location") ?? "";
    if (LOGIN_RE.test(loc)) return { live: false, reason: "app redirected to the login page" };
  }
  if (res.status >= 200 && res.status < 300) return { live: true, reason: "app served a logged-in page" };
  return { live: false, reason: `app answered ${res.status}` };
}

export interface AdoptResult {
  kept: number;
  dropped: number;
  probe?: { live: boolean; reason: string };
}

/** Take a fresh human session into the store, then check it is really logged in. No credentials touched. */
export async function adoptCookies(
  paths: AppPaths,
  config: AppConfig,
  cookies: Cookie[],
  opts: { probe?: boolean } = {},
): Promise<AdoptResult> {
  const { kept, dropped } = cookiesForApp(cookies, config);
  if (!kept.length) return { kept: 0, dropped };
  importSession(paths, kept);
  if (opts.probe === false) return { kept: kept.length, dropped };
  const url = probeUrl(paths, config);
  const probe = url ? await probeSession(url, kept) : undefined;
  return { kept: kept.length, dropped, probe };
}

/** A token the receiver checks, so only something the user ran can push a session in. */
export function loadOrCreateToken(paths: AppPaths): string {
  ensureDir(paths.run);
  const file = join(paths.run, "adopt-token");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const token = randomBytes(24).toString("base64url");
  writeFileSync(file, token, { mode: 0o600 });
  return token;
}

export interface ServeHandle {
  url: string;
  token: string;
  close: () => Promise<void>;
}

/**
 * A localhost-only receiver. Whenever the human logs in during their day, their browser (or a cookie
 * exporter, or curl) POSTs the session here and it lands in the store. Bound to the loopback address and
 * gated by a bearer token; it never handles a password.
 */
export async function serveAdopt(
  paths: AppPaths,
  config: AppConfig,
  opts: { port?: number; token?: string; onAdopt?: (r: AdoptResult) => void } = {},
): Promise<ServeHandle> {
  const token = opts.token ?? loadOrCreateToken(paths);
  const server = createServer((req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/health") return reply(200, { ok: true, app: config.app });
    if (req.method !== "POST" || req.url !== "/session") return reply(404, { error: "POST /session" });
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${token}`) return reply(401, { error: "bad or missing token" });
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 2_000_000) req.destroy();
    });
    req.on("end", async () => {
      let cookies: Cookie[];
      try {
        cookies = parseCookies(raw);
      } catch {
        return reply(400, { error: "body is not cookies JSON" });
      }
      try {
        const r = await adoptCookies(paths, config, cookies);
        opts.onAdopt?.(r);
        if (!r.kept) return reply(422, { error: "no cookies matched the app's host", dropped: r.dropped });
        log(`Adopted a session: ${r.kept} cookies${r.probe ? ` (${r.probe.reason})` : ""}.`);
        reply(200, { kept: r.kept, dropped: r.dropped, live: r.probe?.live ?? null, reason: r.probe?.reason });
      } catch (e) {
        reply(500, { error: (e as Error).message });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 8899, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : (opts.port ?? 8899);
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

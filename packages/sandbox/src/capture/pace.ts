import type { BrowserContext, Response } from "playwright";

/** Request kinds that reach the app's server code. Assets (scripts, styles, images) are cached and not paced. */
export const PACED_TYPES = new Set(["document", "xhr", "fetch", "eventsource", "other"]);

/** Lets at most one paced request start per interval. */
export class Pacer {
  private next = 0;
  constructor(readonly intervalMs: number) {}
  async wait() {
    if (this.intervalMs <= 0) return;
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.intervalMs;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }
}

/** What the site's robots.txt asks of all user agents: a Crawl-delay in seconds, and paths not to fetch. */
export interface RobotsRules {
  delay?: number;
  disallow: string[];
}

export async function robotsRules(context: BrowserContext, origin: string): Promise<RobotsRules> {
  const rules: RobotsRules = { disallow: [] };
  try {
    const res = await context.request.get(`${origin}/robots.txt`, { timeout: 10_000, maxRedirects: 2 });
    if (!res.ok()) return rules;
    let forAll = false;
    let inAgents = false;
    for (const raw of (await res.text()).split(/\r?\n/)) {
      const line = raw.replace(/#.*/, "").trim();
      const m = /^([\w-]+)\s*:\s*(.*)$/.exec(line);
      if (!m) continue;
      const [field, value] = [m[1]!.toLowerCase(), m[2]!.trim()];
      if (field === "user-agent") {
        // Consecutive user-agent lines form one group.
        if (!inAgents) forAll = false;
        inAgents = true;
        if (value === "*") forAll = true;
        continue;
      }
      inAgents = false;
      if (!forAll) continue;
      if (field === "crawl-delay") {
        const n = Number.parseFloat(value);
        if (Number.isFinite(n) && n >= 0) rules.delay = n;
      } else if (field === "disallow" && value) rules.disallow.push(value);
    }
  } catch {}
  return rules;
}

/** robots.txt path matching: a prefix of path + query, with `*` for any characters and `$` for the end. */
export function disallowedBy(rules: RobotsRules, url: string): string | undefined {
  const u = new URL(url);
  const target = u.pathname + u.search;
  return rules.disallow.find((rule) => {
    const re = new RegExp(
      `^${rule
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\\\$$/, "$")}`,
    );
    return re.test(target);
  });
}

const SLOW_DOWN_RE = /too many requests|too quickly|rate limit(ed)?|slow down|unusual traffic/i;

/**
 * Watches the live app's answers for a request to slow down: HTTP 429 or 503, or a short page that says so.
 * Once seen, `reason` is set and the crawl stops.
 */
export class RateWatch {
  reason?: string;
  constructor(
    private origins: string[],
    private readBodies: boolean,
  ) {}
  attach(context: BrowserContext) {
    context.on("response", (res) => void this.check(res));
  }
  private async check(res: Response) {
    if (this.reason) return;
    const req = res.request();
    let origin = "";
    try {
      origin = new URL(res.url()).origin;
    } catch {
      return;
    }
    if (!this.origins.includes(origin) || !PACED_TYPES.has(req.resourceType())) return;
    const status = res.status();
    if (status === 429 || status === 503) {
      this.reason = `the app answered HTTP ${status} to ${new URL(res.url()).pathname}`;
      return;
    }
    if (!this.readBodies || req.resourceType() !== "document" || status !== 200) return;
    const length = Number(res.headers()["content-length"] ?? "0");
    if (length > 4000) return;
    const text = await res.text().catch(() => "");
    if (text.length < 4000 && SLOW_DOWN_RE.test(text))
      this.reason = `the app said to slow down on ${new URL(res.url()).pathname}`;
  }
}

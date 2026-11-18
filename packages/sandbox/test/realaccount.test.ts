import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error plain JS fixture
import { startTinyNews } from "../../../fixtures/tiny-news/server.mjs";
import { analyze } from "../src/analyze/index.js";
import { judgeClick, judgeRequest } from "../src/capture/gate.js";
import { capture, forgetSession, launchBrowser } from "../src/capture/index.js";
import { disallowedBy } from "../src/capture/pace.js";
import { initApp } from "../src/init.js";
import { readEvents } from "../src/util.js";

interface News {
  url: string;
  changes(): number;
  sessionCount(): number;
  state(): Record<string, unknown>;
  authToken(user?: string): string;
  setRateLimit(n: number): void;
  pageTimes(): number[];
  close(): Promise<void>;
}

/** What `sandbox init --real-account` does: a new app, then the person logs in in the tool's own window. */
async function setUp(news: News) {
  const cwd = mkdtempSync(join(tmpdir(), "sbx-news-"));
  const { paths, config } = initApp(`${news.url}/news`, { cwd, app: "tiny-news", realAccount: true });
  const context = await launchBrowser(paths, { headless: true, bundledBrowser: true });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`${news.url}/login?goto=news`);
  await page.fill("input[name=acct]", "tester");
  await page.fill("input[name=pw]", "test-password");
  await page.click("input[type=submit]");
  await page.waitForURL("**/news");
  await context.close();
  return { cwd, paths, config };
}

/** Every file under a folder, as text. */
function allText(dir: string): string {
  let out = "";
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    out += statSync(p).isDirectory() ? allText(p) : readFileSync(p, "latin1");
  }
  return out;
}

describe("gates in real-account mode", () => {
  const req = (method: string, url: string, resourceType = "document") => ({
    method,
    url,
    contentType: "",
    body: "",
    resourceType,
  });
  it("refuses GET links that act on the account", () => {
    expect(judgeRequest(req("GET", "http://x/vote?id=1&how=up&auth=abc&goto=news"), "k", {}).allow).toBe(false);
    expect(judgeRequest(req("GET", "http://x/fave?id=1"), "k", {}).allow).toBe(false);
    expect(judgeRequest(req("GET", "http://x/item?id=1&auth=abc"), "k", {}, { strict: true }).allow).toBe(false);
    expect(judgeRequest(req("GET", "http://x/item?id=1&auth=abc"), "k", {}).allow).toBe(true);
    expect(judgeRequest(req("GET", "http://x/item?id=1"), "k", {}, { strict: true }).allow).toBe(true);
    expect(judgeRequest(req("GET", "http://x/reports/2"), "k", {}, { strict: true }).allow).toBe(true);
    expect(judgeRequest(req("GET", "http://x/report?id=2"), "k", {}, { strict: true }).allow).toBe(false);
    expect(judgeRequest(req("GET", "http://x/s.gif", "image"), "k", {}, { strict: true }).allow).toBe(true);
    expect(judgeRequest(req("GET", "http://x/px?u=1", "image"), "k", {}, { strict: true }).allow).toBe(false);
    expect(
      judgeRequest(
        req("GET", "http://x/item?id=1&auth=a"),
        "k",
        { k: { decision: "read", by: "user" } },
        { strict: true },
      ).allow,
    ).toBe(true);
  });
  it("matches robots.txt Disallow rules", () => {
    const rules = { disallow: ["/vote?", "/login", "/x*y$"] };
    expect(disallowedBy(rules, "http://x/vote?id=1")).toBe("/vote?");
    expect(disallowedBy(rules, "http://x/login?goto=news")).toBe("/login");
    expect(disallowedBy(rules, "http://x/xaay")).toBe("/x*y$");
    expect(disallowedBy(rules, "http://x/xaayz")).toBeUndefined();
    expect(disallowedBy(rules, "http://x/item?id=1")).toBeUndefined();
  });
  it("refuses controls that act on the account", () => {
    expect(judgeClick({ tag: "a", name: "upvote", href: "http://x/vote?id=1&how=up&auth=a" })).toBeTruthy();
    expect(judgeClick({ tag: "a", name: "favorite", href: "http://x/fave?id=1&auth=a" })).toBeTruthy();
    expect(judgeClick({ tag: "a", name: "hide", href: "http://x/hide?id=1&auth=a" })).toBeTruthy();
    expect(judgeClick({ tag: "a", name: "12 comments", href: "http://x/item?id=1" })).toBeNull();
    expect(judgeClick({ tag: "a", name: "past", href: "http://x/front?day=1&auth=a" }, { strict: true })).toBeTruthy();
    expect(judgeClick({ tag: "a", name: "past", href: "http://x/front?day=1&auth=a" })).toBeNull();
  });
});

describe("unattended crawl of tiny-news with a real-account login", () => {
  let news: News;
  let ctx: Awaited<ReturnType<typeof setUp>>;
  let id: string;
  let started: number;

  beforeAll(async () => {
    news = await startTinyNews(0);
    ctx = await setUp(news);
    started = Date.now();
    id = await capture(ctx.paths, ctx.config, {
      mode: "explore",
      headless: true,
      bundledBrowser: true,
      maxActions: 40,
    });
  }, 120_000);
  afterAll(() => news.close());

  it("changes nothing and stays logged in", () => {
    expect(news.changes()).toBe(0);
    expect(news.sessionCount()).toBe(1);
  });

  it("reaches the reading pages", () => {
    const a = analyze(ctx.paths, ctx.config);
    const paths = a.clusters.filter((c) => !c.blocked).map((c) => `${c.method} ${c.pathTemplate}`);
    for (const p of ["GET /news", "GET /item", "GET /user", "GET /newest", "GET /submit"]) expect(paths).toContain(p);
    for (const p of ["GET /vote", "GET /hide", "GET /fave", "GET /logout", "POST /comment"])
      expect(paths).not.toContain(p);
  });

  it("lists what it refused in the coverage report", () => {
    const coverage = JSON.parse(readFileSync(join(ctx.paths.captures, id, "coverage.json"), "utf8")) as {
      link: string;
      outcome: string;
    }[];
    expect(coverage.find((c) => c.link.startsWith("/vote"))?.outcome).toBe("refused");
    expect(coverage.find((c) => c.link === "/item?id")?.outcome).toBe("opened");
    expect(coverage.find((c) => c.link.startsWith("/reply"))?.reason).toMatch(/robots/);
  });

  it("paces page loads by the site's robots.txt Crawl-delay", () => {
    const times = news.pageTimes().filter((t) => t >= started);
    const gaps = times.slice(1).map((t, i) => t - times[i]!);
    expect(times.length).toBeGreaterThan(5);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(150);
  });

  it("keeps the account's token out of the scrubbed copy", () => {
    const token = news.authToken();
    expect(allText(join(ctx.paths.captures, id, "scrubbed"))).not.toContain(token);
    expect(
      readFileSync(join(ctx.paths.captures, id, "bodies", readdirSync(join(ctx.paths.captures, id, "bodies"))[0]!)),
    ).toBeTruthy();
  });

  it("refuses --allow-writes", async () => {
    await expect(
      capture(ctx.paths, ctx.config, { mode: "explore", headless: true, bundledBrowser: true, allowWrites: true }),
    ).rejects.toThrow(/real account/);
  });
});

describe("a person or a script on a real account", () => {
  let news: News;
  let ctx: Awaited<ReturnType<typeof setUp>>;
  let noticeShown = false;
  let stayedOnPage = false;

  beforeAll(async () => {
    news = await startTinyNews(0);
    ctx = await setUp(news);
    await capture(ctx.paths, ctx.config, {
      mode: "script",
      headless: true,
      bundledBrowser: true,
      delaySeconds: 0,
      script: async (page) => {
        await page.click("#up_14"); // JavaScript sends an image ping with the token
        await page.waitForTimeout(300);
        await page.click("text=hide >> nth=0"); // a plain link that would hide the story
        await page.waitForTimeout(300);
        stayedOnPage = new URL(page.url()).pathname === "/news";
        noticeShown = await page.locator("#sbx-blocked-notice").isVisible();
        await page.goto(`${news.url}/item?id=11`);
        await page.fill("textarea[name=text]", "This must never be posted.");
        await page.click("input[value='add comment']");
        await page.waitForTimeout(300);
        await page.click("text=favorite");
        await page.waitForTimeout(300);
        await page.click("#logout");
        await page.waitForTimeout(300);
      },
    });
  }, 120_000);
  afterAll(() => news.close());

  it("sends none of the changes and stays logged in", () => {
    expect(news.changes()).toBe(0);
    expect(news.state()).toMatchObject({ votes: [], hidden: [], faves: [], comments: 3 });
    expect(news.sessionCount()).toBe(1);
  });

  it("tells the person in the page and leaves them where they were", () => {
    expect(stayedOnPage).toBe(true);
    expect(noticeShown).toBe(true);
  });

  it("keeps the stopped requests as endpoints for the builder to infer", () => {
    analyze(ctx.paths, ctx.config);
    const blocked = JSON.parse(readFileSync(join(ctx.paths.analysis, "blocked.json"), "utf8")) as {
      key: string;
      examples: { pageUrl?: string; body: string }[];
    }[];
    const keys = blocked.map((b) => b.key);
    expect(keys.some((k) => k.startsWith("POST") && k.includes("/comment"))).toBe(true);
    expect(keys.some((k) => k.includes("/vote"))).toBe(true);
    expect(keys.some((k) => k.includes("/hide"))).toBe(true);
    const comment = blocked.find((b) => b.key.includes("/comment"))!;
    expect(comment.examples[0]!.body).toContain("must+never+be+posted");
    // The comment form's signed field was scrubbed.
    expect(comment.examples[0]!.body).toMatch(/hmac=SBX_/);
  });

  it("forget deletes the saved login", () => {
    expect(forgetSession(ctx.paths)).toBe(true);
    expect(existsSync(ctx.paths.profile)).toBe(false);
    expect(existsSync(join(ctx.paths.root, "session-cookies.json"))).toBe(false);
  });
});

describe("a site that asks to slow down", () => {
  it("stops the crawl and says why", async () => {
    const news: News = await startTinyNews(0);
    const ctx = await setUp(news);
    news.setRateLimit(1);
    const id = await capture(ctx.paths, ctx.config, {
      mode: "explore",
      headless: true,
      bundledBrowser: true,
      delaySeconds: 0,
      maxActions: 40,
    });
    await news.close();
    expect(news.changes()).toBe(0);
    const notes = readEvents(join(ctx.paths.captures, id)).filter((e) => e.type === "gate");
    expect(notes.some((n) => n.type === "gate" && /slow down|HTTP 503/.test(n.text))).toBe(true);
  }, 120_000);
});

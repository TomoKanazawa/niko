import type { Page } from "playwright";
import { templatePath } from "../analyze/cluster.js";
import { log, sha256 } from "../util.js";
import { type ControlInfo, judgeClick } from "./gate.js";
import { CONTROLS_SCRIPT } from "./pagescript.js";
import type { Recorder } from "./recorder.js";

type Control = ControlInfo & { ref: number };

/** A screen is the same state when only its data differs: URL template + page skeleton with text and numbers masked. */
async function stateKey(page: Page): Promise<string> {
  const u = new URL(page.url());
  let aria = "";
  try {
    aria = await page.locator("body").ariaSnapshot({ timeout: 3000 });
  } catch {}
  const skeleton = aria
    .split("\n")
    .map((l) =>
      l
        .replace(/"[^"]*"/g, '""')
        .replace(/:\s.*$/, ":")
        .replace(/\d+/g, "0"),
    )
    .filter((l, i, a) => l !== a[i - 1])
    .join("\n");
  return sha256(`${u.origin}${templatePath(u.pathname).template}\n${skeleton}`).slice(0, 16);
}

/** One line of the coverage report: a kind of link the crawl saw, and what became of it. */
export interface CoverageEntry {
  /** Path template plus the names of the query parameters, e.g. /item?id */
  link: string;
  example: string;
  outcome: "opened" | "refused" | "not reached";
  reason?: string;
}

const linkTemplate = (href: string) => {
  const u = new URL(href);
  const names = [...new Set(u.searchParams.keys())].sort();
  return `${templatePath(u.pathname).template}${names.length ? `?${names.join("&")}` : ""}`;
};

const controlKey = (c: Control) =>
  `${c.tag}|${c.name.replace(/\d+/g, "0")}|${c.href ? templatePath(new URL(c.href).pathname).template : ""}`;

/**
 * Breadth-first exploration with no model: try each safe control once per state, return to the state by URL.
 * The UI gate refuses commit controls; the network gate (set up by the caller) stops unknown writes.
 */
export async function explore(
  page: Page,
  recorder: Recorder,
  opts: {
    origins: string[];
    maxActions: number;
    allowWrites: boolean;
    strict?: boolean;
    perState?: number;
    /** Checked before each action: true stops the crawl (the app asked to slow down). */
    shouldStop?: () => boolean;
    /** Extra reason to refuse a link, such as the site's robots.txt. */
    refuseLink?: (href: string) => string | undefined;
  },
) {
  const perState = opts.perState ?? 25;
  const visited = new Map<string, { url: string; tried: Set<string> }>();
  const queue: string[] = [];
  const refused = new Map<string, string>();
  const links = new Map<string, CoverageEntry>();
  const firstControl = new Map<string, Control>();
  const seeLink = (href: string, control?: Control) => {
    try {
      const link = linkTemplate(href);
      if (!links.has(link)) links.set(link, { link, example: href, outcome: "not reached" });
      if (control && !firstControl.has(link)) firstControl.set(link, control);
      return links.get(link)!;
    } catch {
      return undefined;
    }
  };
  let actions = 0;
  let sinceNew = 0;
  const stopped = () => opts.shouldStop?.() === true;

  const enter = async () => {
    const key = await stateKey(page);
    if (!visited.has(key)) {
      visited.set(key, { url: page.url(), tried: new Set() });
      queue.push(key);
      sinceNew = 0;
      // List the new screen's links now, so the report shows what the crawl saw but never got to.
      try {
        for (const c of (await page.evaluate(CONTROLS_SCRIPT)) as Control[])
          if (c.href && opts.origins.includes(new URL(c.href).origin)) seeLink(c.href, c);
      } catch {}
    }
    return key;
  };
  await enter();

  while (queue.length && actions < opts.maxActions && sinceNew < 100 && !stopped()) {
    const key = queue.shift()!;
    const state = visited.get(key)!;
    let patternCount = new Map<string, number>();
    for (let n = 0; n < perState && actions < opts.maxActions && !stopped(); n++) {
      if ((await stateKey(page)) !== key) {
        try {
          await page.goto(state.url, { waitUntil: "domcontentloaded" });
          await recorder.settle();
        } catch {
          break;
        }
      }
      let controls: Control[] = [];
      try {
        controls = (await page.evaluate(CONTROLS_SCRIPT)) as Control[];
      } catch {
        break;
      }
      patternCount = new Map();
      const next = controls.find((c) => {
        const ck = controlKey(c);
        // In repeated lists, open only the first two rows of each pattern.
        const seen = patternCount.get(ck) ?? 0;
        patternCount.set(ck, seen + 1);
        if (state.tried.has(`${ck}#${c.name}`)) return false;
        if (seen >= 2) {
          state.tried.add(`${ck}#${c.name}`);
          return false;
        }
        if (c.href) {
          try {
            if (!opts.origins.includes(new URL(c.href).origin)) return false;
          } catch {
            return false;
          }
        }
        const entry = c.href ? seeLink(c.href) : undefined;
        const why =
          judgeClick(c, { allowWrites: opts.allowWrites, strict: opts.strict }) ??
          (c.href ? (opts.refuseLink?.(c.href) ?? null) : null);
        if (why) {
          if (entry && entry.outcome === "not reached") Object.assign(entry, { outcome: "refused", reason: why });
          state.tried.add(`${ck}#${c.name}`);
          if (!refused.has(c.name)) {
            refused.set(c.name, why);
            recorder.note("gate", `refused control "${c.name}" (${why})`);
          }
          return false;
        }
        return true;
      });
      if (!next) break;
      state.tried.add(`${controlKey(next)}#${next.name}`);
      if (next.href) {
        const entry = seeLink(next.href);
        if (entry) entry.outcome = "opened";
      }
      actions++;
      sinceNew++;
      try {
        await page.locator(`[data-sbx="${next.ref}"]`).first().click({ timeout: 4000 });
      } catch {
        continue;
      }
      await recorder.settle();
      await new Promise((r) => setTimeout(r, 150));
      if (!opts.origins.includes(new URL(page.url()).origin)) {
        await page.goBack().catch(() => {});
        continue;
      }
      await enter();
    }
  }
  // A link the crawl never got to may still be one it would refuse: say so rather than "not reached".
  for (const [link, entry] of links) {
    const c = firstControl.get(link);
    if (entry.outcome !== "not reached" || !c?.href) continue;
    const why =
      judgeClick(c, { allowWrites: opts.allowWrites, strict: opts.strict }) ?? opts.refuseLink?.(c.href) ?? null;
    if (why) Object.assign(entry, { outcome: "refused", reason: why });
  }
  const coverage = [...links.values()].sort((a, b) => a.link.localeCompare(b.link));
  const count = (o: CoverageEntry["outcome"]) => coverage.filter((c) => c.outcome === o).length;
  log(
    `Explored ${visited.size} states with ${actions} actions; refused ${refused.size} controls. ` +
      `Links: ${count("opened")} kinds opened, ${count("refused")} refused, ${count("not reached")} not reached (see coverage.json).`,
  );
  return { states: visited.size, actions, refused: [...refused.entries()], coverage };
}

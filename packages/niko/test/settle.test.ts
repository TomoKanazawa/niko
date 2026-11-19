import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type BrowserContext, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Recorder } from "../src/capture/recorder.js";
import { type Clinic, startClinic } from "./helpers.js";

/**
 * An open stream (a live-update feed, a long download) must not make the recorder wait for the 10 s cap
 * after every action: a crawl of an app with one such connection took 20 s per step.
 */
describe("settle with a stream open", () => {
  let clinic: Clinic;
  let browser: Browser;
  let context: BrowserContext;
  let recorder: Recorder;
  let dir: string;

  beforeAll(async () => {
    clinic = await startClinic();
    browser = await chromium.launch();
    context = await browser.newContext();
    dir = mkdtempSync(join(tmpdir(), "sbx-settle-"));
    recorder = new Recorder(context, dir, 1);
    await recorder.start();
  });
  afterAll(async () => {
    await browser?.close();
    await clinic?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const timed = async () => {
    const t = Date.now();
    const ok = await recorder.settle();
    return { ok, ms: Date.now() - t };
  };

  it("settles at once with no stream", async () => {
    const page = await context.newPage();
    await page.goto(`${clinic.url}/login`);
    const r = await timed();
    expect(r.ok).toBe(true);
    expect(r.ms).toBeLessThan(2000);
    await page.close();
  });

  it("ignores an EventSource that never ends", async () => {
    const page = await context.newPage();
    await page.goto(`${clinic.url}/login`);
    await page.evaluate(() => {
      const es = new EventSource("/events");
      return new Promise<void>((resolve) => es.addEventListener("message", () => resolve(), { once: true }));
    });
    expect(recorder.inflight()).toBe(0);
    const r = await timed();
    expect(r.ok).toBe(true);
    expect(r.ms).toBeLessThan(2000);
    await page.close();
  });

  it("treats a body still arriving two seconds after its headers as a stream", async () => {
    const page = await context.newPage();
    await page.goto(`${clinic.url}/login`);
    await page.evaluate(() => {
      fetch("/events/plain").then(async (res) => {
        const reader = res.body!.getReader();
        while (!(await reader.read()).done) {}
      });
    });
    await page.waitForTimeout(300);
    expect(recorder.inflight()).toBe(1);
    const r = await timed();
    expect(r.ok).toBe(true);
    expect(r.ms).toBeGreaterThan(1000);
    expect(r.ms).toBeLessThan(5000);
    expect(recorder.inflight()).toBe(0);
    // A later action on the same page does not pay for the stream again.
    const again = await timed();
    expect(again.ms).toBeLessThan(1000);
    // Nor does stopping the recorder wait for the stream's body.
    const t = Date.now();
    await recorder.stop();
    expect(Date.now() - t).toBeLessThan(3000);
    await page.close();
  });
});

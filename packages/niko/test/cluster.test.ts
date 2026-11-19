import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { matchCluster, parseRequest, templateRegex } from "../src/analyze/cluster.js";
import { type Ex, mergeShell, mergeTemplates } from "../src/analyze/index.js";
import { BodyStore } from "../src/util.js";

const bodies = new BodyStore(mkdtempSync(join(tmpdir(), "niko-bodies-")));

/** An in-scope GET exchange with the given answer. */
function ex(url: string, body: string, opts: { type?: string; ct?: string } = {}): Ex {
  const parsed = parseRequest("GET", url);
  return {
    type: "exchange",
    id: `x${Math.random().toString(36).slice(2, 8)}`,
    ts: 0,
    endTs: 0,
    method: "GET",
    url,
    reqHeaders: [],
    status: 200,
    resHeaders: [["content-type", opts.ct ?? "application/json"]],
    resBody: bodies.put(body),
    resourceType: opts.type ?? "fetch",
    capture: "c1",
    episode: "1",
    parsed,
    reqText: "",
    inScope: true,
    bodies,
  } as unknown as Ex;
}

describe("path templates", () => {
  it("{path} matches the rest of the address and loses to anything more specific", () => {
    expect(templateRegex("/{path}").exec("/d/abc/slug")?.[1]).toBe("d/abc/slug");
    expect(templateRegex("/api/dashboards/uid/{id}").exec("/api/dashboards/uid/x")?.[1]).toBe("x");
    const clusters = [
      { id: "shell", method: "GET", host: "h", pathTemplate: "/{path}" },
      { id: "root", method: "GET", host: "h", pathTemplate: "/" },
      { id: "dash", method: "GET", host: "h", pathTemplate: "/api/dashboards/uid/{id}" },
      { id: "home", method: "GET", host: "h", pathTemplate: "/api/dashboards/home" },
    ];
    const hit = (path: string) => matchCluster(clusters, parseRequest("GET", `http://h${path}`), path)?.cluster.id;
    expect(hit("/")).toBe("root");
    expect(hit("/api/dashboards/uid/billing")).toBe("dash");
    expect(hit("/api/dashboards/home")).toBe("home");
    expect(hit("/d/new-one/some-title")).toBe("shell");
  });

  it("a segment the app's JSON names as an id is an id, even seen once", () => {
    const list = [
      ex("http://h/api/search", JSON.stringify([{ uid: "billing-queue" }, { uid: "clinic-ops" }])),
      ex("http://h/api/dashboards/uid/billing-queue", "{}"),
      ex("http://h/api/folders/clinic-ops", "{}"),
      ex("http://h/api/folders/general", "{}"), // not named anywhere: stays literal
      ex("http://h/api/dashboards/home", "{}"),
    ];
    mergeTemplates(list);
    const templates = list.map((x) => x.parsed.pathTemplate);
    expect(templates).toContain("/api/dashboards/uid/{id}");
    expect(templates).toContain("/api/folders/{id}");
    expect(templates).toContain("/api/folders/general");
    expect(templates).toContain("/api/dashboards/home");
    expect(list[1]!.parsed.pathParams).toEqual(["billing-queue"]);
  });

  it("three page addresses with the same HTML are one shell endpoint", () => {
    const shell = "<html><body><div id=app></div></body></html>";
    const list = [
      ex("http://h/", shell, { type: "document", ct: "text/html" }),
      ex("http://h/dashboards", shell, { type: "document", ct: "text/html" }),
      ex("http://h/d/billing-queue/billing-queue", shell, { type: "document", ct: "text/html" }),
      ex("http://h/login", "<html>login</html>", { type: "document", ct: "text/html" }),
      ex("http://h/api/search", "[]"),
    ];
    mergeShell(list);
    expect(list.slice(0, 3).map((x) => x.parsed.key)).toEqual(Array(3).fill("GET h /{path}"));
    expect(list[2]!.parsed.pathParams).toEqual(["d/billing-queue/billing-queue"]);
    expect(list[3]!.parsed.pathTemplate).toBe("/login");
    expect(list[4]!.parsed.pathTemplate).toBe("/api/search");
  });
});

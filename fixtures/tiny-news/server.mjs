// tiny-news: a small fictional link-sharing site used to test real-account mode.
// It changes the account the way many older sites do: plain GET links that carry the account's token (vote,
// hide, favorite, flag, logout), an image ping from JavaScript, and forms with a hidden signed field.
// Every change is counted, so a test can require that a read-only capture made none.
import { createHmac, randomBytes } from "node:crypto";
import http from "node:http";

const SEED = () => ({
  users: {
    tester: { karma: 12, about: "Testing account.", password: "test-password" },
    ana: { karma: 340, about: "", password: "x" },
    raj: { karma: 88, about: "", password: "x" },
  },
  stories: [
    {
      id: 11,
      title: "A gentle guide to B-trees",
      url: "https://example.org/btrees",
      by: "ana",
      points: 41,
      kind: "link",
    },
    {
      id: 12,
      title: "Ask: how do you test agents?",
      url: "",
      text: "Curious what people use.",
      by: "raj",
      points: 17,
      kind: "ask",
    },
    {
      id: 13,
      title: "Show: a tiny static site builder",
      url: "https://example.com/sitegen",
      by: "tester",
      points: 9,
      kind: "show",
    },
    {
      id: 14,
      title: "Notes on SQLite in the browser",
      url: "https://example.org/sqlite",
      by: "ana",
      points: 63,
      kind: "link",
    },
    {
      id: 15,
      title: "We are hiring a backend engineer",
      url: "https://example.net/jobs",
      by: "raj",
      points: 1,
      kind: "job",
    },
  ],
  comments: [
    { id: 101, story: 11, parent: 11, by: "raj", text: "The diagrams helped a lot." },
    { id: 102, story: 11, parent: 101, by: "ana", text: "Thanks, they took a while." },
    { id: 103, story: 12, parent: 12, by: "tester", text: "A copy of the app, mostly." },
  ],
  votes: new Set(), // "user:item"
  hidden: new Set(),
  faves: new Set(),
  flags: new Set(),
  nextId: 200,
});

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const CSS =
  "body{font:13px Verdana,sans-serif;margin:0 auto;max-width:860px;background:#f6f6ef}header{background:#3b7ea1;padding:4px 8px}header a{color:#000;margin-right:8px}.votearrow{display:inline-block;width:10px;height:10px;background:#999;margin-right:4px}.sub{font-size:11px;color:#666}.sub a{color:#666}td{padding:2px 4px}";
const JS = `document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a.votearrow');
  if (!a) return;
  e.preventDefault();
  new Image().src = a.href + '&js=t';
  a.style.visibility = 'hidden';
});`;
const GIF = Buffer.from("R0lGODlhAQABAAAAACwAAAAAAQABAAA=", "base64");

export function startTinyNews(port = 0) {
  let db = SEED();
  let changes = 0;
  let rateLimit = 0; // page requests per second allowed per client; 0 = no limit
  const sessions = new Map(); // sid -> user
  const authOf = new Map(); // user -> auth token, stable while logged in
  const hmacKey = randomBytes(16);
  const pageTimes = [];

  const sign = (user, what) => createHmac("sha256", hmacKey).update(`${user}:${what}`).digest("hex").slice(0, 32);
  const tokenFor = (user) => {
    if (!authOf.has(user)) authOf.set(user, randomBytes(20).toString("hex"));
    return authOf.get(user);
  };
  const change = () => changes++;

  const page = (
    user,
    title,
    body,
  ) => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} | Tiny News</title>
<link rel="stylesheet" href="/news.css"></head><body>
<header><a href="/news"><b>Tiny News</b></a><a href="/newest">new</a><a href="/ask">ask</a><a href="/show">show</a><a href="/jobs">jobs</a><a href="/submit">submit</a>
<span style="float:right">${
    user
      ? `<a href="/user?id=${user}">${user}</a> (${db.users[user].karma}) | <a id="logout" href="/logout?auth=${tokenFor(user)}&amp;goto=news">logout</a>`
      : `<a href="/login?goto=news">login</a>`
  }</span></header>
<main>${body}</main><img src="/s.gif" width="0" height="10" alt=""><script src="/news.js"></script></body></html>`;

  const row = (user, s, n, goto) => {
    const k = `${user}:${s.id}`;
    const auth = user ? tokenFor(user) : "";
    const voted = user && db.votes.has(k);
    const arrow = user
      ? voted
        ? ""
        : `<a id="up_${s.id}" class="votearrow" title="upvote" href="/vote?id=${s.id}&amp;how=up&amp;auth=${auth}&amp;goto=${goto}"></a>`
      : `<a class="votearrow" title="upvote" href="/login?goto=${goto}"></a>`;
    const n_comments = db.comments.filter((c) => c.story === s.id).length;
    const site = s.url ? new URL(s.url).host : "";
    return `<tr id="${s.id}"><td>${n}.</td><td>${arrow}</td><td><a class="titlelink" href="${s.url || `/item?id=${s.id}`}">${esc(s.title)}</a>${site ? ` <span class="sub">(<a href="/from?site=${site}">${site}</a>)</span>` : ""}</td></tr>
<tr><td></td><td></td><td class="sub"><span class="score">${s.points} points</span> by <a href="/user?id=${s.by}">${s.by}</a>${
      user
        ? `${voted ? ` | <a href="/vote?id=${s.id}&amp;how=un&amp;auth=${auth}&amp;goto=${goto}">unvote</a>` : ""} | <a href="/hide?id=${s.id}&amp;goto=${goto}&amp;auth=${auth}">hide</a>`
        : ""
    } | <a href="/item?id=${s.id}">${n_comments} comments</a></td></tr>`;
  };
  const list = (user, stories, goto) =>
    `<table>${stories
      .filter((s) => !user || !db.hidden.has(`${user}:${s.id}`))
      .map((s, i) => row(user, s, i + 1, goto))
      .join("")}</table>`;

  const commentTree = (user, storyId, parent, depth = 0) =>
    db.comments
      .filter((c) => c.story === storyId && c.parent === parent)
      .map(
        (c) => `<div class="comment" id="c${c.id}" style="margin-left:${depth * 20}px">
<div class="sub"><a href="/user?id=${c.by}">${c.by}</a>${user ? ` | <a href="/flag?id=${c.id}&amp;auth=${tokenFor(user)}&amp;goto=item%3Fid%3D${storyId}">flag</a>` : ""}</div>
<p>${esc(c.text)}</p>${user ? `<a class="sub" href="/reply?id=${c.id}&amp;goto=item%3Fid%3D${storyId}">reply</a>` : ""}
${commentTree(user, storyId, c.id, depth + 1)}</div>`,
      )
      .join("");

  const commentForm = (user, parent, goto) =>
    `<form method="post" action="/comment"><input type="hidden" name="parent" value="${parent}"><input type="hidden" name="goto" value="${esc(goto)}"><input type="hidden" name="hmac" value="${sign(user, `comment:${parent}`)}"><textarea name="text" rows="4" cols="60"></textarea><br><input type="submit" value="add comment"></form>`;

  const readBody = (req) =>
    new Promise((res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => res(Buffer.concat(chunks).toString("utf8")));
    });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    const q = (k) => url.searchParams.get(k) ?? "";
    const cookies = Object.fromEntries(
      (req.headers.cookie ?? "")
        .split(/;\s*/)
        .filter(Boolean)
        .map((c) => [c.slice(0, c.indexOf("=")), c.slice(c.indexOf("=") + 1)]),
    );
    const user = sessions.get(cookies.user);
    const send = (status, body, type = "text/html; charset=utf-8", extra = {}) => {
      res.writeHead(status, { "content-type": type, ...extra });
      res.end(body);
    };
    const html = (title, body) => send(200, page(user, title, body));
    const redirect = (to) => send(302, "", "text/plain", { location: `/${String(to).replace(/^\//, "")}` });
    const authOk = () => user && q("auth") === tokenFor(user);

    if (path === "/news.css") return send(200, CSS, "text/css");
    if (path === "/news.js") return send(200, JS, "application/javascript");
    if (path === "/s.gif") return send(200, GIF, "image/gif");
    if (path === "/robots.txt")
      return send(200, "User-agent: *\nDisallow: /x?\nDisallow: /reply?\nCrawl-delay: 0.2\n", "text/plain");
    if (path === "/favicon.ico") return send(404, "", "text/plain");

    if (rateLimit) {
      const now = Date.now();
      pageTimes.push(now);
      if (pageTimes.filter((t) => t > now - 1000).length > rateLimit)
        return send(503, "Sorry, we're not able to serve your requests this quickly.", "text/plain");
    } else pageTimes.push(Date.now());

    const byKind = (kind) => db.stories.filter((s) => s.kind === kind);
    if (path === "/" || path === "/news")
      return html(
        "Top",
        list(
          user,
          [...db.stories].sort((a, b) => b.points - a.points),
          "news",
        ),
      );
    if (path === "/newest")
      return html(
        "New",
        list(
          user,
          [...db.stories].sort((a, b) => b.id - a.id),
          "newest",
        ),
      );
    if (path === "/ask") return html("Ask", list(user, byKind("ask"), "ask"));
    if (path === "/show") return html("Show", list(user, byKind("show"), "show"));
    if (path === "/jobs") return html("Jobs", list(user, byKind("job"), "jobs"));
    if (path === "/from")
      return html(
        q("site"),
        list(
          user,
          db.stories.filter((s) => s.url && new URL(s.url).host === q("site")),
          "news",
        ),
      );

    if (path === "/item") {
      const s = db.stories.find((x) => x.id === Number(q("id")));
      if (!s) return send(404, page(user, "Not found", "<p>No such item.</p>"));
      const auth = user ? tokenFor(user) : "";
      const actions = user
        ? ` | <a href="/fave?id=${s.id}&amp;auth=${auth}">${db.faves.has(`${user}:${s.id}`) ? "un-favorite" : "favorite"}</a> | <a href="/flag?id=${s.id}&amp;auth=${auth}&amp;goto=item%3Fid%3D${s.id}">flag</a>`
        : "";
      return html(
        s.title,
        `<table>${row(user, s, "", `item%3Fid%3D${s.id}`)}</table><div class="sub">${actions}</div>${s.text ? `<p>${esc(s.text)}</p>` : ""}
${user ? commentForm(user, s.id, `item?id=${s.id}`) : `<p><a href="/login?goto=item%3Fid%3D${s.id}">Log in</a> to comment.</p>`}
${commentTree(user, s.id, s.id)}`,
      );
    }
    if (path === "/reply") {
      const c = db.comments.find((x) => x.id === Number(q("id")));
      if (!c) return send(404, page(user, "Not found", "<p>No such comment.</p>"));
      if (!user) return redirect(`login?goto=${encodeURIComponent(`reply?id=${c.id}`)}`);
      return html("Add comment", `<p>${esc(c.text)}</p>${commentForm(user, c.id, q("goto") || `item?id=${c.story}`)}`);
    }
    if (path === "/user") {
      const u = db.users[q("id")];
      if (!u) return send(404, page(user, "No such user", "<p>No such user.</p>"));
      const mine = user === q("id");
      const links = `<p><a href="/submitted?id=${q("id")}">submissions</a> | <a href="/threads?id=${q("id")}">comments</a> | <a href="/favorites?id=${q("id")}">favorites</a>${
        mine ? ` | <a href="/upvoted?id=${user}">upvoted</a> | <a href="/hidden">hidden</a>` : ""
      }</p>`;
      const about = mine
        ? `<form method="post" action="/xuser"><input type="hidden" name="id" value="${user}"><input type="hidden" name="hmac" value="${sign(user, "xuser")}"><textarea name="about">${esc(u.about)}</textarea><br><input type="submit" value="update"></form>`
        : `<p>${esc(u.about)}</p>`;
      return html(
        `Profile: ${q("id")}`,
        `<table><tr><td>user:</td><td>${q("id")}</td></tr><tr><td>karma:</td><td>${u.karma}</td></tr></table>${about}${links}`,
      );
    }
    if (path === "/submitted")
      return html(
        `${q("id")}'s submissions`,
        list(
          user,
          db.stories.filter((s) => s.by === q("id")),
          "news",
        ),
      );
    if (path === "/threads")
      return html(
        `${q("id")}'s comments`,
        db.comments
          .filter((c) => c.by === q("id"))
          .map((c) => `<p><a href="/item?id=${c.story}">${esc(c.text)}</a></p>`)
          .join(""),
      );
    if (path === "/favorites")
      return html(
        `${q("id")}'s favorites`,
        list(
          user,
          db.stories.filter((s) => db.faves.has(`${q("id")}:${s.id}`)),
          "news",
        ),
      );
    if (path === "/upvoted") {
      if (!user || user !== q("id")) return send(403, page(user, "Private", "<p>Can't display that.</p>"));
      return html(
        "Upvoted",
        list(
          user,
          db.stories.filter((s) => db.votes.has(`${user}:${s.id}`)),
          "news",
        ),
      );
    }
    if (path === "/hidden") {
      if (!user) return redirect("login?goto=hidden");
      return html(
        "Hidden",
        `<table>${db.stories
          .filter((s) => db.hidden.has(`${user}:${s.id}`))
          .map((s, i) => row(null, s, i + 1, "hidden"))
          .join("")}</table>`,
      );
    }
    if (path === "/submit") {
      if (!user) return redirect("login?goto=submit");
      return html(
        "Submit",
        `<form method="post" action="/r"><input type="hidden" name="fnid" value="${sign(user, "submit")}"><input type="hidden" name="fnop" value="submit-page"><p>title <input name="title"></p><p>url <input name="url"></p><p>text <textarea name="text"></textarea></p><input type="submit" value="submit"></form>`,
      );
    }

    // ---- changes ----
    if (path === "/vote" || path === "/hide" || path === "/fave" || path === "/flag") {
      if (!authOk()) return send(403, "Bad auth.", "text/plain");
      const id = Number(q("id"));
      const k = `${user}:${id}`;
      const s = db.stories.find((x) => x.id === id);
      if (path === "/vote") {
        if (q("how") === "up" && !db.votes.has(k)) {
          db.votes.add(k);
          if (s) s.points++;
        } else if (q("how") === "un" && db.votes.delete(k) && s) s.points--;
      } else if (path === "/hide") db.hidden.add(k);
      else if (path === "/fave") db.faves.has(k) ? db.faves.delete(k) : db.faves.add(k);
      else db.flags.add(k);
      change();
      if (q("js")) return send(200, GIF, "image/gif");
      return redirect(q("goto") || (path === "/fave" ? `item?id=${id}` : "news"));
    }
    if (path === "/logout") {
      if (!authOk()) return send(403, "Bad auth.", "text/plain");
      sessions.delete(cookies.user);
      authOf.delete(user);
      change();
      return redirect(q("goto") || "news");
    }
    if (path === "/login" && req.method === "GET")
      return html(
        "Login",
        `<form method="post" action="/login"><input type="hidden" name="goto" value="${esc(q("goto") || "news")}"><p>username <input name="acct"></p><p>password <input type="password" name="pw"></p><input type="submit" value="login"></form>`,
      );
    if (req.method === "POST") {
      const form = Object.fromEntries(new URLSearchParams(await readBody(req)));
      if (path === "/login") {
        const u = db.users[form.acct];
        if (!u || u.password !== form.pw) return html("Login", "<p>Bad login.</p>");
        const sid = randomBytes(12).toString("hex");
        sessions.set(sid, form.acct);
        res.setHeader("set-cookie", `user=${sid}; Path=/; HttpOnly`);
        return redirect(form.goto || "news");
      }
      if (!user) return send(403, "Log in first.", "text/plain");
      if (path === "/comment") {
        if (form.hmac !== sign(user, `comment:${form.parent}`)) return send(403, "Bad hmac.", "text/plain");
        const parent = Number(form.parent);
        const story = db.stories.find((s) => s.id === parent)?.id ?? db.comments.find((c) => c.id === parent)?.story;
        db.comments.push({ id: db.nextId++, story, parent, by: user, text: form.text });
        change();
        return redirect(form.goto || `item?id=${story}`);
      }
      if (path === "/xuser") {
        if (form.hmac !== sign(user, "xuser")) return send(403, "Bad hmac.", "text/plain");
        db.users[user].about = form.about ?? "";
        change();
        return redirect(`user?id=${user}`);
      }
      if (path === "/r") {
        if (form.fnid !== sign(user, "submit")) return send(403, "Bad fnid.", "text/plain");
        db.stories.push({
          id: db.nextId++,
          title: form.title,
          url: form.url,
          text: form.text,
          by: user,
          points: 1,
          kind: "link",
        });
        change();
        return redirect("newest");
      }
    }
    send(404, page(user, "Not found", "<p>Unknown page.</p>"));
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const p = server.address().port;
      resolve({
        port: p,
        url: `http://127.0.0.1:${p}`,
        /** How many times the site's data or a session was changed. */
        changes: () => changes,
        sessionCount: () => sessions.size,
        state: () => ({
          votes: [...db.votes].sort(),
          hidden: [...db.hidden].sort(),
          faves: [...db.faves].sort(),
          flags: [...db.flags].sort(),
          comments: db.comments.length,
          stories: db.stories.length,
          about: db.users.tester.about,
        }),
        authToken: (u = "tester") => tokenFor(u),
        setRateLimit: (n) => {
          rateLimit = n;
          pageTimes.length = 0;
        },
        pageTimes: () => [...pageTimes],
        reset: () => {
          db = SEED();
          changes = 0;
        },
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startTinyNews(Number(process.argv[2] ?? 3401));
  console.log(`tiny-news on ${s.url} (log in as tester / test-password)`);
}

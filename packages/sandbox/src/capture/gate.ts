import type { Policy, PolicyEntry } from "../types.js";
/**
 * The two write gates used during exploration.
 * UI gate: judge a control before clicking it. Network gate: judge a request before it leaves the browser.
 * The word lists come from the Thousand practice agent's click-safety rule.
 */
import { parseBody } from "../util.js";

/** Social actions that change an account with one click, often as a plain link (vote, hide, favorite...). */
const SOCIAL =
  "(up|down|un)?vote|un-?(fave|favou?rite|hide|flag)|fave|favou?rite|flag|vouch|hide|follow|unfollow|(un)?subscribe|(un)?like|(un)?star|(un)?mute|(un)?block|report";
const SOCIAL_RE = new RegExp(String.raw`\b(${SOCIAL})\b`, "i");
const isPlainPageLink = (href: string | undefined) => {
  if (!href) return false;
  try {
    const u = new URL(href);
    return /^https?:$/.test(u.protocol) && !u.search && !u.hash;
  } catch {
    return false;
  }
};
/** Words that commit something. Checked as whole words against the control's name. */
export const COMMIT_RE = new RegExp(
  String.raw`\b(sign|e-?sign|co-?sign|signature|submit|send|transmit|approve|approval|authori[sz]e|lock|finali[sz]e|complete|prescribe|e-?prescribe|e-?rx|erx|fax|deny|reject|delete|remove|discard|void|verify|attest|publish|release|dispense|order now|place order|refill now|accept|acknowledge|route|forward|assign|notify|post|bill|charge|pay|checkout|check ?out|purchase|unlock|override|cancel (order|visit|appointment|prescription|rx)|${SOCIAL})\b`,
  "i",
);
/** Buttons that only move around or look things up: allowed even when they submit a form. */
export const SAFE_SUBMIT_RE =
  /\b(search|find|look ?up|filter|go|next|previous|prev|back|apply|ok|close|cancel|continue|view|open|show|load|refresh|reload|sort|select|expand|collapse|more|less|details|print preview|preview)\b/i;
const CONFIRM_RE = /^(yes|ok|okay|confirm|continue|proceed|i agree|agree|accept|done|got it|sure)$/i;
const SECRET_FIELD_RE =
  /\b(password|passcode|pin|otp|one[- ]time|verification code|security code|auth(entication)? code|2fa|two[- ]factor|token code)\b/i;
const LEAVE_RE = /\b(log ?out|sign ?out|log ?off|sign ?off|exit|switch (user|account))\b/i;

export interface ControlInfo {
  tag: string;
  name: string;
  role?: string;
  href?: string;
  inputType?: string;
  isSubmit?: boolean;
  inForm?: boolean;
  formMethod?: string;
  dialogText?: string;
}

/**
 * Options for both gates. `strict` is real-account mode: the session may be a person's real account, so anything
 * that could change it is refused, at the cost of some coverage.
 */
export interface GateOptions {
  allowWrites?: boolean;
  strict?: boolean;
}

/** Query parameters that carry a per-user secret. A link that carries one usually acts on the account. */
export const TOKEN_PARAM_RE =
  /^(auth|auth_?token|_?token|access_token|csrf.*|.*csrf|xsrf.*|.*_xsrf|hmac|sig|signature|nonce|fnid|sesskey|authenticity_token)$/i;

const tokenParam = (href: string | undefined) => {
  if (!href) return undefined;
  try {
    return [...new URL(href).searchParams.keys()].find((k) => TOKEN_PARAM_RE.test(k));
  } catch {
    return undefined;
  }
};

/** null = safe to click during read-only exploration; otherwise the reason it is refused. */
export function judgeClick(c: ControlInfo, opts: GateOptions = {}): string | null {
  const name = c.name ?? "";
  if (LEAVE_RE.test(name) || (c.href && /log-?out|sign-?out|logoff/i.test(c.href))) return "ends the session";
  if (c.inputType === "password" || SECRET_FIELD_RE.test(name)) return "password or code field";
  if (opts.allowWrites) return null;
  // A plain link to a page with no query string ("Submit", "Post a job") opens a page; the network gate still
  // judges whatever it loads. Social words and links with parameters stay refused.
  const pageLink = c.tag === "a" && isPlainPageLink(c.href) && !SOCIAL_RE.test(name);
  if (COMMIT_RE.test(name) && !pageLink) return "commits an action";
  if (c.href && DANGER_URL_RE.test(safePath(c.href))) return "link that changes something";
  const token = opts.strict ? tokenParam(c.href) : undefined;
  if (token) return `link carries the session's ${token} token`;
  if (c.dialogText && COMMIT_RE.test(c.dialogText) && CONFIRM_RE.test(name.trim())) return "confirms a commit dialog";
  if (c.isSubmit && (c.formMethod ?? "get").toLowerCase() !== "get" && !SAFE_SUBMIT_RE.test(name))
    return "submits a form that is not a search";
  if (/\b(save|update|create|add|new|edit|upload|import|merge)\b/i.test(name) && c.tag !== "a") return "changes data";
  return null;
}

/** URL shapes that change something even when sent as GET. */
export const DANGER_URL_RE =
  /(^|[/_.?&=-])(delete|remove|destroy|logout|logoff|signout|void|cancel|sign|purge|drop|(up|down|un)?vote|un-?(fave|favou?rite|hide|flag)|fave|favou?rite|flag|vouch|hide|follow|unfollow|(un)?subscribe|(un)?like|(un)?star|(un)?mute)([/_.?&=-]|$)/i;
/** More GET shapes refused in strict mode only: on a test system they are usually pages, on a real account maybe not. */
const STRICT_URL_RE =
  /(^|[/_.?&=-])(report|block|unblock|pin|unpin|archive|mark|join|leave|react|reaction|bookmark)([/_.?&=-]|$)/i;

const safePath = (href: string) => {
  try {
    return new URL(href).pathname;
  } catch {
    return "";
  }
};

const READ_VERBS =
  /^(search|find|query|list|get|fetch|load|lookup|read|view|count|check|validate|preview|autocomplete|suggest)/i;

/** Guess from the request alone whether a non-GET request only reads. */
export function guessFromShape(method: string, url: string, contentType: string, body: string): PolicyEntry {
  const u = new URL(url);
  const { json, form } = parseBody(contentType, body);
  if (json && typeof json === "object" && json !== null) {
    const j = json as Record<string, unknown>;
    if (typeof j.query === "string") {
      const op = j.query.trim();
      if (/^mutation\b/.test(op)) return { decision: "write", by: "heuristic", note: "GraphQL mutation" };
      if (/^(query\b|\{)/.test(op)) return { decision: "read", by: "heuristic", note: "GraphQL query" };
    }
    if (typeof j.method === "string" && j.jsonrpc)
      return READ_VERBS.test(j.method)
        ? { decision: "read", by: "heuristic", note: `JSON-RPC ${j.method}` }
        : { decision: "unknown", by: "heuristic", note: `JSON-RPC ${j.method}` };
  }
  for (const key of ["action", "cmd", "method", "op", "task", "mode"]) {
    const v = form?.[key] ?? u.searchParams.get(key);
    if (v && READ_VERBS.test(v)) return { decision: "read", by: "heuristic", note: `${key}=${v}` };
  }
  const last = u.pathname.split("/").filter(Boolean).pop() ?? "";
  if (method === "POST" && READ_VERBS.test(last))
    return { decision: "read", by: "heuristic", note: `path ends in ${last}` };
  if (method === "DELETE" || method === "PUT" || method === "PATCH")
    return { decision: "write", by: "heuristic", note: method };
  return { decision: "unknown", by: "default" };
}

export type GateVerdict = { allow: true; reason: string } | { allow: false; reason: string };

/** Network gate. `clusterKey` finds the user's or an earlier decision in policy.yaml. */
export function judgeRequest(
  req: { method: string; url: string; contentType: string; body: string; resourceType?: string },
  clusterKey: string,
  policy: Policy,
  opts: GateOptions = {},
): GateVerdict {
  if (opts.allowWrites) return { allow: true, reason: "writes allowed" };
  const known = policy[clusterKey];
  if (known?.by === "user")
    return known.decision === "read"
      ? { allow: true, reason: "policy: read" }
      : { allow: false, reason: `policy: ${known.decision}` };
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    const u = new URL(req.url);
    if (
      DANGER_URL_RE.test(u.pathname) ||
      [...u.searchParams.entries()].some(([k, v]) => /^(action|cmd|op|method|task)$/i.test(k) && DANGER_URL_RE.test(v))
    )
      return { allow: false, reason: "GET with a danger word" };
    if (opts.strict) {
      const token = [...u.searchParams.keys()].find((k) => TOKEN_PARAM_RE.test(k));
      if (token) return { allow: false, reason: `GET carries the session's ${token} token` };
      if (STRICT_URL_RE.test(u.pathname)) return { allow: false, reason: "GET with a danger word (strict)" };
      // Image pings and beacons with a query string are a classic way to make a change without a page load.
      if (
        ["ping", "beacon", "image"].includes(req.resourceType ?? "") &&
        u.search &&
        !/\.(png|gif|jpe?g|svg|ico|webp|avif|bmp)$/i.test(u.pathname)
      )
        return { allow: false, reason: `${req.resourceType} request with a query string (strict)` };
    }
    return { allow: true, reason: "safe method" };
  }
  if (known?.decision === "read") return { allow: true, reason: `policy: read (${known.by})` };
  if (known?.decision === "write") return { allow: false, reason: `policy: write (${known.by})` };
  const guess = guessFromShape(method, req.url, req.contentType, req.body);
  if (guess.decision === "read") return { allow: true, reason: `looks like a read (${guess.note})` };
  return {
    allow: false,
    reason: guess.decision === "write" ? `write (${guess.note})` : "unknown non-GET request, blocked by default",
  };
}

import { createHash } from "node:crypto";
import { closeSync, createReadStream, existsSync, openSync, readdirSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import { type AppPaths, ensureDir } from "../util.js";

/**
 * A pack is one recording on its way from the machine that made it to the machine that builds the copy.
 *
 * It holds the scrubbed recording only: the raw one, the HAR file, the browser profile, the session cookies and
 * the table of real values behind the placeholders never go in, so the login stays on the machine it was made on.
 *
 * Format: "NIKOPACK1\n", then per file a 2-byte name length, the name, an 8-byte size and the bytes; a zero name
 * length ends it. The whole stream is gzipped.
 */

const MAGIC = Buffer.from("NIKOPACK1\n");

/** Every name a pack may hold. Anything else is refused, which is also what keeps a pack inside its folder. */
const ALLOWED =
  /^(manifest\.json|coverage\.json|drift\.json|policy\.yaml|scrubbed\/episodes\/\d+\.jsonl|scrubbed\/bodies\/[0-9a-f]{64}|scrubbed\/snapshots\/[A-Za-z0-9][A-Za-z0-9._-]{0,120})$/;

export class PackError extends Error {}

export interface PackEntry {
  name: string;
  file?: string;
  data?: Buffer;
}

/** The files of one capture that go into its pack, plus anything given in `extra` (name -> content). */
export function packEntries(paths: AppPaths, id: string, extra: Record<string, string | Buffer> = {}): PackEntry[] {
  const base = join(paths.captures, id);
  if (!existsSync(join(base, "scrubbed", "episodes")))
    throw new PackError(`Capture ${id} has not been scrubbed, so it cannot be sent.`);
  const entries: PackEntry[] = [{ name: "manifest.json", file: join(base, "manifest.json") }];
  // drift.json is written by the recorder beside a capture that was made because the app changed.
  for (const f of ["coverage.json", "drift.json"])
    if (existsSync(join(base, f))) entries.push({ name: f, file: join(base, f) });
  const policy = join(paths.root, "policy.yaml");
  if (existsSync(policy)) entries.push({ name: "policy.yaml", file: policy });
  for (const sub of ["episodes", "bodies", "snapshots"]) {
    const dir = join(base, "scrubbed", sub);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).sort()) entries.push({ name: `scrubbed/${sub}/${f}`, file: join(dir, f) });
  }
  for (const [name, data] of Object.entries(extra)) entries.push({ name, data: Buffer.from(data) });
  for (const e of entries) if (!ALLOWED.test(e.name)) throw new PackError(`Not a file a pack may hold: ${e.name}`);
  return entries;
}

async function* frames(entries: PackEntry[]): AsyncGenerator<Buffer> {
  yield MAGIC;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const size = e.data ? e.data.length : statSync(e.file!).size;
    const head = Buffer.alloc(2 + name.length + 8);
    head.writeUInt16BE(name.length, 0);
    name.copy(head, 2);
    head.writeBigUInt64BE(BigInt(size), 2 + name.length);
    yield head;
    if (e.data) yield e.data;
    else for await (const chunk of createReadStream(e.file!)) yield chunk as Buffer;
  }
  yield Buffer.alloc(2);
}

/** The pack as a gzipped stream, read from disk as it is sent. */
export function packStream(entries: PackEntry[]): Readable {
  return Readable.from(frames(entries)).pipe(createGzip());
}

/** Reads exact byte counts from a stream of chunks. */
class Reader {
  private buf: Buffer = Buffer.alloc(0);
  private it: AsyncIterator<Buffer>;
  constructor(source: AsyncIterable<Buffer>) {
    this.it = source[Symbol.asyncIterator]();
  }
  private async fill(n: number) {
    while (this.buf.length < n) {
      const r = await this.it.next();
      if (r.done) return false;
      this.buf = this.buf.length ? Buffer.concat([this.buf, r.value]) : r.value;
    }
    return true;
  }
  /** Exactly n bytes, or an error when the stream ends first. */
  async exact(n: number): Promise<Buffer> {
    if (!(await this.fill(n))) throw new PackError("The pack ended early.");
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
  /** Between 1 and n bytes: whatever has arrived. */
  async some(n: number): Promise<Buffer> {
    if (!(await this.fill(1))) throw new PackError("The pack ended early.");
    const out = this.buf.subarray(0, Math.min(n, this.buf.length));
    this.buf = this.buf.subarray(out.length);
    return out;
  }
}

/**
 * Write an un-gzipped pack stream into `dest`. Refuses names outside the allowed set, bodies whose content does not
 * match their name, and packs larger than `maxBytes` once unpacked.
 */
export async function unpack(
  source: AsyncIterable<Buffer>,
  dest: string,
  opts: { maxBytes?: number; maxFiles?: number } = {},
): Promise<{ files: string[]; bytes: number }> {
  const maxBytes = opts.maxBytes ?? 4 * 2 ** 30;
  const maxFiles = opts.maxFiles ?? 500_000;
  const reader = new Reader(source);
  if (!(await reader.exact(MAGIC.length)).equals(MAGIC)) throw new PackError("Not a Niko pack.");
  const files: string[] = [];
  let bytes = 0;
  for (;;) {
    const nameLen = (await reader.exact(2)).readUInt16BE(0);
    if (nameLen === 0) break;
    const name = (await reader.exact(nameLen)).toString("utf8");
    if (!ALLOWED.test(name) || files.includes(name)) throw new PackError(`The pack holds a file it may not: ${name}`);
    if (files.length >= maxFiles) throw new PackError("The pack holds too many files.");
    let left = Number((await reader.exact(8)).readBigUInt64BE(0));
    bytes += left;
    if (bytes > maxBytes) throw new PackError(`The pack is larger than the ${maxBytes} bytes this server takes.`);
    const file = join(dest, name);
    ensureDir(dirname(file));
    const hash = createHash("sha256");
    const fd = openSync(file, "wx", 0o600);
    try {
      while (left > 0) {
        const chunk = await reader.some(left);
        writeSync(fd, chunk);
        hash.update(chunk);
        left -= chunk.length;
      }
    } finally {
      closeSync(fd);
    }
    const body = /^scrubbed\/bodies\/([0-9a-f]{64})$/.exec(name);
    if (body && body[1] !== hash.digest("hex")) throw new PackError(`A body does not match its name: ${name}`);
    files.push(name);
  }
  if (!files.includes("manifest.json")) throw new PackError("The pack has no manifest.");
  return { files, bytes };
}

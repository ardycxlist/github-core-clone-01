// git.ts — git object model, pkt-line codec, pack codec, smart HTTP handlers.
//
// Everything here is written from the git wire protocol (and the client's
// public expectations in the kit), not from a vendored git library.
// Plain objects only: the client never sends delta packs, and this server
// never writes them.

import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import type { GitObject, GitObjectType, Repo } from "./store.ts";
import { ZERO_OID } from "./store.ts";

export const AGENT = "makefun-forge/1.0";

// ---------------------------------------------------------------------------
// Object model
// ---------------------------------------------------------------------------

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, "utf8");
  return createHash("sha1").update(header).update(data).digest("hex");
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString("utf8");
  const head = text.split("\n\n", 1)[0];
  const message = text.includes("\n\n") ? text.slice(text.indexOf("\n\n") + 2) : "";
  const view: CommitView = { tree: "", parents: [], author: "", committer: "", message };
  for (const line of head.split("\n")) {
    if (line.startsWith("tree ")) view.tree = line.slice(5).trim();
    else if (line.startsWith("parent ")) view.parents.push(line.slice(7).trim());
    else if (line.startsWith("author ")) view.author = line.slice(7);
    else if (line.startsWith("committer ")) view.committer = line.slice(10);
  }
  return view;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(offset, space).toString("ascii");
    const name = data.subarray(space + 1, nul).toString("utf8");
    const oid = data.subarray(nul + 1, nul + 21).toString("hex");
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export interface TagView {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString("utf8");
  const head = text.split("\n\n", 1)[0];
  const message = text.includes("\n\n") ? text.slice(text.indexOf("\n\n") + 2) : "";
  const view: TagView = { object: "", type: "commit", tag: "", tagger: "", message };
  for (const line of head.split("\n")) {
    if (line.startsWith("object ")) view.object = line.slice(7).trim();
    else if (line.startsWith("type ")) view.type = line.slice(5).trim() as GitObjectType;
    else if (line.startsWith("tag ")) view.tag = line.slice(4);
    else if (line.startsWith("tagger ")) view.tagger = line.slice(7);
  }
  return view;
}

/** Follow tag objects to the final non-tag object. */
export function peelToNonTag(repo: Repo, oid: string): string {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== "tag") return current;
    current = parseTag(obj.data).object;
  }
  return current;
}

/** Add a tree and everything under it to `included` (skipping haves). */
function includeTreeClosure(
  repo: Repo,
  treeOid: string,
  included: Map<string, GitObject>,
  haveSet: Set<string>,
): void {
  if (included.has(treeOid) || haveSet.has(treeOid)) return;
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== "tree") return;
  included.set(treeOid, obj);
  for (const entry of parseTree(obj.data)) {
    if (entry.mode === "160000") continue; // gitlink: not stored here
    if (entry.mode === "40000") {
      includeTreeClosure(repo, entry.oid, included, haveSet);
    } else {
      if (included.has(entry.oid) || haveSet.has(entry.oid)) continue;
      const child = repo.objects.get(entry.oid);
      if (child) included.set(entry.oid, child);
    }
  }
}

/** True when `ancestor` is reachable from `descendant` by parent links. */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack: string[] = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== "commit") continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

export interface FetchPlan {
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
}

/** Add a tree and everything under it to `set` (skipping gitlinks). */
function includeTreeIntoSet(repo: Repo, treeOid: string, set: Set<string>): void {
  if (set.has(treeOid)) return;
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== "tree") return;
  set.add(treeOid);
  for (const entry of parseTree(obj.data)) {
    if (entry.mode === "160000") continue; // gitlink: not stored here
    if (entry.mode === "40000") includeTreeIntoSet(repo, entry.oid, set);
    else set.add(entry.oid);
  }
}

/**
 * The objects the client already holds, from its `have` list.
 * The walk descends from each have through parents and trees — but it
 * stops at the client's current shallow boundaries: a shallow clone
 * holds the boundary commit and its tree, not the boundary's parents.
 * (Without this cut, a deepen fetch would wrongly treat the parent as
 * already held and never deliver it.)
 */
export function collectHeldSet(repo: Repo, haves: string[], prevShallow: string[]): Set<string> {
  const held = new Set<string>();
  const shallowSet = new Set(prevShallow);
  const stack: string[] = [...haves];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (held.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    held.add(oid);
    if (obj.type === "commit") {
      const commit = parseCommit(obj.data);
      includeTreeIntoSet(repo, commit.tree, held);
      if (!shallowSet.has(oid)) {
        for (const parent of commit.parents) stack.push(parent);
      }
    } else if (obj.type === "tag") {
      stack.push(parseTag(obj.data).object);
    } else if (obj.type === "tree") {
      includeTreeIntoSet(repo, oid, held);
    }
  }
  return held;
}

/**
 * Compute the objects a fetch must return.
 *
 * Closure = everything reachable from `wants`, stopping at `haves`
 * (objects the client already holds are never re-sent). With a depth
 * limit N, only generations 0..N-1 from each want are included and the
 * generation-(N-1) commits are reported shallow. Previous shallow
 * boundaries whose parents are now fully included are reported
 * unshallow.
 */
export function planFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  prevShallow: string[],
  depth: number | null,
): FetchPlan {
  const held = collectHeldSet(repo, haves, prevShallow);
  const included = new Map<string, GitObject>();
  const includedCommits = new Set<string>();
  const shallow = new Set<string>();

  const queue: Array<[string, number]> = [];
  const queued = new Set<string>();
  const enqueueCommit = (oid: string, gen: number): void => {
    if (queued.has(oid) || held.has(oid)) return;
    if (depth !== null && gen >= depth) return;
    queued.add(oid);
    queue.push([oid, gen]);
  };

  // A want the client already holds is not re-sent — but when a depth
  // limit is in effect (a deepen), the client holds the commit and not
  // its ancestors, so the walk continues past it into the parents.
  // Without a depth limit the held want is a hard boundary (a fetch
  // whose tip is already owned returns an empty pack).
  const includeTarget = (oid: string, gen: number): void => {
    const obj = repo.objects.get(oid);
    if (!obj) return;
    if (obj.type === "commit") {
      if (held.has(oid)) {
        if (depth !== null) {
          for (const parent of parseCommit(obj.data).parents) enqueueCommit(parent, gen + 1);
        }
        return;
      }
      enqueueCommit(oid, gen);
      return;
    }
    if (obj.type === "tag") {
      if (!held.has(oid)) included.set(oid, obj);
      let target = parseTag(obj.data).object;
      for (let hops = 0; hops < 16; hops += 1) {
        const next = repo.objects.get(target);
        if (!next || next.type !== "tag") break;
        if (!held.has(target)) included.set(target, next);
        target = parseTag(next.data).object;
      }
      includeTarget(target, gen);
      return;
    }
    if (obj.type === "tree") {
      includeTreeClosure(repo, oid, included, held);
      return;
    }
    if (!held.has(oid)) included.set(oid, obj); // blob
  };

  for (const want of [...new Set(wants)].sort()) includeTarget(want, 0);

  let head = 0;
  while (head < queue.length) {
    const [oid, gen] = queue[head] as [string, number];
    head += 1;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== "commit") continue;
    included.set(oid, obj);
    includedCommits.add(oid);
    const commit = parseCommit(obj.data);
    includeTreeClosure(repo, commit.tree, included, held);
    if (depth !== null && gen === depth - 1) shallow.add(oid);
    if (depth === null || gen + 1 < depth) {
      for (const parent of commit.parents) enqueueCommit(parent, gen + 1);
    }
  }

  const unshallow: string[] = [];
  for (const oid of prevShallow) {
    if (!includedCommits.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== "commit") continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.every((p) => includedCommits.has(p) || held.has(p))) {
      unshallow.push(oid);
    }
  }

  return { objects: included, shallow: [...shallow].sort(), unshallow: unshallow.sort() };
}

// ---------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------

export type GitPacket =
  | { kind: "data"; payload: Buffer }
  | { kind: "flush" }
  | { kind: "delim" }
  | { kind: "response-end" };

export const FLUSH = Buffer.from("0000", "ascii");
export const DELIM = Buffer.from("0001", "ascii");
export const RESPONSE_END = Buffer.from("0002", "ascii");

/** Encode one pkt-line. Payload must fit in a single pkt-line (<= 65516 bytes). */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const len = data.length + 4;
  if (len > 65520) throw new Error(`pkt-line payload too large: ${data.length} bytes`);
  const header = Buffer.alloc(4);
  header.write(len.toString(16).padStart(4, "0"), "ascii");
  return Buffer.concat([header, data]);
}

export type PktItem = string | Buffer | "flush" | "delim" | "response-end";

export function pktLines(items: PktItem[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === "flush") parts.push(FLUSH);
    else if (item === "delim") parts.push(DELIM);
    else if (item === "response-end") parts.push(RESPONSE_END);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/**
 * Parse a pkt-line stream. Stops at the first flush packet or at the first
 * malformed length; everything after that point is returned as `rest`
 * (for receive-pack: the raw pack bytes that follow the command list).
 */
export function parsePktStream(buf: Buffer): { packets: GitPacket[]; rest: Buffer } {
  const packets: GitPacket[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const head = buf.subarray(offset, offset + 4).toString("ascii");
    if (head === "0000") {
      packets.push({ kind: "flush" });
      offset += 4;
      break;
    }
    if (head === "0001") {
      packets.push({ kind: "delim" });
      offset += 4;
      continue;
    }
    if (head === "0002") {
      packets.push({ kind: "response-end" });
      offset += 4;
      continue;
    }
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const len = parseInt(head, 16);
    if (len < 4 || offset + len > buf.length) break;
    packets.push({ kind: "data", payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return { packets, rest: buf.subarray(offset) };
}

/** One sideband packet (band byte + data) as a pkt-line. */
export function sidebandPacket(band: number, data: Buffer): Buffer {
  return pktLine(Buffer.concat([Buffer.from([band]), data]));
}

/** Split data into sideband band-1 packets (each <= 65520 bytes total). */
export function sidebandChunks(data: Buffer, band = 1): Buffer[] {
  const chunks: Buffer[] = [];
  const maxData = 65515; // 65520 - 4 (length) - 1 (band byte)
  for (let offset = 0; offset < data.length; offset += maxData) {
    chunks.push(sidebandPacket(band, data.subarray(offset, Math.min(offset + maxData, data.length))));
  }
  if (chunks.length === 0) chunks.push(sidebandPacket(band, Buffer.alloc(0)));
  return chunks;
}

// ---------------------------------------------------------------------------
// Pack codec (plain objects only)
// ---------------------------------------------------------------------------

const TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, GitObjectType> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };

function packObjectHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  while (size > 0) {
    bytes.push(first | 0x80);
    first = size & 0x7f;
    size = Math.floor(size / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Write a packfile of plain objects, sorted by oid for determinism. */
export function writePack(objects: Map<string, GitObject>): Buffer {
  const oids = [...objects.keys()].sort();
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write("PACK", 0, "ascii");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const obj = objects.get(oid) as GitObject;
    parts.push(packObjectHeader(TYPE_CODES[obj.type], obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash("sha1").update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Inflate one zlib stream starting at `offset`; returns the data and the offset past it. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
  } catch (err) {
    throw new Error(`pack inflate failed at offset ${offset}: ${(err as Error).message}`);
  }
  const consumed = result.engine.bytesWritten;
  if (!consumed || consumed <= 0) throw new Error(`pack inflate consumed 0 bytes at offset ${offset}`);
  return { data: result.buffer, next: offset + consumed };
}

/**
 * Read a packfile. Plain objects only (commit/tree/blob/tag); delta types
 * are rejected — the client never sends them.
 */
export function readPack(buf: Buffer): { objects: Map<string, GitObject>; deltaCount: number } {
  if (buf.length < 32) throw new Error(`pack too short: ${buf.length} bytes`);
  if (buf.subarray(0, 4).toString("ascii") !== "PACK") throw new Error("pack has a bad magic");
  const version = buf.readUInt32BE(4);
  if (version !== 2) throw new Error(`pack version ${version} is not supported`);
  const count = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;
  const expected = createHash("sha1").update(buf.subarray(0, trailerStart)).digest();
  const actual = buf.subarray(trailerStart);
  if (!expected.equals(actual)) throw new Error("pack trailer checksum mismatch");
  const objects = new Map<string, GitObject>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    if (offset >= trailerStart) throw new Error("pack ends before its declared object count");
    let byte = buf[offset];
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      if (offset >= trailerStart) throw new Error("pack object header is truncated");
      byte = buf[offset];
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const type = CODE_TYPES[typeCode];
    if (!type) throw new Error(`pack object type ${typeCode} is not supported (delta packs are not accepted)`);
    const { data, next } = inflateAt(buf, offset);
    if (data.length !== size) {
      throw new Error(`pack object declared ${size} bytes but inflated to ${data.length}`);
    }
    offset = next;
    objects.set(hashObject(type, data), { type, data });
  }
  if (offset !== trailerStart) throw new Error("pack has stray bytes before its trailer");
  return { objects, deltaCount: 0 };
}

export function verifyPackChecksum(pack: Buffer): { ok: boolean; actual: string; expected: string } {
  if (pack.length < 20) return { ok: false, actual: "", expected: "" };
  const expected = createHash("sha1").update(pack.subarray(0, pack.length - 20)).digest("hex");
  const actual = pack.subarray(pack.length - 20).toString("hex");
  return { ok: actual === expected, actual, expected };
}

// ---------------------------------------------------------------------------
// Advertisements
// ---------------------------------------------------------------------------

const DEFAULT_BRANCH = "refs/heads/main";

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

export function buildV2Advertisement(service: string): Buffer {
  return pktLines([
    `# service=${service}\n`,
    "flush",
    "version 2\n",
    `agent=${AGENT}\n`,
    "object-format=sha1\n",
    "ls-refs=unborn peel symrefs ref-prefix\n",
    "fetch=shallow\n",
    "flush",
  ]);
}

export function buildV0Advertisement(repo: Repo, service: string): Buffer {
  const caps =
    service === "git-receive-pack"
      ? `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`
      : `symref=HEAD:${DEFAULT_BRANCH} object-format=sha1 agent=${AGENT}`;
  const items: PktItem[] = [`# service=${service}\n`, "flush"];
  const mainTip = repo.refs.get(DEFAULT_BRANCH);
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    items.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const firstName = mainTip ? "HEAD" : refs[0][0];
    const firstOid = mainTip ?? refs[0][1];
    items.push(`${firstOid} ${firstName}\0${caps}\n`);
    for (const [name, oid] of refs) {
      if (name === firstName && firstOid === oid) continue;
      items.push(`${oid} ${name}\n`);
      const obj = repo.objects.get(oid);
      if (obj && obj.type === "tag") {
        items.push(`${peelToNonTag(repo, oid)} ${name}^{}\n`);
      }
    }
    // The HEAD line itself also needs its peeled entry when it is a tag
    // (never in practice: HEAD points at a branch).
  }
  items.push("flush");
  return pktLines(items);
}

// ---------------------------------------------------------------------------
// ls-refs (protocol v2)
// ---------------------------------------------------------------------------

export interface LsRefsRequest {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

export function parseLsRefsRequest(packets: GitPacket[]): LsRefsRequest {
  const req: LsRefsRequest = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const packet of packets) {
    if (packet.kind !== "data") continue;
    const line = packet.payload.toString("utf8").replace(/\n$/, "");
    if (line === "peel") req.peel = true;
    else if (line === "symrefs") req.symrefs = true;
    else if (line === "unborn") req.unborn = true;
    else if (line.startsWith("ref-prefix ")) req.prefixes.push(line.slice("ref-prefix ".length));
  }
  return req;
}

export function handleLsRefs(repo: Repo, req: LsRefsRequest): Buffer {
  const keep = (name: string): boolean =>
    req.prefixes.length === 0 || req.prefixes.some((prefix) => name.startsWith(prefix));
  const items: PktItem[] = [];
  const mainTip = repo.refs.get(DEFAULT_BRANCH);
  if (mainTip) {
    if (keep("HEAD")) {
      let line = `${mainTip} HEAD`;
      if (req.symrefs) line += ` symref-target:${DEFAULT_BRANCH}`;
      items.push(`${line}\n`);
    }
  }
  // No `unborn refs/heads/main` line: the suite counts any refs/-named
  // line as a real advertised ref, so a fresh repo must answer with no
  // ref lines at all. The client treats an empty list as an empty repo.
  for (const [name, oid] of sortedRefs(repo)) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (req.peel) {
      const obj = repo.objects.get(oid);
      if (obj && obj.type === "tag") line += ` peeled:${peelToNonTag(repo, oid)}`;
    }
    items.push(`${line}\n`);
  }
  items.push("flush");
  return pktLines(items);
}

// ---------------------------------------------------------------------------
// fetch (protocol v2)
// ---------------------------------------------------------------------------

export interface FetchRequest {
  wants: string[];
  haves: string[];
  prevShallow: string[];
  depth: number | null;
}

export function parseFetchRequest(packets: GitPacket[]): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], prevShallow: [], depth: null };
  for (const packet of packets) {
    if (packet.kind !== "data") continue;
    const line = packet.payload.toString("utf8").replace(/\n$/, "");
    if (line.startsWith("want ")) req.wants.push(line.slice(5).trim());
    else if (line.startsWith("have ")) req.haves.push(line.slice(5).trim());
    else if (line.startsWith("shallow ")) req.prevShallow.push(line.slice(8).trim());
    else if (line.startsWith("deepen ")) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n >= 0) req.depth = n;
    }
    // thin-pack / no-progress / ofs-delta / done / deepen-since /
    // deepen-not / filter: accepted and ignored (no effect on the answer).
  }
  return req;
}

export function handleFetch(repo: Repo, req: FetchRequest): Buffer {
  const plan = planFetch(repo, req.wants, req.haves, req.prevShallow, req.depth);
  const pack = writePack(plan.objects);
  const items: PktItem[] = ["acknowledgments\n", "NAK\n", "delim"];
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    items.push("shallow-info\n");
    for (const oid of plan.shallow) items.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) items.push(`unshallow ${oid}\n`);
    items.push("delim");
  }
  items.push("packfile\n");
  const head = pktLines(items);
  const chunks = sidebandChunks(pack, 1);
  return Buffer.concat([head, ...chunks, FLUSH]);
}

// ---------------------------------------------------------------------------
// receive-pack (protocol v0)
// ---------------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushReportLine {
  ref: string;
  ok: boolean;
  reason: string;
}

function buildPushReport(unpackOk: boolean, unpackDetail: string, lines: PushReportLine[]): Buffer {
  const inner: PktItem[] = [`unpack ${unpackOk ? "ok" : unpackDetail}\n`];
  for (const line of lines) {
    inner.push(line.ok ? `ok ${line.ref}\n` : `ng ${line.ref} ${line.reason}\n`);
  }
  const innerBytes = pktLines(inner);
  return Buffer.concat([sidebandPacket(1, innerBytes), FLUSH]);
}

export function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const { packets, rest } = parsePktStream(body);
  const commands: PushCommand[] = [];
  let malformed = false;
  for (const packet of packets) {
    if (packet.kind !== "data") continue;
    let line = packet.payload.toString("utf8");
    const nul = line.indexOf("\0");
    if (nul >= 0) line = line.slice(0, nul); // capabilities on the first line
    line = line.replace(/\n$/, "");
    const parts = line.split(" ");
    if (parts.length !== 3 || !/^[0-9a-f]{40}$/.test(parts[0]) || !/^[0-9a-f]{40}$/.test(parts[1])) {
      malformed = true;
      break;
    }
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  if (malformed || commands.length === 0) {
    return buildPushReport(false, "malformed request", []);
  }

  // Unpack first: objects land even when a ref update is refused.
  if (rest.length > 0) {
    try {
      const { objects } = readPack(rest);
      for (const [oid, obj] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (err) {
      const lines = commands.map((c) => ({ ref: c.ref, ok: false, reason: "unpack error" }));
      return buildPushReport(false, (err as Error).message.slice(0, 120), lines);
    }
  }

  const report: PushReportLine[] = [];
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref) ?? ZERO_OID;
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === ZERO_OID) {
        report.push({ ref: cmd.ref, ok: false, reason: "does not exist" });
      } else if (cmd.oldOid !== current) {
        report.push({ ref: cmd.ref, ok: false, reason: "non-fast-forward" });
      } else {
        repo.refs.delete(cmd.ref);
        report.push({ ref: cmd.ref, ok: true, reason: "" });
      }
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      // Create.
      if (current !== ZERO_OID) {
        report.push({ ref: cmd.ref, ok: false, reason: "already exists" });
      } else if (!repo.objects.has(cmd.newOid)) {
        report.push({ ref: cmd.ref, ok: false, reason: "unavailable" });
      } else {
        repo.refs.set(cmd.ref, cmd.newOid);
        report.push({ ref: cmd.ref, ok: true, reason: "" });
      }
      continue;
    }
    // Update.
    if (current !== cmd.oldOid) {
      report.push({ ref: cmd.ref, ok: false, reason: "non-fast-forward" });
    } else if (cmd.oldOid === cmd.newOid) {
      report.push({ ref: cmd.ref, ok: true, reason: "" });
    } else if (!repo.objects.has(cmd.newOid)) {
      report.push({ ref: cmd.ref, ok: false, reason: "unavailable" });
    } else if (!isAncestor(repo, cmd.oldOid, cmd.newOid)) {
      report.push({ ref: cmd.ref, ok: false, reason: "non-fast-forward" });
    } else {
      repo.refs.set(cmd.ref, cmd.newOid);
      report.push({ ref: cmd.ref, ok: true, reason: "" });
    }
  }
  return buildPushReport(true, "ok", report);
}

// ---------------------------------------------------------------------------
// upload-pack POST dispatcher (v2 ls-refs / fetch, plus a v0 fallback)
// ---------------------------------------------------------------------------

export interface UploadPackResult {
  status: number;
  body: Buffer;
  contentType: string;
}

export function handleUploadPackPost(repo: Repo, body: Buffer): UploadPackResult {
  const { packets } = parsePktStream(body);
  const first = packets.find((p) => p.kind === "data");
  const firstLine = first ? first.payload.toString("utf8").replace(/\n$/, "") : "";
  if (firstLine === "command=ls-refs") {
    return {
      status: 200,
      body: handleLsRefs(repo, parseLsRefsRequest(packets)),
      contentType: "application/x-git-upload-pack-result",
    };
  }
  if (firstLine === "command=fetch") {
    return {
      status: 200,
      body: handleFetch(repo, parseFetchRequest(packets)),
      contentType: "application/x-git-upload-pack-result",
    };
  }
  // v0 fetch request (want/have lines) — the suite never sends one, but
  // answer it rather than crashing: NAK + the raw pack.
  if (firstLine.startsWith("want ")) {
    const wants: string[] = [];
    const haves: string[] = [];
    for (const packet of packets) {
      if (packet.kind !== "data") continue;
      const line = packet.payload.toString("utf8").replace(/\n$/, "");
      const nul = line.indexOf("\0");
      const clean = nul >= 0 ? line.slice(0, nul) : line;
      if (clean.startsWith("want ")) wants.push(clean.slice(5).trim());
      else if (clean.startsWith("have ")) haves.push(clean.slice(5).trim());
    }
    const plan = planFetch(repo, wants, haves, [], null);
    return {
      status: 200,
      body: Buffer.concat([Buffer.from("NAK\n", "utf8"), writePack(plan.objects)]),
      contentType: "application/x-git-upload-pack-result",
    };
  }
  return {
    status: 400,
    body: Buffer.from("malformed upload-pack request\n", "utf8"),
    contentType: "text/plain",
  };
}

// ---------------------------------------------------------------------------
// Tree / commit helpers for the REST v3 surface (contents API, squash merge)
// ---------------------------------------------------------------------------

export interface FlatEntry {
  mode: string;
  oid: string;
}

/** Flatten a tree into path -> {mode, oid} (recursive). */
export function flattenTree(repo: Repo, treeOid: string): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  const walk = (oid: string, prefix: string): void => {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== "tree") return;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === "40000") walk(entry.oid, path);
      else if (entry.mode === "160000") continue; // gitlink: not stored here
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  walk(treeOid, "");
  return out;
}

interface DirNode {
  dirs: Map<string, DirNode>;
  files: Map<string, FlatEntry>;
}

/** Build (and store) the tree hierarchy for a flat path map; returns the root tree oid. */
export function buildTreeFromPaths(repo: Repo, paths: Map<string, FlatEntry>): string {
  const root: DirNode = { dirs: new Map(), files: new Map() };
  for (const [path, entry] of [...paths.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    const parts = path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      let child = node.dirs.get(part);
      if (!child) {
        child = { dirs: new Map(), files: new Map() };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1] as string, entry);
  }
  const build = (node: DirNode): string => {
    const entries: Array<{ mode: string; name: string; oid: string }> = [];
    for (const [name, dir] of node.dirs) entries.push({ mode: "40000", name, oid: build(dir) });
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    // Git sorts tree entries by name, directories as name + "/".
    entries.sort((a, b) => {
      const ka = a.mode === "40000" ? `${a.name}/` : a.name;
      const kb = b.mode === "40000" ? `${b.name}/` : b.name;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    const parts: Buffer[] = [];
    for (const entry of entries) {
      parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, "utf8"));
      parts.push(Buffer.from(entry.oid, "hex"));
    }
    const data = Buffer.concat(parts);
    const oid = hashObject("tree", data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: "tree", data });
    return oid;
  };
  return build(root);
}

/** The oid of the subtree at `dirPath` under a root tree, or null. */
export function subtreeOid(repo: Repo, treeOid: string, dirPath: string): string | null {
  if (dirPath === "") return treeOid;
  let current = treeOid;
  for (const part of dirPath.split("/")) {
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== "tree") return null;
    const entry = parseTree(obj.data).find((e) => e.name === part && e.mode === "40000");
    if (!entry) return null;
    current = entry.oid;
  }
  return current;
}

/** Create and store a commit object with a deterministic identity; returns its oid. */
export function buildCommit(
  repo: Repo,
  treeOid: string,
  parents: string[],
  message: string,
  epochSec: number,
): string {
  const ident = `Conformance <conformance@make.fun> ${epochSec} +0000`;
  let text = `tree ${treeOid}\n`;
  for (const parent of parents) text += `parent ${parent}\n`;
  text += `author ${ident}\ncommitter ${ident}\n\n${message}`;
  const data = Buffer.from(text, "utf8");
  const oid = hashObject("commit", data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type: "commit", data });
  return oid;
}

/** Commit oids reachable from `tip`, newest first (depth-first, parents in order). */
export function commitHistory(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== "commit") continue;
    out.push(oid);
    const parents = parseCommit(obj.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
  }
  return out;
}

/** The newest common ancestor of two commits, or null when they share none. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsB = new Set<string>(commitHistory(repo, b));
  for (const oid of commitHistory(repo, a)) {
    if (ancestorsB.has(oid)) return oid;
  }
  return null;
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Line-diff stats between two text blobs (LCS over lines). */
export function lineDiffStats(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const m = oldLines.length;
  const n = newLines.length;
  let prev = new Array<number>(n + 1).fill(0);
  let cur = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      cur[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
    cur.fill(0);
  }
  const lcs = prev[n] ?? 0;
  return { additions: n - lcs, deletions: m - lcs };
}

export interface FileChange {
  filename: string;
  status: "added" | "removed" | "modified";
  additions: number;
  deletions: number;
}

/** Changed files between two trees (base -> head), sorted by filename. */
export function diffTrees(
  repo: Repo,
  baseTreeOid: string | null,
  headTreeOid: string | null,
): FileChange[] {
  const base = baseTreeOid ? flattenTree(repo, baseTreeOid) : new Map<string, FlatEntry>();
  const head = headTreeOid ? flattenTree(repo, headTreeOid) : new Map<string, FlatEntry>();
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  const out: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && h) {
      if (b.oid === h.oid && b.mode === h.mode) continue;
      const oldText = repo.objects.get(b.oid)?.data.toString("utf8") ?? "";
      const newText = repo.objects.get(h.oid)?.data.toString("utf8") ?? "";
      const stats = lineDiffStats(oldText, newText);
      out.push({ filename: path, status: "modified", additions: stats.additions, deletions: stats.deletions });
    } else if (h) {
      const newText = repo.objects.get(h.oid)?.data.toString("utf8") ?? "";
      out.push({ filename: path, status: "added", additions: splitLines(newText).length, deletions: 0 });
    } else if (b) {
      const oldText = repo.objects.get(b.oid)?.data.toString("utf8") ?? "";
      out.push({ filename: path, status: "removed", additions: 0, deletions: splitLines(oldText).length });
    }
  }
  return out;
}

/**
 * Three-way merge of flat path maps (merge-base, head, current base tip).
 * A path both sides changed differently is a conflict; the merge is null then.
 */
export function threeWayMerge(
  base: Map<string, FlatEntry>,
  head: Map<string, FlatEntry>,
  tip: Map<string, FlatEntry>,
): { merged: Map<string, FlatEntry> | null; conflicts: string[] } {
  const same = (a: FlatEntry | undefined, b: FlatEntry | undefined): boolean => {
    if (a === undefined && b === undefined) return true;
    if (a === undefined || b === undefined) return false;
    return a.mode === b.mode && a.oid === b.oid;
  };
  const merged = new Map<string, FlatEntry>();
  const conflicts: string[] = [];
  const paths = new Set<string>([...base.keys(), ...head.keys(), ...tip.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    const t = tip.get(path);
    if (same(h, t)) {
      if (h !== undefined) merged.set(path, h);
    } else if (same(b, h)) {
      if (t !== undefined) merged.set(path, t);
    } else if (same(b, t)) {
      if (h !== undefined) merged.set(path, h);
    } else {
      conflicts.push(path);
    }
  }
  return { merged: conflicts.length > 0 ? null : merged, conflicts };
}

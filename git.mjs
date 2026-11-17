// Raven Forge — git core (M1 rebuild).
// In-memory SHA-1 object store plus git smart HTTP (upload-pack v2/v0,
// receive-pack v0). Standard library only; no git binary, no subprocesses,
// no wall-clock input to stored state. Commit times come from a deterministic
// counter clock so identical operation sequences give identical state.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

const EMPTY_OID = '0'.repeat(40);
const OID_RE = /^[0-9a-f]{40}$/;
const TYPE_BY_CODE = ['', 'commit', 'tree', 'blob', 'tag'];
const CODE_BY_TYPE = { commit: 1, tree: 2, blob: 3, tag: 4 };
const FLUSH_PKT = Buffer.from('0000');
const DELIM_PKT = Buffer.from('0001');
const MAX_OBJ = 128 * 1024 * 1024;
const MAX_PACK = 256 * 1024 * 1024;
const EPOCH = 1700000000;
const AGENT = 'raven-forge/1';

function raise(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

function objectSha(type, data) {
  return createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
}

// One pkt-line: 4 hex digits of total length (payload + 4) followed by payload.
function pktLine(payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (data.length > 65516) raise('Packet too large');
  return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, '0')), data]);
}

// Split a pkt-line stream into items. Flush (0) and delim (1) arrive as
// numbers, payloads as Buffers. When stopAtFlush is set, parsing stops right
// after the first flush and reports how many bytes were consumed.
function parsePktLines(body, stopAtFlush = false) {
  const items = [];
  let pos = 0;
  while (pos < body.length) {
    if (pos + 4 > body.length) raise('Truncated packet');
    const hex = body.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) raise('Invalid packet length');
    const size = parseInt(hex, 16);
    pos += 4;
    if (size < 4) {
      if (size === 3) raise('Invalid control packet');
      items.push(size);
      if (!size && stopAtFlush) break;
    } else {
      if (size > 65520 || pos + size - 4 > body.length) raise('Truncated or oversized packet');
      items.push(body.subarray(pos, pos + size - 4));
      pos += size - 4;
    }
  }
  return { items, pos };
}

// Wrap raw bytes into side-band channel-1 frames, each at most `limit` bytes
// of payload plus the channel byte.
function sidebandChunks(data, limit = 65515) {
  const chunks = [];
  for (let p = 0; p < data.length; p += limit) {
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), data.subarray(p, p + limit)])));
  }
  return chunks;
}

function isValidRef(ref) {
  return typeof ref === 'string' && ref.startsWith('refs/') && ref.length <= 1024 &&
    !/[\x00-\x20\x7f~^:?*\[\\]/.test(ref) && !ref.includes('..') && !ref.includes('@{') &&
    ref.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock'));
}

// ---- Object-format parsing -------------------------------------------------

function parseTree(data) {
  const entries = [];
  const names = new Set();
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(32, pos);
    const nul = data.indexOf(0, space + 1);
    if (space < pos || nul < 0 || nul + 21 > data.length) raise('Malformed tree');
    const mode = data.toString('ascii', pos, space);
    const name = data.toString('utf8', space + 1, nul);
    if (!['40000', '040000', '100644', '100755', '120000', '160000'].includes(mode) ||
      !name || name.includes('/') || name === '.' || name === '..' ||
      name.toLowerCase() === '.git' || names.has(name)) raise('Invalid tree entry');
    names.add(name);
    entries.push({ mode, name, sha: data.toString('hex', nul + 1, nul + 21) });
    pos = nul + 21;
  }
  return entries;
}

function parseCommit(data) {
  const split = data.indexOf('\n\n');
  if (split < 0) raise('Malformed commit');
  const lines = data.toString('utf8', 0, split).split('\n');
  const tree = lines.find(x => x.startsWith('tree '))?.slice(5);
  const parents = lines.filter(x => x.startsWith('parent ')).map(x => x.slice(7));
  if (!OID_RE.test(tree || '') || parents.some(x => !OID_RE.test(x))) raise('Invalid commit links');
  const committer = lines.find(x => x.startsWith('committer ')) || '';
  const time = Number(/ (\d+) [+-]\d{4}$/.exec(committer)?.[1] || 0);
  return { tree, parents, time, message: data.toString('utf8', split + 2) };
}

function parseTag(data) {
  const text = data.toString('utf8');
  const sha = /^object ([0-9a-f]{40})\n/.exec(text)?.[1];
  const type = /^type (commit|tree|blob|tag)$/m.exec(text)?.[1];
  if (!sha || !type) raise('Malformed tag');
  return { sha, type };
}

function applyDelta(base, delta) {
  let pos = 0;
  const readVarint = () => {
    let value = 0;
    let factor = 1;
    let byte;
    do {
      if (pos >= delta.length || factor > 2 ** 49) raise('Malformed delta integer');
      byte = delta[pos++];
      value += (byte & 127) * factor;
      factor *= 128;
    } while (byte & 128);
    return value;
  };
  if (readVarint() !== base.length) raise('Delta base size mismatch');
  const size = readVarint();
  if (size > MAX_OBJ) raise('Delta object too large');
  const result = Buffer.allocUnsafe(size);
  let out = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 128) {
      let offset = 0;
      let length = 0;
      for (let i = 0; i < 4; i++) {
        if (op & (1 << i)) {
          if (pos >= delta.length) raise('Truncated delta copy');
          offset += delta[pos++] * 2 ** (i * 8);
        }
      }
      for (let i = 0; i < 3; i++) {
        if (op & (16 << i)) {
          if (pos >= delta.length) raise('Truncated delta copy');
          length += delta[pos++] * 2 ** (i * 8);
        }
      }
      if (!length) length = 65536;
      if (offset + length > base.length || out + length > size) raise('Delta copy out of bounds');
      base.copy(result, out, offset, offset + length);
      out += length;
    } else {
      if (!op || pos + op > delta.length || out + op > size) raise('Invalid delta literal');
      delta.copy(result, out, pos, pos + op);
      pos += op;
      out += op;
    }
  }
  if (out !== size) raise('Delta output size mismatch');
  return result;
}

// ---- Pack decoding --------------------------------------------------------
// Every object stays quarantined in the returned map until the caller decides
// the push is acceptable; nothing is written into the repository here.
function decodePack(pack, repo) {
  if (pack.length < 32 || pack.length > MAX_PACK || pack.toString('ascii', 0, 4) !== 'PACK') raise('Invalid pack');
  const version = pack.readUInt32BE(4);
  const count = pack.readUInt32BE(8);
  const end = pack.length - 20;
  if (![2, 3].includes(version) || count > 1000000 || count > (end - 12) / 3) raise('Invalid pack header');
  if (!createHash('sha1').update(pack.subarray(0, end)).digest().equals(pack.subarray(end))) raise('Pack checksum mismatch');
  const entries = [];
  const offsets = new Map();
  const resolved = new Map();
  let pos = 12;
  let total = 0;
  for (let i = 0; i < count; i++) {
    const offset = pos;
    if (pos >= end) raise('Truncated object header');
    let byte = pack[pos++];
    let size = byte & 15;
    let factor = 16;
    const code = (byte >> 4) & 7;
    while (byte & 128) {
      if (pos >= end || factor > 2 ** 49) raise('Invalid object size');
      byte = pack[pos++];
      size += (byte & 127) * factor;
      factor *= 128;
    }
    if (size > MAX_OBJ || ![1, 2, 3, 4, 6, 7].includes(code)) raise('Invalid pack object');
    const entry = { offset, code, size, object: null, depth: 0 };
    if (code === 6) {
      if (pos >= end) raise('Truncated offset delta');
      byte = pack[pos++];
      let distance = byte & 127;
      while (byte & 128) {
        if (pos >= end || distance > MAX_PACK) raise('Invalid delta offset');
        byte = pack[pos++];
        distance = (distance + 1) * 128 + (byte & 127);
      }
      entry.base = offsets.get(offset - distance);
      if (!entry.base) raise('Delta offset is not an earlier object');
    } else if (code === 7) {
      if (pos + 20 > end) raise('Truncated reference delta');
      entry.baseSha = pack.toString('hex', pos, pos + 20);
      pos += 20;
    }
    const inflated = inflateSync(pack.subarray(pos, end), { info: true, maxOutputLength: Math.max(1, size) });
    if (inflated.buffer.length !== size || !inflated.engine.bytesWritten) raise('Pack object size mismatch');
    pos += inflated.engine.bytesWritten;
    entry.data = inflated.buffer;
    total += size;
    if (total > MAX_PACK * 2) raise('Expanded pack too large');
    entries.push(entry);
    offsets.set(offset, entry);
  }
  if (pos !== end) raise('Trailing data in pack');
  const byOffset = new Map();
  const bySha = new Map();
  const ready = [];
  const waitOn = (map, key, entry) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(entry);
  };
  for (const entry of entries) {
    if (entry.code < 5 || (entry.code === 7 && repo.objects.has(entry.baseSha))) ready.push(entry);
    else if (entry.code === 6) waitOn(byOffset, entry.base.offset, entry);
    else waitOn(bySha, entry.baseSha, entry);
  }
  for (let i = 0; i < ready.length; i++) {
    const entry = ready[i];
    if (entry.object) continue;
    let type = TYPE_BY_CODE[entry.code];
    let data = entry.data;
    if (entry.code > 4) {
      const base = entry.code === 6 ? entry.base.object : resolved.get(entry.baseSha) || repo.get(entry.baseSha);
      if (!base) raise('Missing delta base');
      entry.depth = (entry.code === 6 ? entry.base.depth : (base.deltaDepth || 0)) + 1;
      if (entry.depth > 4096) raise('Delta chain too deep');
      type = base.type;
      data = applyDelta(base.data, data);
      total += data.length;
      if (total > MAX_PACK * 2) raise('Expanded pack too large');
    }
    const sha = objectSha(type, data);
    entry.object = { type, data, deltaDepth: entry.depth };
    resolved.set(sha, entry.object);
    ready.push(...(byOffset.get(entry.offset) || []), ...(bySha.get(sha) || []));
    byOffset.delete(entry.offset);
    bySha.delete(sha);
  }
  if (entries.some(x => !x.object)) raise('Missing or cyclic delta base');
  return resolved;
}

function encodeObjectHeader(type, size) {
  const bytes = [(CODE_BY_TYPE[type] << 4) | (size & 15)];
  size = Math.floor(size / 16);
  while (size) {
    bytes[bytes.length - 1] |= 128;
    bytes.push(size & 127);
    size = Math.floor(size / 128);
  }
  return Buffer.from(bytes);
}

// ---- Line-based diff and three-way text merge ------------------------------

function sameEntry(a, b) {
  return !a || !b ? a === b : a.sha === b.sha && a.mode === b.mode;
}

function splitTextLines(data) {
  return data.toString('utf8').match(/[^\n]*\n|[^\n]+$/g) || [];
}

// Edits turning lines `a` into lines `b`, as {start, end, lines} hunks in
// `a` coordinates. Common prefix/suffix is trimmed first so the quadratic
// LCS table stays small; oversized middles collapse to one replace hunk.
function diffLines(a, b) {
  let prefix = 0;
  let ae = a.length;
  let be = b.length;
  while (prefix < ae && prefix < be && a[prefix] === b[prefix]) prefix++;
  while (ae > prefix && be > prefix && a[ae - 1] === b[be - 1]) { ae--; be--; }
  if (ae === prefix && be === prefix) return [];
  const n = ae - prefix;
  const m = be - prefix;
  if (!n || !m || (n + 1) * (m + 1) > 4000000) {
    return [{ start: prefix, end: ae, lines: b.slice(prefix, be) }];
  }
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = a[prefix + i] === b[prefix + j]
        ? 1 + table[(i + 1) * width + j + 1]
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const edits = [];
  let i = 0;
  let j = 0;
  let edit = null;
  const flush = () => { if (edit) { edits.push(edit); edit = null; } };
  while (i < n || j < m) {
    if (i < n && j < m && a[prefix + i] === b[prefix + j]) { flush(); i++; j++; continue; }
    if (!edit) edit = { start: prefix + i, end: prefix + i, lines: [] };
    if (j < m && (i === n || table[i * width + j + 1] > table[(i + 1) * width + j])) {
      edit.lines.push(b[prefix + j++]);
    } else {
      i++;
      edit.end = prefix + i;
    }
  }
  flush();
  return edits;
}

function mergeTextContent(base, ours, theirs) {
  if (ours.equals(theirs) || base.equals(theirs)) return ours;
  if (base.equals(ours)) return theirs;
  if ([base, ours, theirs].some(x => x.includes(0) || !Buffer.from(x.toString('utf8')).equals(x))) return null;
  const lines = splitTextLines(base);
  const left = diffLines(lines, splitTextLines(ours));
  const right = diffLines(lines, splitTextLines(theirs));
  const edits = [...left];
  for (const r of right) {
    let identical = false;
    for (const l of left) {
      if (l.start === r.start && l.end === r.end && l.lines.join('') === r.lines.join('')) { identical = true; break; }
      const overlap = Math.max(l.start, r.start) < Math.min(l.end, r.end) ||
        (l.start === l.end && l.start >= r.start && l.start <= r.end) ||
        (r.start === r.end && r.start >= l.start && r.start <= l.end);
      if (overlap) return null;
    }
    if (!identical) edits.push(r);
  }
  edits.sort((x, y) => x.start - y.start || x.end - y.end);
  const out = [];
  let pos = 0;
  for (const e of edits) { out.push(...lines.slice(pos, e.start), ...e.lines); pos = e.end; }
  out.push(...lines.slice(pos));
  return Buffer.from(out.join(''));
}

function buildUnifiedPatch(lines, edits) {
  if (!edits.length) return '';
  const out = [];
  let delta = 0;
  const emit = (prefix, line) => {
    out.push(prefix + (line.endsWith('\n') ? line.slice(0, -1) : line));
    if (!line.endsWith('\n')) out.push('\\ No newline at end of file');
  };
  for (let i = 0; i < edits.length;) {
    const first = i;
    const start = Math.max(0, edits[i].start - 3);
    let end = Math.min(lines.length, edits[i].end + 3);
    while (++i < edits.length && edits[i].start - 3 <= end) end = Math.min(lines.length, edits[i].end + 3);
    const group = edits.slice(first, i);
    const change = group.reduce((n, e) => n + e.lines.length - e.end + e.start, 0);
    const oldCount = end - start;
    const newCount = oldCount + change;
    out.push(`@@ -${oldCount ? start + 1 : start},${oldCount} +${newCount ? start + delta + 1 : start + delta},${newCount} @@`);
    let pos = start;
    for (const e of group) {
      for (const line of lines.slice(pos, e.start)) emit(' ', line);
      for (const line of lines.slice(e.start, e.end)) emit('-', line);
      for (const line of e.lines) emit('+', line);
      pos = e.end;
    }
    for (const line of lines.slice(pos, end)) emit(' ', line);
    delta += change;
  }
  return out.join('\n');
}

// ---- Repository ------------------------------------------------------------

export class GitRepo {
  constructor() {
    this.refs = new Map();
    this.objects = new Map();
    this.defaultBranch = 'main';
    this._metaCache = new Map();
    this._deflatedCache = new Map();
    this._packCache = new Map();
    this._packCacheBytes = 0;
    this._knownGood = new Set();
    this._seq = 0;
  }

  put(type, value) {
    if (!CODE_BY_TYPE[type]) raise('Unknown object type');
    const data = Buffer.from(value);
    if (data.length > MAX_OBJ) raise('Object too large');
    const sha = objectSha(type, data);
    if (!this.objects.has(sha)) this.objects.set(sha, { type, data });
    return sha;
  }

  get(sha) { return this.objects.get(sha); }

  resolve(ref = this.defaultBranch) {
    if (ref === 'HEAD') ref = this.defaultBranch;
    if (this.refs.has(ref)) return this.refs.get(ref);
    for (const prefix of ['refs/heads/', 'refs/tags/']) {
      if (this.refs.has(prefix + ref)) return this.refs.get(prefix + ref);
    }
    if (OID_RE.test(ref || '') && this.objects.has(ref)) return ref;
  }

  info(sha) {
    if (this._metaCache.has(sha)) return this._metaCache.get(sha);
    const obj = this.get(sha);
    if (!obj) raise(`Missing object ${sha}`);
    const info = obj.type === 'commit' ? parseCommit(obj.data)
      : obj.type === 'tree' ? parseTree(obj.data)
      : obj.type === 'tag' ? parseTag(obj.data) : null;
    this._metaCache.set(sha, info);
    return info;
  }

  peel(sha) {
    const seen = new Set();
    while (this.get(sha)?.type === 'tag') {
      if (seen.has(sha)) raise('Cyclic tag');
      seen.add(sha);
      sha = this.info(sha).sha;
    }
    return sha;
  }

  links(sha, stopParents = false) {
    const obj = this.get(sha);
    if (!obj) raise(`Missing object ${sha}`);
    const info = this.info(sha);
    if (obj.type === 'commit') return stopParents ? [info.tree] : [info.tree, ...info.parents];
    if (obj.type === 'tree') return info.filter(x => x.mode !== '160000').map(x => x.sha);
    if (obj.type === 'tag') return [info.sha];
    return [];
  }

  reachable(roots, shallow = new Set()) {
    const seen = new Set();
    const stack = [...roots];
    while (stack.length) {
      const sha = stack.pop();
      if (seen.has(sha) || !this.get(sha)) continue;
      seen.add(sha);
      stack.push(...this.links(sha, shallow.has(sha)));
    }
    return seen;
  }

  isAncestor(ancestor, descendant) {
    if (ancestor === descendant) return true;
    const seen = new Set();
    const stack = [descendant];
    while (stack.length) {
      const sha = stack.pop();
      if (seen.has(sha)) continue;
      seen.add(sha);
      if (sha === ancestor) return true;
      if (this.get(sha)?.type === 'commit') stack.push(...this.info(sha).parents);
    }
    return false;
  }

  // Walk the closure of `root`, requiring each linked object to exist with the
  // expected type. Objects already proven good are skipped. `staged` supplies
  // not-yet-published objects (a push quarantine). Returns the visited set.
  validateClosure(root, staged = new Map()) {
    const visited = new Set();
    const stack = [[root, null]];
    const lookup = sha => staged.get(sha) || this.get(sha);
    while (stack.length) {
      const [sha, expected] = stack.pop();
      const obj = lookup(sha);
      if (!obj || (expected && obj.type !== expected)) raise('Missing or wrong-type linked object');
      if (visited.has(sha) || this._knownGood.has(sha)) continue;
      visited.add(sha);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        stack.push([c.tree, 'tree'], ...c.parents.map(x => [x, 'commit']));
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) {
          if (e.mode !== '160000') stack.push([e.sha, /^(0?40000)$/.test(e.mode) ? 'tree' : 'blob']);
        }
      } else if (obj.type === 'tag') {
        const t = parseTag(obj.data);
        stack.push([t.sha, t.type]);
      }
    }
    return visited;
  }

  files(ref = this.defaultBranch) {
    const files = new Map();
    let sha = this.resolve(ref);
    if (!sha) return files;
    sha = this.peel(sha);
    const type = this.get(sha)?.type;
    if (type === 'commit') sha = this.info(sha).tree;
    else if (type !== 'tree') return files;
    const stack = [[sha, '', 0]];
    while (stack.length) {
      const [tree, prefix, depth] = stack.pop();
      if (depth > 256) raise('Tree too deep');
      for (const entry of this.info(tree)) {
        const path = prefix + entry.name;
        if (/^(0?40000)$/.test(entry.mode)) stack.push([entry.sha, path + '/', depth + 1]);
        else {
          const object = this.get(entry.sha);
          if (!object && entry.mode !== '160000') raise('Missing file object');
          files.set(path, { sha: entry.sha, content: object?.data || Buffer.alloc(0), mode: entry.mode });
        }
      }
    }
    return files;
  }

  commitFiles(files, message, branch = this.defaultBranch, parents = undefined) {
    const ref = branch.startsWith('refs/') ? branch : 'refs/heads/' + branch;
    if (!isValidRef(ref)) raise('Invalid branch', 422);
    for (const name of this.refs.keys()) {
      if (name !== ref && (name.startsWith(ref + '/') || ref.startsWith(name + '/'))) raise('Ref namespace conflict', 422);
    }
    if (parents === undefined) parents = this.refs.has(ref) ? [this.refs.get(ref)] : [];
    parents = parents.map(x => this.resolve(x) || x);
    if (parents.some(x => this.get(x)?.type !== 'commit')) raise('Invalid parent commit', 422);
    const root = new Map();
    for (const [path, file] of files) {
      const parts = path.split('/');
      if (parts.length > 256 || parts.some(x => !x || x === '.' || x === '..' || x.toLowerCase() === '.git' || x.includes('\0'))) {
        raise('Invalid file path', 422);
      }
      let node = root;
      for (const part of parts.slice(0, -1)) {
        if (!node.has(part)) node.set(part, new Map());
        node = node.get(part);
        if (!(node instanceof Map)) raise('File/directory conflict', 422);
      }
      const name = parts.at(-1);
      if (node.get(name) instanceof Map) raise('File/directory conflict', 422);
      const mode = file.mode || '100644';
      if (!['100644', '100755', '120000', '160000'].includes(mode)) raise('Invalid file mode', 422);
      const sha = mode === '160000' ? file.sha : this.put('blob', file.content ?? this.get(file.sha)?.data ?? Buffer.alloc(0));
      if (!OID_RE.test(sha || '')) raise('Invalid file object', 422);
      node.set(name, { sha, mode });
    }
    const buildTree = node => {
      const entries = [...node].map(([name, entry]) => entry instanceof Map
        ? { name, mode: '40000', sha: buildTree(entry) }
        : { name, ...entry });
      entries.sort((a, b) => Buffer.compare(
        Buffer.from(a.name + (a.mode === '40000' ? '/' : '')),
        Buffer.from(b.name + (b.mode === '40000' ? '/' : ''))));
      return this.put('tree', Buffer.concat(entries.map(e =>
        Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.sha, 'hex')]))));
    };
    const tree = buildTree(root);
    const time = EPOCH + ++this._seq;
    const identity = `Raven Forge <forge@localhost> ${time} +0000`;
    const body = String(message || '');
    const text = `tree ${tree}\n${parents.map(x => `parent ${x}\n`).join('')}author ${identity}\ncommitter ${identity}\n\n${body}${body.endsWith('\n') ? '' : '\n'}`;
    const sha = this.put('commit', text);
    this.refs.set(ref, sha);
    return sha;
  }

  writeFile(path, content, message, branch = this.defaultBranch, deleteFile = false) {
    const files = this.files(branch);
    const previous = files.get(path);
    let blobSha = previous?.sha;
    if (deleteFile) files.delete(path);
    else {
      const data = Buffer.from(content);
      blobSha = this.put('blob', data);
      files.set(path, { sha: blobSha, content: data, mode: previous?.mode || '100644' });
    }
    return { sha: this.commitFiles(files, message, branch), blobSha };
  }

  mergeBase(a, b) {
    const distances = start => {
      const map = new Map();
      const queue = [[start, 0]];
      for (let i = 0; i < queue.length; i++) {
        const [sha, d] = queue[i];
        if (map.has(sha) || this.get(sha)?.type !== 'commit') continue;
        map.set(sha, d);
        for (const p of this.info(sha).parents) queue.push([p, d + 1]);
      }
      return map;
    };
    const left = distances(a);
    const right = distances(b);
    const common = [...left.keys()].filter(x => right.has(x));
    common.sort((x, y) => Math.max(left.get(x), right.get(x)) - Math.max(left.get(y), right.get(y)) ||
      left.get(x) + right.get(x) - left.get(y) - right.get(y) || x.localeCompare(y));
    return common.find(x => !common.some(y => x !== y && this.isAncestor(x, y)));
  }

  merge(head, base = this.defaultBranch, message = 'Merge') {
    const headSha = this.peel(this.resolve(head));
    const baseSha = this.peel(this.resolve(base));
    if (this.get(headSha)?.type !== 'commit' || this.get(baseSha)?.type !== 'commit') raise('Unknown merge branch', 404);
    const ancestor = this.mergeBase(headSha, baseSha);
    if (!ancestor) return { sha: baseSha, conflict: true };
    const original = this.files(ancestor);
    const ours = this.files(baseSha);
    const theirs = this.files(headSha);
    const merged = new Map(ours);
    for (const path of new Set([...original.keys(), ...ours.keys(), ...theirs.keys()])) {
      const old = original.get(path);
      const left = ours.get(path);
      const right = theirs.get(path);
      if (sameEntry(left, right) || sameEntry(old, right)) continue;
      if (sameEntry(old, left)) {
        if (right) merged.set(path, right); else merged.delete(path);
        continue;
      }
      if (!old || !left || !right || [old, left, right].some(x => !x.mode.startsWith('100'))) {
        return { sha: baseSha, conflict: true };
      }
      const mode = left.mode === right.mode ? left.mode
        : old.mode === left.mode ? right.mode
        : old.mode === right.mode ? left.mode : null;
      const content = mergeTextContent(old.content, left.content, right.content);
      if (!mode || content === null) return { sha: baseSha, conflict: true };
      merged.set(path, { sha: this.put('blob', content), content, mode });
    }
    for (const path of merged.keys()) {
      const parts = path.split('/');
      parts.pop();
      while (parts.length) {
        if (merged.has(parts.join('/'))) return { sha: baseSha, conflict: true };
        parts.pop();
      }
    }
    return { sha: this.commitFiles(merged, message, base, [baseSha]), conflict: false };
  }

  diff(base, head) {
    const oldFiles = this.files(base);
    const newFiles = this.files(head);
    const result = [];
    for (const filename of [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort()) {
      const old = oldFiles.get(filename);
      const now = newFiles.get(filename);
      if (sameEntry(old, now)) continue;
      const before = old?.content || Buffer.alloc(0);
      const after = now?.content || Buffer.alloc(0);
      let additions = 0;
      let deletions = 0;
      let patch = '';
      if (!before.includes(0) && !after.includes(0)) {
        const a = splitTextLines(before);
        const b = splitTextLines(after);
        const edits = diffLines(a, b);
        for (const e of edits) { additions += e.lines.length; deletions += e.end - e.start; }
        patch = buildUnifiedPatch(a, edits);
      }
      result.push({
        filename,
        status: !old ? 'added' : !now ? 'removed' : 'modified',
        additions, deletions, changes: additions + deletions, patch,
      });
    }
    return result;
  }

  // Emit a pack of complete objects (no generated deltas), with a small LRU
  // cache keyed on the exact object list.
  pack(ids) {
    const key = ids.join('');
    if (this._packCache.has(key)) {
      const value = this._packCache.get(key);
      this._packCache.delete(key);
      this._packCache.set(key, value);
      return value;
    }
    const header = Buffer.alloc(12);
    header.write('PACK');
    header.writeUInt32BE(2, 4);
    header.writeUInt32BE(ids.length, 8);
    const parts = [header];
    for (const sha of ids) {
      let packed = this._deflatedCache.get(sha);
      if (!packed) {
        const obj = this.get(sha);
        if (!obj) raise('Missing pack object');
        packed = Buffer.concat([encodeObjectHeader(obj.type, obj.data.length), deflateSync(obj.data, { level: 1 })]);
        if (this._deflatedCache.size < 10000 && packed.length < 1024 * 1024) this._deflatedCache.set(sha, packed);
      }
      parts.push(packed);
    }
    const checksum = createHash('sha1');
    for (const part of parts) checksum.update(part);
    parts.push(checksum.digest());
    const pack = Buffer.concat(parts);
    if (pack.length <= 16 * 1024 * 1024) {
      this._packCache.set(key, pack);
      this._packCacheBytes += pack.length;
      while (this._packCache.size > 16 || this._packCacheBytes > 16 * 1024 * 1024) {
        const first = this._packCache.keys().next().value;
        this._packCacheBytes -= this._packCache.get(first).length;
        this._packCache.delete(first);
      }
    }
    return pack;
  }
}

// ---- Smart HTTP ------------------------------------------------------------

function advertiseRefs(repo, service, v2) {
  if (v2 && service === 'git-upload-pack') {
    return Buffer.concat([
      pktLine('version 2\n'), pktLine(`agent=${AGENT}\n`), pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow\n'), pktLine('server-option\n'), pktLine('object-format=sha1\n'), FLUSH_PKT,
    ]);
  }
  const upload = service === 'git-upload-pack';
  const target = 'refs/heads/' + repo.defaultBranch;
  const caps = upload
    ? `side-band-64k thin-pack ofs-delta shallow no-progress include-tag symref=HEAD:${target} agent=${AGENT} object-format=sha1`
    : `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${AGENT} object-format=sha1`;
  const refs = [...repo.refs].sort(([a], [b]) => a.localeCompare(b));
  if (upload && repo.refs.has(target)) refs.unshift(['HEAD', repo.refs.get(target)]);
  const out = [pktLine(`# service=${service}\n`), FLUSH_PKT];
  if (!refs.length) out.push(pktLine(`${EMPTY_OID} capabilities^{}\0${caps}\n`));
  for (let i = 0; i < refs.length; i++) {
    const [name, sha] = refs[i];
    out.push(pktLine(`${sha} ${name}${i === 0 ? '\0' + caps : ''}\n`));
    if (upload && repo.get(sha)?.type === 'tag') out.push(pktLine(`${repo.peel(sha)} ${name}^{}\n`));
  }
  out.push(FLUSH_PKT);
  return Buffer.concat(out);
}

function listRefsV2(repo, lines) {
  const prefixes = lines.filter(x => x.startsWith('ref-prefix ')).map(x => x.slice(11));
  const keep = name => !prefixes.length || prefixes.some(p => name.startsWith(p));
  const target = 'refs/heads/' + repo.defaultBranch;
  const refs = [...repo.refs].sort(([a], [b]) => a.localeCompare(b));
  if (repo.refs.has(target)) refs.unshift(['HEAD', repo.refs.get(target)]);
  const out = [];
  if (!repo.refs.has(target) && lines.includes('unborn') && keep('HEAD')) {
    out.push(pktLine(`unborn HEAD${lines.includes('symrefs') ? ` symref-target:${target}` : ''}\n`));
  }
  for (const [name, sha] of refs) {
    if (!keep(name)) continue;
    let line = `${sha} ${name}`;
    if (name === 'HEAD' && lines.includes('symrefs')) line += ` symref-target:${target}`;
    if (lines.includes('peel') && repo.get(sha)?.type === 'tag') line += ` peeled:${repo.peel(sha)}`;
    out.push(pktLine(line + '\n'));
  }
  out.push(FLUSH_PKT);
  return Buffer.concat(out);
}

// Decide which objects a fetch needs. Returns the object ids to send, the
// new shallow boundary, commits that stop being shallow, the acknowledged
// haves and the wants.
function planFetch(repo, lines) {
  const values = key => lines.filter(x => x.startsWith(key + ' ')).map(x => x.slice(key.length + 1).split(' ')[0]);
  const wants = [...new Set(values('want'))];
  const haves = [...new Set(values('have'))];
  const oldShallow = new Set(values('shallow'));
  for (const sha of [...wants, ...haves, ...oldShallow]) if (!OID_RE.test(sha)) raise('Invalid fetch object id');
  for (const sha of wants) if (!repo.get(sha)) raise('Requested object not found');
  for (const sha of oldShallow) if (repo.get(sha)?.type !== 'commit') raise('Invalid shallow boundary');
  const depthText = values('deepen')[0];
  const depth = depthText === undefined ? Infinity : Number(depthText);
  if (depthText !== undefined && (!/^\d+$/.test(depthText) || depth <= 0 || !Number.isSafeInteger(depth))) raise('Invalid deepen depth');
  const sinceText = values('deepen-since')[0];
  const since = sinceText === undefined ? null : Number(sinceText);
  if (since !== null && (!Number.isSafeInteger(since) || since < 0)) raise('Invalid deepen time');
  if (Number.isFinite(depth) && (since !== null || values('deepen-not').length)) raise('Incompatible deepen arguments');
  const excludedRoots = values('deepen-not').map(x => repo.resolve(x));
  if (excludedRoots.some(x => !x)) raise('Unknown deepen exclusion');
  const excluded = repo.reachable(excludedRoots);
  const known = repo.reachable(haves, oldShallow);
  const commits = new Set();
  const objects = new Set();
  const queue = [];
  const distances = new Map();
  const addRoot = sha => {
    const visited = new Set();
    while (repo.get(sha)?.type === 'tag') {
      if (visited.has(sha)) raise('Cyclic tag');
      visited.add(sha);
      objects.add(sha);
      sha = repo.info(sha).sha;
    }
    if (repo.get(sha)?.type === 'commit') queue.push([sha, 1]);
    else objects.add(sha);
  };
  for (const sha of wants) addRoot(sha);
  const relative = lines.includes('deepen-relative') && Number.isFinite(depth) && oldShallow.size > 0;
  const stopOld = !Number.isFinite(depth) && since === null && !excludedRoots.length;
  const walk = (work, limit, honorOld) => {
    for (let i = 0; i < work.length; i++) {
      const [sha, distance] = work[i];
      if (distance > limit || (distances.has(sha) && distances.get(sha) <= distance)) continue;
      if (repo.get(sha)?.type !== 'commit') raise('Missing parent commit');
      const c = repo.info(sha);
      if (excluded.has(sha) || (since !== null && c.time < since)) continue;
      distances.set(sha, distance);
      commits.add(sha);
      if (distance < limit && !(honorOld && oldShallow.has(sha))) {
        for (const p of c.parents) work.push([p, distance + 1]);
      }
    }
  };
  walk(queue, relative ? Infinity : depth, relative || stopOld);
  if (relative) {
    const work = [...oldShallow].filter(x => commits.has(x)).map(x => [x, 0]);
    distances.clear();
    walk(work, depth, false);
  }
  const shallow = new Set();
  for (const sha of commits) {
    const c = repo.info(sha);
    objects.add(sha);
    objects.add(c.tree);
    if (c.parents.some(p => !commits.has(p))) shallow.add(sha);
  }
  const unshallow = [...oldShallow].filter(sha => commits.has(sha) && !shallow.has(sha));
  const stack = [...objects];
  while (stack.length) {
    const sha = stack.pop();
    if (repo.get(sha)?.type !== 'tree') continue;
    for (const e of repo.info(sha)) {
      if (e.mode !== '160000' && !objects.has(e.sha)) { objects.add(e.sha); stack.push(e.sha); }
    }
  }
  if (lines.includes('include-tag')) {
    for (const sha of repo.refs.values()) {
      if (repo.get(sha)?.type === 'tag' && objects.has(repo.peel(sha))) {
        let tag = sha;
        while (repo.get(tag)?.type === 'tag' && !objects.has(tag)) { objects.add(tag); tag = repo.info(tag).sha; }
      }
    }
  }
  return {
    ids: [...objects].filter(x => !known.has(x)),
    shallow: [...shallow],
    unshallow,
    haves: haves.filter(x => repo.get(x)),
    wants,
  };
}

function serveUploadPack(repo, body, v2) {
  const { items } = parsePktLines(body);
  const lines = items.filter(Buffer.isBuffer).map(x => x.toString('utf8').replace(/\n$/, ''));
  if (v2) {
    const command = lines.find(x => x.startsWith('command='))?.slice(8);
    if (command === 'ls-refs') return listRefsV2(repo, lines);
    if (command !== 'fetch') raise('Unsupported Git command');
  }
  const selection = planFetch(repo, lines);
  const out = [];
  const done = lines.includes('done');
  if (v2 && !done) {
    out.push(pktLine('acknowledgments\n'));
    if (selection.haves.length) {
      for (const sha of selection.haves) out.push(pktLine(`ACK ${sha}\n`));
      out.push(pktLine('ready\n'), DELIM_PKT);
    } else {
      out.push(pktLine('NAK\n'), FLUSH_PKT);
      return Buffer.concat(out);
    }
  }
  const hasShallowSection = selection.shallow.length || selection.unshallow.length;
  if (hasShallowSection) {
    if (v2) out.push(pktLine('shallow-info\n'));
    for (const sha of selection.shallow) out.push(pktLine(`shallow ${sha}\n`));
    for (const sha of selection.unshallow) out.push(pktLine(`unshallow ${sha}\n`));
    out.push(v2 ? DELIM_PKT : FLUSH_PKT);
  } else if (!v2 && lines.some(x => x.startsWith('deepen '))) out.push(FLUSH_PKT);
  // v0 answers a deepen request in two rounds. The round without `done` gets
  // only the shallow section (possibly just its flush); the ACK and the pack
  // wait for the `done` round, whose answer repeats the shallow section
  // first. Answering the ACK in round one makes real git fail with
  // "expected shallow list" (verified: the blueprint's own git.mjs fails a
  // v0 depth-1 clone the same way, while v2 works).
  if (!v2 && !done && lines.some(x => x.startsWith('deepen '))) return Buffer.concat(out);
  if (!v2) {
    out.push(pktLine(selection.haves.length ? `ACK ${selection.haves.at(-1)}\n` : 'NAK\n'));
    if (!done) return Buffer.concat(out);
  }
  const pack = repo.pack(selection.ids);
  if (v2) out.push(pktLine('packfile\n'));
  const firstWant = lines.find(x => x.startsWith('want ')) || '';
  if (v2 || firstWant.includes('side-band-64k')) out.push(...sidebandChunks(pack), FLUSH_PKT);
  else if (firstWant.includes('side-band')) out.push(...sidebandChunks(pack, 995), FLUSH_PKT);
  else out.push(pack);
  return Buffer.concat(out);
}

function serveReceivePack(repo, body) {
  const { items, pos } = parsePktLines(body, true);
  if (items.at(-1) !== 0) raise('Missing command flush');
  const raw = items.filter(Buffer.isBuffer);
  const commands = [];
  let capabilities = [];
  for (let i = 0; i < raw.length; i++) {
    const parts = raw[i].toString('utf8').replace(/\n$/, '').split('\0');
    if (parts.length > 2 || (i && parts.length > 1)) raise('Invalid command capabilities');
    if (!i && parts[1]) capabilities = parts[1].split(' ');
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(parts[0]);
    if (!match) raise('Invalid ref update');
    commands.push({ old: match[1], next: match[2], ref: match[3] });
  }
  const report = [];
  let unpackError = null;
  let staged = new Map();
  // A scratch repo whose lookups see staged objects first; it shares the
  // proven-good set so already-validated objects are never re-walked.
  const quarantine = new GitRepo();
  quarantine.get = sha => staged.get(sha) || repo.get(sha);
  quarantine._knownGood = repo._knownGood;
  try {
    const pack = body.subarray(pos);
    if (!pack.length && commands.some(c => c.next !== EMPTY_OID && !repo.get(c.next))) raise('Missing pack');
    if (pack.length) {
      staged = decodePack(pack, repo);
      for (const obj of staged.values()) {
        if (obj.type === 'commit') parseCommit(obj.data);
        else if (obj.type === 'tree') parseTree(obj.data);
        else if (obj.type === 'tag') parseTag(obj.data);
      }
    }
  } catch (error) {
    unpackError = String(error.message || 'invalid pack').replace(/[\r\n\0]/g, ' ').slice(0, 180);
  }
  report.push(pktLine(`unpack ${unpackError || 'ok'}\n`));
  const seen = new Set();
  for (const c of commands) {
    let reason = unpackError ? 'unpacker error' : null;
    const current = repo.refs.get(c.ref) || EMPTY_OID;
    if (!reason && (!isValidRef(c.ref) || seen.has(c.ref))) reason = 'invalid ref';
    seen.add(c.ref);
    if (!reason && current !== c.old) reason = 'stale old object id';
    let checked;
    if (!reason && c.next !== EMPTY_OID) {
      if (!quarantine.get(c.next)) reason = 'missing object';
      else if (c.ref.startsWith('refs/heads/') && quarantine.get(c.next).type !== 'commit') reason = 'branch must point to a commit';
      else if (current !== EMPTY_OID && current !== c.next &&
        (c.ref.startsWith('refs/tags/') || !quarantine.isAncestor(current, c.next))) reason = 'non-fast-forward';
      if (!reason) {
        try { checked = quarantine.validateClosure(c.next, staged); }
        catch { reason = 'missing or invalid linked object'; }
      }
      if (!reason) {
        for (const name of repo.refs.keys()) {
          if (name !== c.ref && (name.startsWith(c.ref + '/') || c.ref.startsWith(name + '/'))) {
            reason = 'ref namespace conflict';
            break;
          }
        }
      }
    }
    if (reason) report.push(pktLine(`ng ${c.ref} ${reason}\n`));
    else {
      // Publish only the validated closure of an accepted ref. Objects from
      // a rejected push stay quarantined and can never be promoted later.
      for (const sha of checked || []) {
        const obj = staged.get(sha);
        if (obj && !repo.objects.has(sha)) repo.objects.set(sha, { type: obj.type, data: obj.data });
        repo._knownGood.add(sha);
      }
      if (c.next === EMPTY_OID) repo.refs.delete(c.ref);
      else repo.refs.set(c.ref, c.next);
      report.push(pktLine(`ok ${c.ref}\n`));
    }
  }
  report.push(FLUSH_PKT);
  if (!capabilities.includes('report-status') && !capabilities.includes('report-status-v2')) return FLUSH_PKT;
  const data = Buffer.concat(report);
  return capabilities.includes('side-band-64k') ? Buffer.concat([...sidebandChunks(data), FLUSH_PKT]) : data;
}

export function handleGit(req, res, body, repo) {
  const send = (status, type, data) => {
    res.statusCode = status;
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'no-cache, max-age=0, must-revalidate');
    res.setHeader('Content-Length', data.length);
    res.end(data);
  };
  try {
    if (!repo) return send(404, 'text/plain; charset=utf-8', Buffer.from('Repository not found\n'));
    const url = new URL(req.url, 'http://localhost');
    const version = String(req.headers?.['git-protocol'] || '').split(':').includes('version=2');
    if (req.method === 'GET' && url.pathname.endsWith('/info/refs')) {
      const service = url.searchParams.get('service');
      if (!['git-upload-pack', 'git-receive-pack'].includes(service)) raise('Unsupported service');
      return send(200, `application/x-${service}-advertisement`, advertiseRefs(repo, service, version));
    }
    if (req.method === 'POST' && url.pathname.endsWith('/git-upload-pack')) {
      return send(200, 'application/x-git-upload-pack-result', serveUploadPack(repo, body || Buffer.alloc(0), version));
    }
    if (req.method === 'POST' && url.pathname.endsWith('/git-receive-pack')) {
      return send(200, 'application/x-git-receive-pack-result', serveReceivePack(repo, body || Buffer.alloc(0)));
    }
    send(404, 'text/plain; charset=utf-8', Buffer.from('Git endpoint not found\n'));
  } catch (error) {
    if (!res.headersSent) send(error.status || 400, 'text/plain; charset=utf-8', Buffer.from(String(error.message || 'Git request failed') + '\n'));
    else res.end();
  }
}

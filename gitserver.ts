// Git smart HTTP: v0/v2 advertisements, ls-refs, fetch (v2 + v0 fallback),
// receive-pack (push). Wire shapes verified against real `git upload-pack` /
// `git receive-pack` (`--stateless-rpc` captures, /tmp/git-truth*.ts):
//  - HTTP info/refs adds the `# service=...` preamble + flush before ref lines.
//  - v2 POST responses carry NO advertisement prefix (stateless RPC).
//  - v2 fetch omits `acknowledgments` when the request has `done` (git does);
//    `shallow-info` lines have no trailing newline and end with DELIM (0001).
//  - wanted-refs is omitted (git omits it for these requests; the client tolerates it).
//  - Push report goes through sideband band 1; `ng <ref> non-fast-forward` is
//    the exact refusal reason; `unpack ok` is present even for refused pushes.

import {
  pktLine, pktLines, pktSplit, PKT_FLUSH, PKT_DELIM,
  parsePack, buildPack, parseCommit, parseTree,
  OBJ_BLOB, OBJ_TREE, OBJ_COMMIT, OBJ_TAG,
  type PackEntry,
} from './git.ts';
import { Store, VIEWER, type Repo } from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';
const OID_RE = /^[0-9a-f]{40}$/;

// ---------------------------------------------------------------------------
// Small git-object helpers
// ---------------------------------------------------------------------------

/** Target oid of an annotated tag object (`object <oid>` header). */
export function tagTarget(data: Buffer): string | null {
  const text = data.toString('utf8');
  const m = /^object ([0-9a-f]{40})$/m.exec(text);
  return m ? m[1] : null;
}

/** Add a tree and everything under it (nested trees + blobs) to `set`. */
function addTreeObjects(repo: Repo, treeOid: string, set: Set<string>): void {
  const stack: string[] = [treeOid];
  while (stack.length > 0) {
    const t = stack.pop()!;
    if (set.has(t)) continue;
    const obj = repo.objects.get(t);
    if (!obj || obj.type !== OBJ_TREE) continue;
    set.add(t);
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000') stack.push(e.oid);
      else set.add(e.oid);
    }
  }
}

/** Add one commit + its tree/blobs only (no parents): a shallow-have's holdings. */
function addCommitShallow(repo: Repo, commitOid: string, set: Set<string>): void {
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== OBJ_COMMIT) return;
  set.add(commitOid);
  addTreeObjects(repo, parseCommit(obj.data).tree, set);
}

/** Full reachable closure of `oid` (commits + trees + blobs + tags). */
function addReachable(repo: Repo, oid: string, set: Set<string>): void {
  const stack: string[] = [oid];
  while (stack.length > 0) {
    const o = stack.pop()!;
    if (set.has(o)) continue;
    const obj = repo.objects.get(o);
    if (!obj) continue;
    set.add(o);
    if (obj.type === OBJ_COMMIT) {
      const c = parseCommit(obj.data);
      addTreeObjects(repo, c.tree, set);
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === OBJ_TAG) {
      const t = tagTarget(obj.data);
      if (t) stack.push(t);
    } else if (obj.type === OBJ_TREE) {
      addTreeObjects(repo, o, set);
    }
  }
}

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

export interface RefLine { name: string; oid: string }

export function sortedRefs(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/** Peel an annotated tag ref to its commit oid (one level; tags point at commits here). */
export function peelToCommit(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj) return null;
  if (obj.type === OBJ_TAG) {
    const t = tagTarget(obj.data);
    if (!t) return null;
    const target = repo.objects.get(t);
    if (target && target.type === OBJ_COMMIT) return t;
    return null;
  }
  if (obj.type === OBJ_COMMIT) return oid;
  return null;
}

const UPLOAD_CAPS = 'side-band-64k thin-pack ofs-delta multi_ack_detailed shallow symref=HEAD:refs/heads/main object-format=sha1 agent=forge/1.0';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main object-format=sha1 agent=forge/1.0';

/** v0 upload-pack advertisement body (without the `# service=` preamble). */
export function advertiseV0Upload(repo: Repo): Buffer {
  const refs = sortedRefs(repo);
  const lines: Buffer[] = [];
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${UPLOAD_CAPS}\n`));
  } else {
    const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? refs[0].oid;
    lines.push(pktLine(`${headTip} HEAD\0${UPLOAD_CAPS}\n`));
    for (const r of refs) {
      lines.push(pktLine(`${r.oid} ${r.name}\n`));
      if (r.name.startsWith('refs/tags/')) {
        const peeled = peelToCommit(repo, r.oid);
        if (peeled) lines.push(pktLine(`${peeled} ${r.name}^{}\n`));
      }
    }
  }
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

/** v0 receive-pack advertisement body (without the `# service=` preamble). */
export function advertiseV0Receive(repo: Repo): Buffer {
  const refs = sortedRefs(repo);
  const lines: Buffer[] = [];
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${RECEIVE_CAPS}\n`));
  } else {
    const first = refs[0];
    lines.push(pktLine(`${first.oid} ${first.name}\0${RECEIVE_CAPS}\n`));
    for (let i = 1; i < refs.length; i++) {
      lines.push(pktLine(`${refs[i].oid} ${refs[i].name}\n`));
    }
  }
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

/** v2 capability advertisement (info/refs answer to a `Git-Protocol: version=2` GET). Static: built once. */
const ADVERTISE_V2_BUF: Buffer = pktLines(['version 2\n', 'ls-refs=unborn\n', 'fetch=shallow filter\n', 'object-format=sha1\n']);
export function advertiseV2(): Buffer {
  return ADVERTISE_V2_BUF;
}

// ---------------------------------------------------------------------------
// pkt-line request parsing
// ---------------------------------------------------------------------------

export interface GitArgs {
  command: string | null;
  agent: string | null;
  objectFormat: string | null;
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
  thinPack: boolean;
  noProgress: boolean;
  ofsDelta: boolean;
  filter: string | null;
  wants: string[];
  haves: string[];
  shallows: string[];
  deepen: number | null;
  /** `deepen-relative`: deepen is relative to the client's current shallow depth. */
  deepenRelative: boolean;
  done: boolean;
}

function emptyArgs(): GitArgs {
  return {
    command: null, agent: null, objectFormat: null,
    peel: false, symrefs: false, unborn: false, prefixes: [],
    thinPack: false, noProgress: false, ofsDelta: false, filter: null,
    wants: [], haves: [], shallows: [], deepen: null, deepenRelative: false, done: false,
  };
}

/** Parse a v2 command request body (pkt-lines). Tolerates unknown lines. */
export function parseV2Request(body: Buffer): GitArgs | null {
  const { lines } = pktSplit(body);
  const args = emptyArgs();
  let sawCommand = false;
  for (const l of lines) {
    if (l === null) continue; // flush
    if (l.length === 1 && (l[0] === 1 || l[0] === 2)) continue; // delim / response-end
    const s = l.toString('utf8').trimEnd();
    if (s.startsWith('command=')) { args.command = s.slice(8); sawCommand = true; }
    else if (s.startsWith('agent=')) args.agent = s.slice(6);
    else if (s.startsWith('object-format=')) args.objectFormat = s.slice(14);
    else if (s === 'peel') args.peel = true;
    else if (s === 'symrefs') args.symrefs = true;
    else if (s === 'unborn') args.unborn = true;
    else if (s.startsWith('ref-prefix ')) args.prefixes.push(s.slice(11));
    else if (s === 'thin-pack') args.thinPack = true;
    else if (s === 'no-progress') args.noProgress = true;
    else if (s === 'ofs-delta') args.ofsDelta = true;
    else if (s.startsWith('filter ')) args.filter = s.slice(7);
    else if (s.startsWith('want ')) args.wants.push(s.slice(5).trim());
    else if (s.startsWith('have ')) args.haves.push(s.slice(5).trim());
    else if (s.startsWith('shallow ')) args.shallows.push(s.slice(8).trim());
    else if (s.startsWith('deepen ')) { const n = parseInt(s.slice(7), 10); if (Number.isFinite(n)) args.deepen = n; }
    else if (s === 'deepen-relative') args.deepenRelative = true;
    else if (s === 'done') args.done = true;
    // deepen-since / deepen-not / wait-for-done: not used by the suite; ignored.
  }
  if (!sawCommand) return null;
  return args;
}

/** Parse a v0 fetch request body: two sections (wants, then haves+done). */
export function parseV0Fetch(body: Buffer): GitArgs | null {
  const { lines } = pktSplit(body);
  const args = emptyArgs();
  args.command = 'fetch';
  let sawWant = false;
  for (const l of lines) {
    if (l === null) continue;
    if (l.length === 1 && (l[0] === 1 || l[0] === 2)) continue;
    const s = l.toString('utf8').trimEnd();
    // First want line carries capabilities after a space; the oid is the first token.
    if (s.startsWith('want ')) {
      sawWant = true;
      const rest = s.slice(5).trim();
      const oid = rest.split(/\s+/)[0];
      if (OID_RE.test(oid)) args.wants.push(oid);
      if (rest.includes('thin-pack')) args.thinPack = true;
      if (rest.includes('ofs-delta')) args.ofsDelta = true;
      if (rest.includes('no-progress')) args.noProgress = true;
    } else if (s.startsWith('have ')) args.haves.push(s.slice(5).trim());
    else if (s.startsWith('shallow ')) args.shallows.push(s.slice(8).trim());
    else if (s.startsWith('deepen ')) { const n = parseInt(s.slice(7), 10); if (Number.isFinite(n)) args.deepen = n; }
    else if (s === 'deepen-relative') args.deepenRelative = true;
    else if (s === 'done') args.done = true;
  }
  if (!sawWant) return null;
  return args;
}

// ---------------------------------------------------------------------------
// Fetch pack collection
// ---------------------------------------------------------------------------

export interface FetchPack {
  objects: PackEntry[];
  shallowOut: string[];
  unshallowOut: string[];
}

/**
 * Objects for a fetch: reachable(wants) within the deepen limit, minus what the
 * client already holds. `haves` are full holdings unless listed in `shallows`
 * (then only the commit + its tree/blobs, no parents).
 */
/** Add a have's holdings: full closure, but never descend past a shallow
 * commit. A shallow client holds a have's history only down to its shallow
 * boundary; treating a non-shallow have as holding its whole closure would
 * wrongly exclude the ancestors the client is asking to deepen into. */
function addHeld(repo: Repo, oid: string, shallowSet: Set<string>, held: Set<string>): void {
  const stack = [oid];
  while (stack.length > 0) {
    const o = stack.pop()!;
    if (held.has(o)) continue;
    const obj = repo.objects.get(o);
    if (!obj) continue;
    held.add(o);
    if (obj.type === OBJ_COMMIT) {
      addTreeObjects(repo, parseCommit(obj.data).tree, held);
      if (!shallowSet.has(o)) {
        for (const p of parseCommit(obj.data).parents) stack.push(p);
      }
    } else if (obj.type === OBJ_TAG) {
      const t = tagTarget(obj.data);
      if (t) stack.push(t);
    } else if (obj.type === OBJ_TREE) {
      addTreeObjects(repo, o, held);
    }
  }
}

export function collectFetchPack(repo: Repo, args: GitArgs): FetchPack {
  const shallowSet = new Set(args.shallows);
  const held = new Set<string>();
  for (const h of args.haves) addHeld(repo, h, shallowSet, held);
  for (const s of args.shallows) {
    if (!args.haves.includes(s)) addCommitShallow(repo, s, held);
  }

  // Effective depth limit. Absolute `deepen` is the number of commits from
  // each want. `deepen-relative` (real git's `--deepen`) adds to the client's
  // current shallow depth: depth(shallow oid from the nearest want) + 1.
  let D = args.deepen ?? Infinity;
  if (args.deepen !== null && args.deepenRelative && args.shallows.length > 0) {
    const dist = new Map<string, number>();
    const queue: Array<[string, number]> = args.wants.map((w) => [w, 0] as [string, number]);
    let current = 0;
    while (queue.length > 0) {
      const [oid, d] = queue.shift()!;
      const prev = dist.get(oid);
      if (prev !== undefined && prev <= d) continue;
      dist.set(oid, d);
      if (shallowSet.has(oid)) current = Math.max(current, d + 1);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== OBJ_COMMIT) continue;
      for (const p of parseCommit(obj.data).parents) queue.push([p, d + 1]);
    }
    D = current > 0 ? current + args.deepen : args.deepen;
  }

  const wanted = new Set<string>();
  const boundary = new Set<string>();
  const dist = new Map<string, number>();
  const queue: Array<[string, number]> = args.wants.map((w) => [w, 0] as [string, number]);
  while (queue.length > 0) {
    const [oid, d] = queue.shift()!;
    if (d >= D) continue;
    const prev = dist.get(oid);
    if (prev !== undefined && prev <= d) continue;
    dist.set(oid, d);
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === OBJ_TAG) {
      wanted.add(oid);
      const t = tagTarget(obj.data);
      if (t) queue.push([t, d]); // tags do not consume depth
      continue;
    }
    if (obj.type === OBJ_COMMIT) {
      wanted.add(oid);
      const c = parseCommit(obj.data);
      addTreeObjects(repo, c.tree, wanted);
      if (d === D - 1) {
        if (c.parents.length > 0) boundary.add(oid);
      } else {
        for (const p of c.parents) queue.push([p, d + 1]);
      }
      continue;
    }
    wanted.add(oid); // tree/blob want: include directly
  }

  const objects: PackEntry[] = [];
  for (const oid of wanted) {
    if (held.has(oid)) continue;
    const o = repo.objects.get(oid);
    if (!o) continue;
    objects.push({ oid, type: o.type, data: o.data });
  }
  const packSet = new Set(objects.map((o) => o.oid));
  const inPackOrHeld = (oid: string): boolean => packSet.has(oid) || held.has(oid);

  const shallowOut: string[] = [];
  // A boundary commit (walk stopped at the deepen limit) is shallow when it has
  // parents at all — regardless of whether a parent is already held by the
  // client (git lists the new tip as shallow in fetch-shallow-new-tip even
  // though its parent is held). The walk, not the holdings, decides.
  for (const b of boundary) {
    const obj = repo.objects.get(b);
    if (!obj || obj.type !== OBJ_COMMIT) continue;
    if (parseCommit(obj.data).parents.length > 0) shallowOut.push(b);
  }
  const unshallowOut: string[] = [];
  for (const s of args.shallows) {
    const obj = repo.objects.get(s);
    if (!obj || obj.type !== OBJ_COMMIT) continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.every((p) => inPackOrHeld(p))) unshallowOut.push(s);
  }
  return { objects, shallowOut, unshallowOut };
}

/** Wrap bytes into sideband band-1 pkt-lines (payload ≤ 65516, line ≤ 65520). */
export function sidebandWrap(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < data.length; off += CHUNK) {
    const chunk = data.subarray(off, Math.min(off + CHUNK, data.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// v2 handlers
// ---------------------------------------------------------------------------

/** v2 ls-refs response: ref lines + flush (no advertisement prefix). */
export function handleLsRefs(repo: Repo, args: GitArgs): Buffer {
  const lines: string[] = [];
  const refs = sortedRefs(repo);
  const filtered = args.prefixes.length === 0
    ? refs
    : refs.filter((r) => args.prefixes.some((p) => r.name.startsWith(p)));
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  // The HEAD line is a ref named "HEAD": include it when the prefix filter
  // matches it (clone asks for ref-prefix HEAD / refs/heads/ / refs/tags/).
  const headWanted = args.prefixes.length === 0 || args.prefixes.some((p) => 'HEAD'.startsWith(p));
  if (headWanted) {
    if (headTip) {
      lines.push(`${headTip} HEAD${args.symrefs ? ' symref-target:refs/heads/' + repo.defaultBranch : ''}\n`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    }
  }
  for (const r of filtered) {
    let line = `${r.oid} ${r.name}`;
    if (args.peel && r.name.startsWith('refs/tags/')) {
      const peeled = peelToCommit(repo, r.oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  return pktLines(lines);
}

/** v2 fetch response: optional acknowledgments, optional shallow-info, packfile. */
export function handleFetchV2(repo: Repo, args: GitArgs): Buffer {
  const parts: Buffer[] = [];
  // Two-phase negotiation (protocol v2): when the client sent haves without
  // `done` (real git does this when a `shallow` line is present), answer with
  // ONLY the acknowledgments section + flush. The client then sends a
  // follow-up request with `done`, and the packfile goes in that response.
  if (args.haves.length > 0 && !args.done) {
    const acks: string[] = [];
    for (const h of args.haves) {
      if (repo.objects.has(h)) acks.push(`ACK ${h}\n`);
    }
    if (acks.length === 0) acks.push('NAK\n');
    parts.push(pktLine('acknowledgments\n'));
    for (const a of acks) parts.push(pktLine(a));
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  const { objects, shallowOut, unshallowOut } = collectFetchPack(repo, args);
  if (args.deepen !== null && (shallowOut.length > 0 || unshallowOut.length > 0)) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of shallowOut) parts.push(pktLine(`shallow ${s}`)); // git: no trailing \n
    for (const s of unshallowOut) parts.push(pktLine(`unshallow ${s}`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandWrap(buildPack(objects)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** v0 fetch response: NAK/ACK + shallow lines, then the sideband pack. */
export function handleFetchV0(repo: Repo, args: GitArgs): Buffer {
  const parts: Buffer[] = [];
  const { objects, shallowOut, unshallowOut } = collectFetchPack(repo, args);
  const allHeld = args.wants.length > 0 && args.wants.every((w) => args.haves.includes(w));
  if (allHeld) {
    for (const w of args.wants) parts.push(pktLine(`ACK ${w}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const s of shallowOut) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of unshallowOut) parts.push(pktLine(`unshallow ${s}\n`));
  parts.push(sidebandWrap(buildPack(objects)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// receive-pack (push)
// ---------------------------------------------------------------------------

export interface PushCommand { oldOid: string; newOid: string; ref: string }

export interface PushResult {
  status: number;
  body: Buffer;
  contentType: string;
}

/** Parse the command list at the start of a receive-pack body; returns the
 *  commands and the offset where the raw pack begins. */
function parsePushCommands(body: Buffer): { commands: PushCommand[]; packOff: number } | null {
  const commands: PushCommand[] = [];
  let off = 0;
  while (off + 4 <= body.length) {
    const len = parseInt(body.subarray(off, off + 4).toString('ascii'), 16);
    if (Number.isNaN(len) || len < 0) return null;
    if (len === 0) { off += 4; break; } // flush: commands end, pack follows
    if (len < 4 || off + len > body.length) return null;
    const raw = body.subarray(off + 4, off + len).toString('utf8');
    const nul = raw.indexOf('\0');
    const line = (nul >= 0 ? raw.slice(0, nul) : raw).trimEnd();
    const parts = line.split(' ');
    if (parts.length !== 3) return null;
    const [oldOid, newOid, ref] = parts;
    if (!OID_RE.test(oldOid) || !OID_RE.test(newOid) || !ref.startsWith('refs/')) return null;
    commands.push({ oldOid, newOid, ref });
    off += len;
  }
  return { commands, packOff: off };
}

export function handleReceivePack(store: Store, repo: Repo, body: Buffer): PushResult {
  const ct = 'application/x-git-receive-pack-result';
  const parsed = parsePushCommands(body);
  if (!parsed) {
    const report = pktLines(['unpack error\n']);
    return { status: 200, body: Buffer.concat([sidebandWrap(report), PKT_FLUSH]), contentType: ct };
  }
  const { commands, packOff } = parsed;
  const reportLines: string[] = [];
  const packBytes = body.subarray(packOff);
  if (packBytes.length > 0) {
    try {
      // Thin packs delta against objects the server already holds; the
      // lookup reads the repo's map directly (no per-push copy).
      const lookup = (oid: string): PackEntry | undefined => {
        const o = repo.objects.get(oid);
        return o ? { oid, type: o.type, data: o.data } : undefined;
      };
      const entries = parsePack(packBytes, lookup);
      for (const e of entries) store.putObject(repo, e.type, e.data, e.oid);
      reportLines.push('unpack ok\n');
    } catch (err) {
      reportLines.push(`unpack ${(err as Error).message}\n`);
      for (const c of commands) reportLines.push(`ng ${c.ref} unpack failed\n`);
      const report = pktLines(reportLines);
      return { status: 200, body: Buffer.concat([sidebandWrap(report), PKT_FLUSH]), contentType: ct };
    }
  } else {
    reportLines.push('unpack ok\n');
  }

  for (const c of commands) {
    const current = repo.refs.get(c.ref);
    if (c.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        reportLines.push(`ng ${c.ref} remote ref does not exist\n`);
      } else if (c.oldOid !== ZERO_OID && c.oldOid !== current) {
        reportLines.push(`ng ${c.ref} non-fast-forward\n`);
      } else {
        repo.refs.delete(c.ref);
        reportLines.push(`ok ${c.ref}\n`);
      }
      continue;
    }
    if (!store.hasObject(repo, c.newOid)) {
      reportLines.push(`ng ${c.ref} object not found\n`);
      continue;
    }
    if (current === undefined) {
      // Create: old must be zero.
      if (c.oldOid !== ZERO_OID) {
        reportLines.push(`ng ${c.ref} non-fast-forward\n`);
      } else {
        repo.refs.set(c.ref, c.newOid);
        reportLines.push(`ok ${c.ref}\n`);
      }
      continue;
    }
    // Update: old must match, new must be a descendant of old (or equal).
    if (c.oldOid !== current) {
      reportLines.push(`ng ${c.ref} non-fast-forward\n`);
      continue;
    }
    if (c.newOid !== current && !store.isAncestor(repo, current, c.newOid)) {
      reportLines.push(`ng ${c.ref} non-fast-forward\n`);
      continue;
    }
    repo.refs.set(c.ref, c.newOid);
    reportLines.push(`ok ${c.ref}\n`);
  }

  const report = pktLines(reportLines);
  return { status: 200, body: Buffer.concat([sidebandWrap(report), PKT_FLUSH]), contentType: ct };
}

export { VIEWER };

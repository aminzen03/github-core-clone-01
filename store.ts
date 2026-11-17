// In-memory store for the forge. One process, one trial: no persistence needed.
// Determinism: every id/number is sequential, every timestamp comes from the trial
// clock (MAKEFUN_TRIAL_NOW), never from Date.now() or Math.random() — a replay of the
// same trial must see byte-identical state.

import {
  hashObject, parseTree, buildTree, parseCommit, buildCommit,
  OBJ_BLOB, OBJ_TREE, OBJ_COMMIT, OBJ_TAG, type GitObject,
} from './git.ts';

/** The scenario's deterministic viewer (SCENARIO_SEED is a compile-time constant in
 *  the sealed env, the same in every trial: practice and final). */
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
});

/** Trial clock: ISO timestamp every created/updated field carries. The env
 *  var is fixed for the process lifetime, so the value is computed once. */
let cachedNow: string | null = null;
export function trialNowIso(): string {
  if (cachedNow === null) {
    const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
    const ms = Date.parse(raw);
    cachedNow = Number.isFinite(ms) ? new Date(ms).toISOString() : '2025-01-01T00:00:00.000Z';
  }
  return cachedNow;
}

/** Opaque, deterministic global ids (GraphQL `id`): never the bare number. */
function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}
export function repoGlobalId(dbId: number): string { return `R_${b64url(`repo:${dbId}`)}`; }
export function issueGlobalId(repoDbId: number, number: number): string { return `I_${b64url(`issue:${repoDbId}:${number}`)}`; }
export function prGlobalId(repoDbId: number, number: number): string { return `P_${b64url(`pr:${repoDbId}:${number}`)}`; }
export function commentGlobalId(repoDbId: number, number: number, id: number): string { return `C_${b64url(`comment:${repoDbId}:${number}:${id}`)}`; }
export function userGlobalId(login: string): string { return `U_${b64url(`user:${login}`)}`; }

/** Decode an opaque global id back to its kind + parts. Returns null when malformed. */
export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  const m = /^([A-Z])_([A-Za-z0-9_-]+)$/.exec(id);
  if (!m) return null;
  try {
    const decoded = Buffer.from(m[2], 'base64url').toString('utf8');
    const [kind, ...parts] = decoded.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Repo {
  dbId: number;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  hasIssues: boolean;
  /** git objects: oid -> {type, data} */
  objects: Map<string, GitObject>;
  /** refs: full refname -> oid ('' means unborn/empty) */
  refs: Map<string, string>;
  labels: Map<string, { name: string; color: string; description: string }>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  /** shared issue+PR number sequence (GitHub behaviour) */
  nextNumber: number;
  nextCommentId: number;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  /** Stable REST id (distinct from `number`; the MCP rest-parity check reads it). */
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Comment {
  id: number;
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string;
}

export interface PullRequest {
  /** Stable REST id (distinct from `number`). */
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** file paths changed head-vs-base at creation (recomputed on read) */
  files: string[];
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class Store {
  repos = new Map<string, Repo>(); // key: `${owner}/${name}`
  nextRepoId = 1;
  nextIssueId = 1;
  nextPrId = 1;

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const r of this.repos.values()) {
      if (r.owner === owner) out.push(r);
    }
    out.sort((a, b) => a.dbId - b.dbId);
    return out;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean, defaultBranch: string): Repo | null {
    const key = this.repoKey(owner, name);
    if (this.repos.has(key)) return null;
    const now = trialNowIso();
    const repo: Repo = {
      dbId: this.nextRepoId,
      owner,
      name,
      fullName: key,
      description,
      private: isPrivate,
      defaultBranch,
      hasIssues: true,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  // -- git objects -----------------------------------------------------------

  putObject(repo: Repo, type: number, data: Buffer, oid?: string): string {
    const id = oid ?? hashObject(type, data);
    if (!repo.objects.has(id)) repo.objects.set(id, { type, data });
    return id;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  hasObject(repo: Repo, oid: string): boolean {
    return repo.objects.has(oid);
  }

  /** All ancestors of `tip` (inclusive), following parents. Returns oids in BFS order. */
  reachableCommits(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== OBJ_COMMIT) continue;
      out.push(oid);
      const c = parseCommit(obj.data);
      for (const p of c.parents) queue.push(p);
    }
    return out;
  }

  /** Is `ancestor` reachable from `tip` (or equal)? */
  isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (oid === ancestor) return true;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== OBJ_COMMIT) continue;
      for (const p of parseCommit(obj.data).parents) queue.push(p);
    }
    return false;
  }

  /** Merge-base of two commits (first common ancestor by BFS from both sides). */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    if (a === b) return a;
    const fromA = new Set<string>();
    const qa: string[] = [a];
    while (qa.length > 0) {
      const oid = qa.shift()!;
      if (fromA.has(oid)) continue;
      fromA.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== OBJ_COMMIT) continue;
      for (const p of parseCommit(obj.data).parents) qa.push(p);
    }
    const seen = new Set<string>();
    const qb: string[] = [b];
    while (qb.length > 0) {
      const oid = qb.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (fromA.has(oid)) return oid;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== OBJ_COMMIT) continue;
      for (const p of parseCommit(obj.data).parents) qb.push(p);
    }
    return null;
  }

  /** Flatten a tree (recursive) to path -> {oid, mode}. */
  flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.type !== OBJ_TREE) return out;
    for (const e of parseTree(obj.data)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') {
        for (const [p, v] of this.flattenTree(repo, e.oid, path)) out.set(p, v);
      } else {
        out.set(path, { oid: e.oid, mode: e.mode });
      }
    }
    return out;
  }

  /** Build a nested tree object from a flat path map; returns the tree oid. */
  buildTreeFromFlat(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
    // Group by top-level directory.
    const dirs = new Map<string, Map<string, { oid: string; mode: string }>>();
    const files: Array<{ name: string; oid: string; mode: string }> = [];
    for (const [path, v] of flat) {
      const slash = path.indexOf('/');
      if (slash < 0) {
        files.push({ name: path, oid: v.oid, mode: v.mode });
      } else {
        const dir = path.slice(0, slash);
        const rest = path.slice(slash + 1);
        let sub = dirs.get(dir);
        if (!sub) { sub = new Map(); dirs.set(dir, sub); }
        sub.set(rest, v);
      }
    }
    const entries: Array<{ mode: string; name: string; oid: string }> = [];
    for (const f of files) entries.push({ mode: f.mode, name: f.name, oid: f.oid });
    for (const [dir, sub] of dirs) {
      const subOid = this.buildTreeFromFlat(repo, sub);
      entries.push({ mode: '40000', name: dir, oid: subOid });
    }
    const data = buildTree(entries);
    return this.putObject(repo, OBJ_TREE, data);
  }

  /** Create a commit object; returns its oid. */
  makeCommit(repo: Repo, treeOid: string, parents: string[], message: string): string {
    const author = `${VIEWER.name} <${VIEWER.email}> ${Math.floor(Date.parse(trialNowIso()) / 1000)} +0000`;
    const msg = message.endsWith('\n') ? message : `${message}\n`;
    const data = buildCommit({
      tree: treeOid,
      parents,
      author,
      committer: author,
      message: msg,
    });
    return this.putObject(repo, OBJ_COMMIT, data);
  }

  // -- issues / PRs ----------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue | { error: string } {
    for (const l of labels) {
      if (!repo.labels.has(l)) return { error: `Label does not exist: ${l}` };
    }
    const now = trialNowIso();
    const issue: Issue = {
      id: this.nextIssueId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    this.nextIssueId += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  createPullRequest(repo: Repo, title: string, body: string, headRef: string, baseRef: string): PullRequest | { error: string } {
    const headOid = repo.refs.get(`refs/heads/${headRef}`);
    const baseOid = repo.refs.get(`refs/heads/${baseRef}`);
    if (!headOid) return { error: `head branch not found: ${headRef}` };
    if (!baseOid) return { error: `base branch not found: ${baseRef}` };
    const now = trialNowIso();
    const pr: PullRequest = {
      id: this.nextPrId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      merged: false,
      headRef,
      baseRef,
      headSha: headOid,
      baseSha: baseOid,
      mergeCommitSha: null,
      mergedAt: null,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      files: this.diffFiles(repo, baseOid, headOid),
    };
    this.nextPrId += 1;
    repo.nextNumber += 1;
    repo.pulls.set(pr.number, pr);
    return pr;
  }

  /** Files changed between base tip and head tip (via merge-base). */
  diffFiles(repo: Repo, baseTip: string, headTip: string): string[] {
    const mb = this.mergeBase(repo, baseTip, headTip) ?? baseTip;
    const baseTree = this.treeOf(repo, mb);
    const headTree = this.treeOf(repo, headTip);
    const baseFlat = baseTree ? this.flattenTree(repo, baseTree) : new Map();
    const headFlat = headTree ? this.flattenTree(repo, headTree) : new Map();
    const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
    const changed: string[] = [];
    for (const p of paths) {
      const b = baseFlat.get(p);
      const h = headFlat.get(p);
      if (!b || !h || b.oid !== h.oid) changed.push(p);
    }
    changed.sort();
    return changed;
  }

  treeOf(repo: Repo, commitOid: string): string | null {
    const obj = repo.objects.get(commitOid);
    if (!obj || obj.type !== OBJ_COMMIT) return null;
    return parseCommit(obj.data).tree;
  }

  /** Would a squash-merge of this PR conflict? (Dry run, no mutation.) */
  mergeConflict(repo: Repo, pr: PullRequest): boolean {
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
    const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
    if (!baseTip || !headTip) return false;
    const mb = this.mergeBase(repo, baseTip, headTip);
    const baseTree = this.treeOf(repo, baseTip);
    const headTree = this.treeOf(repo, headTip);
    const mbTree = mb ? this.treeOf(repo, mb) : null;
    const baseFlat = baseTree ? this.flattenTree(repo, baseTree) : new Map();
    const headFlat = headTree ? this.flattenTree(repo, headTree) : new Map();
    const mbFlat = mbTree ? this.flattenTree(repo, mbTree) : new Map();
    const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys(), ...mbFlat.keys()]);
    for (const p of paths) {
      const m = mbFlat.get(p);
      const b = baseFlat.get(p);
      const h = headFlat.get(p);
      const changedBase = (b?.oid ?? null) !== (m?.oid ?? null);
      const changedHead = (h?.oid ?? null) !== (m?.oid ?? null);
      if (changedBase && changedHead && (b?.oid ?? null) !== (h?.oid ?? null)) return true;
    }
    return false;
  }

  /** Squash-merge a PR. Returns {ok, sha} or {conflict} or {error}. */
  mergePullRequest(repo: Repo, pr: PullRequest): { ok: true; sha: string } | { conflict: true } | { error: string } {
    if (pr.state !== 'open') return { error: 'pull request is not open' };
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
    const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
    if (!baseTip || !headTip) return { error: 'branch tip missing' };
    if (this.mergeConflict(repo, pr)) return { conflict: true };
    const mb = this.mergeBase(repo, baseTip, headTip);
    const baseTree = this.treeOf(repo, baseTip);
    const headTree = this.treeOf(repo, headTip);
    const mbTree = mb ? this.treeOf(repo, mb) : null;
    const baseFlat = baseTree ? this.flattenTree(repo, baseTree) : new Map();
    const headFlat = headTree ? this.flattenTree(repo, headTree) : new Map();
    const mbFlat = mbTree ? this.flattenTree(repo, mbTree) : new Map();
    // Result: base tree overlaid with head's changes vs merge-base.
    const result = new Map<string, { oid: string; mode: string }>(baseFlat);
    for (const [p, h] of headFlat) {
      const m = mbFlat.get(p);
      if ((h.oid ?? null) !== (m?.oid ?? null)) result.set(p, h);
    }
    for (const [p, m] of mbFlat) {
      const h = headFlat.get(p);
      if (!h && (baseFlat.get(p)?.oid ?? null) === (m?.oid ?? null)) result.delete(p);
    }
    const newTree = this.buildTreeFromFlat(repo, result);
    const now = trialNowIso();
    const sha = this.makeCommit(repo, newTree, [baseTip], `Merge pull request #${pr.number} from ${pr.headRef}\n\n${pr.title}`);
    repo.refs.set(`refs/heads/${pr.baseRef}`, sha);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergeCommitSha = sha;
    pr.mergedAt = now;
    pr.updatedAt = now;
    pr.closedAt = now;
    return { ok: true, sha };
  }
}

export type { GitObject };
export { OBJ_BLOB, OBJ_TREE, OBJ_COMMIT, OBJ_TAG };

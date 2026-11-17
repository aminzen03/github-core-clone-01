// HTTP server: REST v3, GraphQL, MCP, git smart HTTP, and the /healthz probe.
// main.ts owns the lifecycle (bind 0, register, poll /done); this file is the
// server it serves. Every REST reply is application/json with a non-empty
// X-GitHub-Request-Id; errors are JSON {message} (never HTML).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, VIEWER, trialNowIso, type Repo, type Issue, type PullRequest } from './store.ts';
import { executeGraphQL, type GqlContext } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  advertiseV0Upload, advertiseV0Receive, advertiseV2,
  parseV2Request, parseV0Fetch, handleLsRefs, handleFetchV2, handleFetchV0,
  handleReceivePack,
} from './gitserver.ts';
import {
  pktLine, PKT_FLUSH, parseCommit, parseTree,
  OBJ_BLOB, OBJ_TREE, OBJ_COMMIT,
} from './git.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const buf = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': buf.length,
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(buf);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(body);
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': nextRequestId() });
  res.end();
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJson(body: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function hasAuth(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  const h = req.headers.authorization ?? '';
  return h === `Bearer ${TOKEN}`;
}

function errJson(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

// ---------------------------------------------------------------------------
// REST shapes
// ---------------------------------------------------------------------------

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: repo.hasIssues,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l, color: repo.labels.get(l)?.color ?? 'ededed' })),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
  };
}

function prJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    head: { ref: pr.headRef, sha: pr.headSha },
    base: { ref: pr.baseRef, sha: pr.baseSha },
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.closedAt,
  };
  if (pr.merged) {
    out.merged_at = pr.mergedAt;
    out.merge_commit_sha = pr.mergeCommitSha;
  }
  return out;
}

/** Paginate a list; returns the page and the Link header value (or ''). */
function paginate<T>(list: T[], url: URL, req: IncomingMessage): { page: T[]; link: string } {
  const perPage = Math.max(1, Math.min(100, parseInt(url.searchParams.get('per_page') ?? '30', 10) || 30));
  const pageNum = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const start = (pageNum - 1) * perPage;
  const page = list.slice(start, start + perPage);
  let link = '';
  if (start + perPage < list.length) {
    const host = req.headers.host ?? 'localhost';
    const proto = 'http';
    const next = new URL(url.pathname, `${proto}://${host}`);
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(pageNum + 1));
    link = `<${next.toString()}>; rel="next"`;
  }
  return { page, link };
}

// ---------------------------------------------------------------------------
// Git object helpers for contents / commits
// ---------------------------------------------------------------------------

function lookupPath(repo: Repo, treeOid: string, path: string): { type: 'blob' | 'tree'; oid: string; mode: string } | null {
  const segments = path.split('/').filter((s) => s.length > 0);
  let current = treeOid;
  for (let i = 0; i < segments.length; i++) {
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== OBJ_TREE) return null;
    const entries = parseTree(obj.data);
    const e = entries.find((x) => x.name === segments[i]);
    if (!e) return null;
    if (i === segments.length - 1) {
      return { type: e.mode === '40000' ? 'tree' : 'blob', oid: e.oid, mode: e.mode };
    }
    if (e.mode !== '40000') return null;
    current = e.oid;
  }
  return { type: 'tree', oid: current, mode: '40000' };
}

function listDir(repo: Repo, treeOid: string, prefix: string): Array<Record<string, unknown>> {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== OBJ_TREE) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const e of parseTree(obj.data)) {
    const p = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') {
      out.push({ type: 'dir', name: e.name, path: p, sha: e.oid });
    } else {
      const blob = repo.objects.get(e.oid);
      out.push({ type: 'file', name: e.name, path: p, sha: e.oid, size: blob ? blob.data.length : 0 });
    }
  }
  return out;
}

/** Commit a new tree on a branch; creates the branch if missing. */
function commitOnBranch(store: Store, repo: Repo, branch: string, treeOid: string, message: string, parents: string[]): string {
  const sha = store.makeCommit(repo, treeOid, parents, message);
  repo.refs.set(`refs/heads/${branch}`, sha);
  return sha;
}

function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const oldCount = new Map<string, number>();
  for (const l of oldLines) oldCount.set(l, (oldCount.get(l) ?? 0) + 1);
  let additions = 0;
  for (const l of newLines) {
    const c = oldCount.get(l) ?? 0;
    if (c > 0) oldCount.set(l, c - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const c of oldCount.values()) deletions += c;
  return { additions, deletions };
}

// ---------------------------------------------------------------------------
// REST handler
// ---------------------------------------------------------------------------

type Ctx = { store: Store };

function repoOrNull(store: Store, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return store.getRepo(owner, name) ?? null;
}

async function handleRest(ctx: Ctx, req: IncomingMessage, res: ServerResponse, url: URL, segs: string[]): Promise<boolean> {
  const method = req.method ?? 'GET';
  const store = ctx.store;

  // Root / meta: no auth expected beyond the scopes header on root.
  if (segs.length === 2 && segs[0] === 'api' && segs[1] === 'v3') {
    if (method === 'GET' && (url.pathname === '/api/v3' || url.pathname === '/api/v3/')) {
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return true;
    }
    return false;
  }
  if (method === 'GET' && url.pathname === '/api/v3/meta') {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }

  if (!hasAuth(req)) {
    errJson(res, 401, 'Requires authentication');
    return true;
  }

  // GET /api/v3/user
  if (method === 'GET' && segs.length === 3 && segs[0] === 'api' && segs[1] === 'v3' && segs[2] === 'user') {
    sendJson(res, 200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
    return true;
  }

  // POST /api/v3/user/repos  |  GET /api/v3/user/repos
  if (segs.length === 4 && segs[0] === 'api' && segs[1] === 'v3' && segs[2] === 'user' && segs[3] === 'repos') {
    if (method === 'POST') {
      const body = await readBody(req);
      const parsed = parseJson(body);
      if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return true; }
      const b = (parsed.value ?? {}) as Record<string, unknown>;
      const name = typeof b.name === 'string' ? b.name : '';
      if (!name || !OWNER_RE.test(name)) { errJson(res, 422, 'Invalid repository name'); return true; }
      const repo = store.createRepo(
        VIEWER.login, name,
        typeof b.description === 'string' ? b.description : '',
        b.private === true,
        'main',
      );
      if (!repo) { errJson(res, 422, 'Repository already exists'); return true; }
      sendJson(res, 201, repoJson(repo));
      return true;
    }
    if (method === 'GET') {
      const list = store.listRepos(VIEWER.login);
      const { page, link } = paginate(list, url, req);
      sendJson(res, 200, page.map(repoJson), link ? { link } : {});
      return true;
    }
    return false;
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (segs.length >= 5 && segs[0] === 'api' && segs[1] === 'v3' && segs[2] === 'repos') {
    const owner = segs[3];
    const repoName = segs[4];
    const repo = repoOrNull(store, owner, repoName);
    const rest = segs.slice(5);

    // GET /repos/{o}/{r} | PATCH | DELETE
    if (rest.length === 0) {
      if (method === 'GET') {
        if (!repo) { errJson(res, 404, 'Not Found'); return true; }
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'PATCH') {
        if (!repo) { errJson(res, 404, 'Not Found'); return true; }
        const body = await readBody(req);
        const parsed = parseJson(body);
        if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return true; }
        const b = (parsed.value ?? {}) as Record<string, unknown>;
        if (typeof b.description === 'string') repo.description = b.description;
        if (typeof b.default_branch === 'string' && b.default_branch) repo.defaultBranch = b.default_branch;
        repo.updatedAt = trialNowIso();
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        if (!repo) { errJson(res, 404, 'Not Found'); return true; }
        store.deleteRepo(owner, repoName);
        sendEmpty(res, 204);
        return true;
      }
      return false;
    }

    if (!repo) { errJson(res, 404, 'Not Found'); return true; }

    // POST /git/refs | GET /git/refs/heads/{branch}
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const body = await readBody(req);
        const parsed = parseJson(body);
        if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return true; }
        const b = (parsed.value ?? {}) as Record<string, unknown>;
        const ref = typeof b.ref === 'string' ? b.ref : '';
        const sha = typeof b.sha === 'string' ? b.sha : '';
        if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha) || !store.hasObject(repo, sha)) {
          errJson(res, 422, 'Invalid ref or sha');
          return true;
        }
        if (repo.refs.has(ref)) { errJson(res, 422, 'Reference already exists'); return true; }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha } });
        return true;
      }
      if (method === 'GET' && rest.length === 4 && rest[2] === 'heads') {
        const sha = repo.refs.get(`refs/heads/${rest[3]}`);
        if (!sha) { errJson(res, 404, 'Not Found'); return true; }
        sendJson(res, 200, { ref: `refs/heads/${rest[3]}`, object: { sha } });
        return true;
      }
      return false;
    }

    // GET /branches | GET /branches/{branch}
    if (rest[0] === 'branches') {
      if (method === 'GET' && rest.length === 1) {
        const out = [...repo.refs.entries()]
          .filter(([n]) => n.startsWith('refs/heads/'))
          .map(([n, sha]) => ({ name: n.slice('refs/heads/'.length), commit: { sha }, protected: false }));
        sendJson(res, 200, out);
        return true;
      }
      if (method === 'GET' && rest.length === 2) {
        const sha = repo.refs.get(`refs/heads/${rest[1]}`);
        if (!sha) { errJson(res, 404, 'Not Found'); return true; }
        sendJson(res, 200, { name: rest[1], commit: { sha }, protected: false });
        return true;
      }
      return false;
    }

    // GET /commits
    if (rest[0] === 'commits' && method === 'GET' && rest.length === 1) {
      const shaParam = url.searchParams.get('sha');
      let tip: string | undefined;
      if (shaParam) {
        tip = repo.refs.get(`refs/heads/${shaParam}`) ?? (/^[0-9a-f]{40}$/.test(shaParam) ? shaParam : undefined);
      } else {
        tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      }
      const out: Array<Record<string, unknown>> = [];
      if (tip) {
        const seen = new Set<string>();
        let cur: string | undefined = tip;
        while (cur && !seen.has(cur)) {
          seen.add(cur);
          const obj = repo.objects.get(cur);
          if (!obj || obj.type !== OBJ_COMMIT) break;
          const c = parseCommit(obj.data);
          out.push({
            sha: cur,
            commit: {
              // GitHub's API presents the message without the trailing
              // newline the git object carries; the suite compares exactly.
              message: c.message.replace(/\n+$/, ''),
              author: { name: VIEWER.name, email: VIEWER.email },
              committer: { name: VIEWER.name, email: VIEWER.email },
            },
          });
          cur = c.parents[0];
        }
      }
      sendJson(res, 200, out);
      return true;
    }

    // /contents/{path...}
    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      if (method === 'PUT') {
        const body = await readBody(req);
        const parsed = parseJson(body);
        if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return true; }
        const b = (parsed.value ?? {}) as Record<string, unknown>;
        const message = typeof b.message === 'string' ? b.message : 'Update file';
        const contentB64 = typeof b.content === 'string' ? b.content : '';
        let content: Buffer;
        try {
          content = Buffer.from(contentB64.replace(/[\r\n\t ]/g, ''), 'base64');
        } catch {
          errJson(res, 400, 'Invalid base64 content');
          return true;
        }
        const branch = typeof b.branch === 'string' && b.branch ? b.branch : repo.defaultBranch;
        let branchTip = repo.refs.get(`refs/heads/${branch}`);
        if (!branchTip) {
          // New branch from the default branch tip (or unborn).
          branchTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        }
        const baseTree = branchTip ? store.treeOf(repo, branchTip) : null;
        const baseFlat = baseTree ? store.flattenTree(repo, baseTree) : new Map<string, { oid: string; mode: string }>();
        const existed = baseFlat.has(path);
        if (typeof b.sha === 'string' && b.sha) {
          const cur = baseFlat.get(path);
          if (!cur || cur.oid !== b.sha) { errJson(res, 409, 'Conflict: sha does not match'); return true; }
        }
        const blobOid = store.putObject(repo, OBJ_BLOB, content);
        const flat = new Map(baseFlat);
        flat.set(path, { oid: blobOid, mode: '100644' });
        const newTree = store.buildTreeFromFlat(repo, flat);
        const commitSha = commitOnBranch(store, repo, branch, newTree, message, branchTip ? [branchTip] : []);
        sendJson(res, existed ? 200 : 201, {
          content: { name: path.split('/').pop() ?? '', path, sha: blobOid, size: content.length, type: 'file', encoding: 'base64' },
          commit: { sha: commitSha },
        });
        return true;
      }
      if (method === 'GET') {
        const refParam = url.searchParams.get('ref');
        const branch = refParam ?? repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (!tip) { errJson(res, 404, 'Not Found'); return true; }
        const treeOid = store.treeOf(repo, tip);
        if (!treeOid) { errJson(res, 404, 'Not Found'); return true; }
        if (path === '') {
          sendJson(res, 200, listDir(repo, treeOid, ''));
          return true;
        }
        const found = lookupPath(repo, treeOid, path);
        if (!found) { errJson(res, 404, 'Not Found'); return true; }
        if (found.type === 'tree') {
          sendJson(res, 200, listDir(repo, found.oid, path));
          return true;
        }
        const blob = repo.objects.get(found.oid);
        if (!blob) { errJson(res, 404, 'Not Found'); return true; }
        sendJson(res, 200, {
          type: 'file',
          name: path.split('/').pop() ?? '',
          path,
          sha: found.oid,
          size: blob.data.length,
          encoding: 'base64',
          content: blob.data.toString('base64'),
        });
        return true;
      }
      if (method === 'DELETE') {
        const body = await readBody(req);
        const parsed = parseJson(body);
        if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return true; }
        const b = (parsed.value ?? {}) as Record<string, unknown>;
        const message = typeof b.message === 'string' ? b.message : 'Delete file';
        const branch = typeof b.branch === 'string' && b.branch ? b.branch : repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (!tip) { errJson(res, 404, 'Not Found'); return true; }
        const treeOid = store.treeOf(repo, tip);
        if (!treeOid) { errJson(res, 404, 'Not Found'); return true; }
        const flat = store.flattenTree(repo, treeOid);
        const cur = flat.get(path);
        if (!cur) { errJson(res, 404, 'Not Found'); return true; }
        if (typeof b.sha === 'string' && b.sha && cur.oid !== b.sha) {
          errJson(res, 409, 'Conflict: sha does not match');
          return true;
        }
        flat.delete(path);
        const newTree = store.buildTreeFromFlat(repo, flat);
        const commitSha = commitOnBranch(store, repo, branch, newTree, message, [tip]);
        sendJson(res, 200, { commit: { sha: commitSha } });
        return true;
      }
      return false;
    }

    // POST /labels
    if (rest[0] === 'labels' && method === 'POST' && rest.length === 1) {
      const body = await readBody(req);
      const parsed = parseJson(body);
      if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return true; }
      const b = (parsed.value ?? {}) as Record<string, unknown>;
      const name = typeof b.name === 'string' ? b.name : '';
      if (!name) { errJson(res, 422, 'Invalid label name'); return true; }
      const color = typeof b.color === 'string' ? b.color : 'ededed';
      repo.labels.set(name, { name, color, description: typeof b.description === 'string' ? b.description : '' });
      sendJson(res, 201, { name, color, description: '' });
      return true;
    }

    // /issues...
    if (rest[0] === 'issues') {
      if (method === 'POST' && rest.length === 1) {
        const body = await readBody(req);
        const parsed = parseJson(body);
        if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return true; }
        const b = (parsed.value ?? {}) as Record<string, unknown>;
        const labels = Array.isArray(b.labels) ? (b.labels as unknown[]).map(String) : [];
        const res2 = store.createIssue(repo, String(b.title ?? ''), String(b.body ?? ''), labels);
        if ('error' in res2) { errJson(res, 422, res2.error); return true; }
        sendJson(res, 201, issueJson(repo, res2));
        return true;
      }
      if (method === 'GET' && rest.length === 1) {
        const state = (url.searchParams.get('state') ?? 'open').toLowerCase();
        const sort = url.searchParams.get('sort') ?? 'created';
        const direction = (url.searchParams.get('direction') ?? 'desc').toLowerCase();
        let list = [...repo.issues.values()];
        if (state !== 'all') list = list.filter((i) => i.state === state);
        if (sort === 'created') {
          list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        }
        const { page, link } = paginate(list, url, req);
        sendJson(res, 200, page.map((i) => issueJson(repo, i)), link ? { link } : {});
        return true;
      }
      if (rest.length >= 2) {
        const num = parseInt(rest[1], 10);
        if (!Number.isFinite(num)) return false;
        const issue = repo.issues.get(num);
        if (rest.length === 2) {
          if (method === 'GET') {
            if (!issue) { errJson(res, 404, 'Not Found'); return true; }
            sendJson(res, 200, issueJson(repo, issue));
            return true;
          }
          if (method === 'PATCH') {
            if (!issue) { errJson(res, 404, 'Not Found'); return true; }
            const body = await readBody(req);
            const parsed = parseJson(body);
            if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return true; }
            const b = (parsed.value ?? {}) as Record<string, unknown>;
            if (b.state === 'open' || b.state === 'closed') {
              issue.state = b.state;
              issue.closedAt = b.state === 'closed' ? trialNowIso() : null;
            }
            if (typeof b.title === 'string') issue.title = b.title;
            if (typeof b.body === 'string') issue.body = b.body;
            issue.updatedAt = trialNowIso();
            sendJson(res, 200, issueJson(repo, issue));
            return true;
          }
          return false;
        }
        if (rest.length === 3 && rest[2] === 'comments') {
          if (!issue) { errJson(res, 404, 'Not Found'); return true; }
          if (method === 'POST') {
            const body = await readBody(req);
            const parsed = parseJson(body);
            if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return true; }
            const b = (parsed.value ?? {}) as Record<string, unknown>;
            const comment = {
              id: repo.nextCommentId,
              body: String(b.body ?? ''),
              author: VIEWER.login,
              createdAt: trialNowIso(),
              updatedAt: trialNowIso(),
            };
            repo.nextCommentId += 1;
            issue.comments.push(comment);
            sendJson(res, 201, { id: comment.id, body: comment.body, created_at: comment.createdAt, updated_at: comment.updatedAt });
            return true;
          }
          if (method === 'GET') {
            sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body, created_at: c.createdAt, updated_at: c.updatedAt })));
            return true;
          }
          return false;
        }
      }
      return false;
    }

    // /pulls...
    if (rest[0] === 'pulls') {
      if (method === 'POST' && rest.length === 1) {
        const body = await readBody(req);
        const parsed = parseJson(body);
        if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return true; }
        const b = (parsed.value ?? {}) as Record<string, unknown>;
        const res2 = store.createPullRequest(
          repo,
          String(b.title ?? ''),
          String(b.body ?? ''),
          String(b.head ?? ''),
          String(b.base ?? ''),
        );
        if ('error' in res2) { errJson(res, 422, res2.error); return true; }
        sendJson(res, 201, prJson(repo, res2));
        return true;
      }
      if (method === 'GET' && rest.length === 1) {
        const state = (url.searchParams.get('state') ?? 'open').toLowerCase();
        let list = [...repo.pulls.values()];
        if (state !== 'all') list = list.filter((p) => p.state === state);
        list.sort((a, b) => a.number - b.number);
        const { page, link } = paginate(list, url, req);
        sendJson(res, 200, page.map((p) => prJson(repo, p)), link ? { link } : {});
        return true;
      }
      if (rest.length >= 2) {
        const num = parseInt(rest[1], 10);
        if (!Number.isFinite(num)) return false;
        const pr = repo.pulls.get(num);
        if (rest.length === 2) {
          if (method === 'GET') {
            if (!pr) { errJson(res, 404, 'Not Found'); return true; }
            sendJson(res, 200, prJson(repo, pr));
            return true;
          }
          return false;
        }
        if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
          if (!pr) { errJson(res, 404, 'Not Found'); return true; }
          const files = prFilesDetail(store, repo, pr);
          sendJson(res, 200, files);
          return true;
        }
        if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
          if (!pr) { errJson(res, 404, 'Not Found'); return true; }
          if (pr.state !== 'open') { errJson(res, 405, 'Pull request is not open'); return true; }
          const body = await readBody(req);
          const parsed = parseJson(body);
          if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return true; }
          const res2 = store.mergePullRequest(repo, pr);
          if ('conflict' in res2) { errJson(res, 405, 'Merge conflict'); return true; }
          if ('error' in res2) { errJson(res, 405, res2.error); return true; }
          sendJson(res, 200, {
            merged: true,
            sha: res2.sha,
            message: `Merge pull request #${pr.number} from ${pr.headRef}`,
          });
          return true;
        }
      }
      return false;
    }

    return false;
  }

  return false;
}

/** PR file details: filename, status, additions, deletions, changes. */
function prFilesDetail(store: Store, repo: Repo, pr: PullRequest): Array<Record<string, unknown>> {
  const mb = store.mergeBase(repo, pr.baseSha, pr.headSha);
  const baseTree = mb ? store.treeOf(repo, mb) : null;
  const headTree = store.treeOf(repo, pr.headSha);
  const baseFlat = baseTree ? store.flattenTree(repo, baseTree) : new Map();
  const headFlat = headTree ? store.flattenTree(repo, headTree) : new Map();
  const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
  const out: Array<Record<string, unknown>> = [];
  for (const p of [...paths].sort()) {
    const b = baseFlat.get(p);
    const h = headFlat.get(p);
    if (!b && h) {
      const blob = repo.objects.get(h.oid);
      const text = blob ? blob.data.toString('utf8') : '';
      const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      out.push({ filename: p, status: 'added', additions: Math.max(1, lines), deletions: 0, changes: Math.max(1, lines) });
    } else if (b && !h) {
      const blob = repo.objects.get(b.oid);
      const text = blob ? blob.data.toString('utf8') : '';
      const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      out.push({ filename: p, status: 'removed', additions: 0, deletions: lines, changes: lines });
    } else if (b && h && b.oid !== h.oid) {
      const oldBlob = repo.objects.get(b.oid);
      const newBlob = repo.objects.get(h.oid);
      const { additions, deletions } = lineDiff(
        oldBlob ? oldBlob.data.toString('utf8') : '',
        newBlob ? newBlob.data.toString('utf8') : '',
      );
      out.push({ filename: p, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Git smart HTTP
// ---------------------------------------------------------------------------

async function handleGit(store: Store, req: IncomingMessage, res: ServerResponse, url: URL, segs: string[]): Promise<boolean> {
  const method = req.method ?? 'GET';
  // /{owner}/{repo}.git/info/refs | /{owner}/{repo}.git/git-upload-pack | .../git-receive-pack
  if (segs.length < 3) return false;
  const owner = segs[0];
  const repoSeg = segs[1];
  if (!repoSeg.endsWith('.git')) return false;
  const repoName = repoSeg.slice(0, -4);
  if (!OWNER_RE.test(owner) || !OWNER_RE.test(repoName)) return false;
  const tail = segs.slice(2);
  if (tail[0] !== 'info' && tail[0] !== 'git-upload-pack' && tail[0] !== 'git-receive-pack') return false;

  if (!hasAuth(req)) {
    errJson(res, 401, 'Requires authentication');
    return true;
  }
  const repo = repoOrNull(store, owner, repoName);
  if (!repo) {
    // Unknown repo: 404 on both services (info/refs and POSTs).
    errJson(res, 404, 'Not Found');
    return true;
  }

  if (method === 'GET' && tail[0] === 'info' && tail[1] === 'refs') {
    const service = url.searchParams.get('service');
    if (service === 'git-upload-pack') {
      if ((req.headers['git-protocol'] ?? '') === 'version=2') {
        sendRaw(res, 200, advertiseV2(), 'application/x-git-upload-pack-advertisement');
      } else {
        sendRaw(
          res, 200,
          Buffer.concat([pktLine('# service=git-upload-pack\n'), PKT_FLUSH, advertiseV0Upload(repo)]),
          'application/x-git-upload-pack-advertisement',
        );
      }
      return true;
    }
    if (service === 'git-receive-pack') {
      sendRaw(
        res, 200,
        Buffer.concat([pktLine('# service=git-receive-pack\n'), PKT_FLUSH, advertiseV0Receive(repo)]),
        'application/x-git-receive-pack-advertisement',
      );
      return true;
    }
    errJson(res, 400, 'Missing service parameter');
    return true;
  }

  if (method === 'POST' && tail[0] === 'git-upload-pack') {
    const body = await readBody(req);
    const v2 = parseV2Request(body);
    if (v2 && v2.command === 'ls-refs') {
      sendRaw(res, 200, handleLsRefs(repo, v2), 'application/x-git-upload-pack-result');
      return true;
    }
    if (v2 && v2.command === 'fetch') {
      sendRaw(res, 200, handleFetchV2(repo, v2), 'application/x-git-upload-pack-result');
      return true;
    }
    // v0 fetch: first pkt-line is `want ...`.
    const v0 = parseV0Fetch(body);
    if (v0) {
      sendRaw(res, 200, handleFetchV0(repo, v0), 'application/x-git-upload-pack-result');
      return true;
    }
    errJson(res, 400, 'Bad request');
    return true;
  }

  if (method === 'POST' && tail[0] === 'git-receive-pack') {
    const body = await readBody(req);
    const result = handleReceivePack(store, repo, body);
    sendRaw(res, result.status, result.body, result.contentType);
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function decodeSeg(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store();
  const gqlCtx: GqlContext = { store };

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const segs = url.pathname.split('/').filter((s) => s.length > 0).map(decodeSeg);
        const method = req.method ?? 'GET';

        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && url.pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        if (segs.length >= 2 && segs[1].endsWith('.git')) {
          if (await handleGit(store, req, res, url, segs)) return;
          errJson(res, 404, 'Not Found');
          return;
        }

        // GraphQL.
        if (url.pathname === '/api/graphql') {
          if (method !== 'POST') { errJson(res, 405, 'Method Not Allowed'); return; }
          if (!hasAuth(req)) { errJson(res, 401, 'Requires authentication'); return; }
          const body = await readBody(req);
          const parsed = parseJson(body);
          if (!parsed.ok) {
            sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
            return;
          }
          const out = executeGraphQL(parsed.value, gqlCtx);
          sendJson(res, 200, out);
          return;
        }

        // MCP.
        if (url.pathname === '/mcp') {
          if (method === 'DELETE') { sendEmpty(res, 204); return; }
          if (method !== 'POST') { errJson(res, 405, 'Method Not Allowed'); return; }
          if (!hasAuth(req)) { errJson(res, 401, 'Requires authentication'); return; }
          const body = await readBody(req);
          const result = handleMcp(store, body);
          if (result.body === null) {
            sendEmpty(res, result.httpStatus);
            return;
          }
          const extra = result.headers ?? {};
          sendJson(res, result.httpStatus, result.body, extra);
          return;
        }

        // REST v3.
        if (segs.length >= 2 && segs[0] === 'api' && segs[1] === 'v3') {
          if (await handleRest({ store }, req, res, url, segs)) return;
          errJson(res, 404, 'Not Found');
          return;
        }

        // Everything else: GitHub's 404 body.
        errJson(res, 404, 'Not Found');
      } catch (err) {
        try {
          errJson(res, 500, (err as Error).message);
        } catch {
          // Response already gone; nothing to do.
        }
      }
    })();
  });
}

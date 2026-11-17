// MCP (Model Context Protocol) over Streamable HTTP: POST /mcp, JSON-RPC 2.0.
// Modern era preferred: `server/discover` answers supportedVersions including
// 2026-07-28 (no handshake/session). Legacy `initialize` +
// `notifications/initialized` also works. Auth is per-request (a call without
// Authorization gets HTTP 401). Tool results carry BOTH text and
// structuredContent — the suite matches on the text. `required` is kept to
// exactly the documented fields (any extra required property the suite cannot
// fill fails the check before the call).

import { Store, VIEWER, repoGlobalId, issueGlobalId, prGlobalId, type Repo } from './store.ts';

const SERVER_NAME = 'git-forge';
const SERVER_VERSION = '1.0.0';
const MODERN_VERSION = '2026-07-28';
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
  aliases: string[];
}

export const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'Owner login (defaults to the viewer).' },
      },
      required: ['name'],
    },
    aliases: ['create_repository', 'repo_create', 'repos_create', 'repository_create'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['owner', 'repo'],
    },
    aliases: ['get_repository', 'repo_get', 'repos_get', 'repository_get'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
    aliases: ['issue_create', 'issues_create'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
    aliases: ['issues_list', 'issue_list'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
        body: { type: 'string', description: 'Pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    aliases: ['pull_request_create', 'pulls_create', 'create_pr', 'pr_create'],
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    aliases: ['pull_request_merge', 'pulls_merge', 'merge_pr', 'pr_merge'],
  },
];

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findTool(name: string): ToolDef | null {
  const n = normalizeName(name);
  for (const t of TOOLS) if (normalizeName(t.name) === n) return t;
  for (const t of TOOLS) {
    if (t.aliases.some((a) => normalizeName(a) === n)) return t;
    if (normalizeName(t.name).endsWith(n) || n.endsWith(normalizeName(t.name))) return t;
  }
  return null;
}

export function toolListResult(): unknown {
  return {
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: repo.hasIssues,
  };
}

function issueJson(repo: Repo, issue: Repo['issues'] extends Map<number, infer I> ? I : never): Record<string, unknown> {
  return {
    id: issueGlobalId(repo.dbId, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l })),
  };
}

function prJson(repo: Repo, pr: Repo['pulls'] extends Map<number, infer P> ? P : never): Record<string, unknown> {
  return {
    id: prGlobalId(repo.dbId, pr.number),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    head: { ref: pr.headRef, sha: pr.headSha },
    base: { ref: pr.baseRef, sha: pr.baseSha },
  };
}

type ToolOutcome =
  | { ok: true; result: unknown }
  | { ok: false; message: string };

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolOutcome {
  const tool = findTool(name);
  if (!tool) return { ok: false, message: `Unknown tool: ${name}` };
  // Missing required arguments -> isError result (never a silent success).
  for (const req of tool.inputSchema.required) {
    if (args[req] === undefined || args[req] === null || args[req] === '') {
      return { ok: false, message: `Missing required argument: ${req}` };
    }
  }
  switch (tool.name) {
    case 'create_repo': {
      const repoName = String(args.name);
      const existing = store.getRepo(VIEWER.login, repoName);
      if (existing) return { ok: true, result: repoJson(existing) };
      const repo = store.createRepo(
        VIEWER.login,
        repoName,
        String(args.description ?? ''),
        args.private === true,
        'main',
      );
      if (!repo) return { ok: false, message: `Repository already exists: ${repoName}` };
      return { ok: true, result: repoJson(repo) };
    }
    case 'get_repo': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return { ok: false, message: `Repository not found: ${args.owner}/${args.repo}` };
      return { ok: true, result: repoJson(repo) };
    }
    case 'create_issue': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return { ok: false, message: `Repository not found: ${args.owner}/${args.repo}` };
      const res = store.createIssue(repo, String(args.title), String(args.body ?? ''), []);
      if ('error' in res) return { ok: false, message: res.error };
      return { ok: true, result: issueJson(repo, res) };
    }
    case 'list_issues': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return { ok: false, message: `Repository not found: ${args.owner}/${args.repo}` };
      const state = String(args.state ?? 'open').toLowerCase();
      const list = [...repo.issues.values()]
        .filter((i) => state === 'all' || i.state === state)
        .sort((a, b) => a.number - b.number);
      return { ok: true, result: { issues: list.map((i) => issueJson(repo, i)) } };
    }
    case 'create_pull_request': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return { ok: false, message: `Repository not found: ${args.owner}/${args.repo}` };
      const res = store.createPullRequest(
        repo,
        String(args.title),
        String(args.body ?? ''),
        String(args.head),
        String(args.base),
      );
      if ('error' in res) return { ok: false, message: res.error };
      return { ok: true, result: prJson(repo, res) };
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return { ok: false, message: `Repository not found: ${args.owner}/${args.repo}` };
      const pr = repo.pulls.get(Number(args.pull_number));
      if (!pr) return { ok: false, message: `Pull request not found: ${args.pull_number}` };
      const res = store.mergePullRequest(repo, pr);
      if ('conflict' in res) return { ok: false, message: 'Merge conflict' };
      if ('error' in res) return { ok: false, message: res.error };
      return { ok: true, result: { merged: true, sha: res.sha, number: pr.number, state: 'closed', pull_number: pr.number } };
    }
    default:
      return { ok: false, message: `Unknown tool: ${name}` };
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC dispatch. Returns {httpStatus, body} — body null means "no reply"
// (JSON-RPC notifications get no response).
// ---------------------------------------------------------------------------

export interface McpResponse { httpStatus: number; body: unknown; headers?: Record<string, string> }

function rpcResult(id: unknown, result: unknown): McpResponse {
  return { httpStatus: 200, body: { jsonrpc: '2.0', id, result } };
}

function rpcError(id: unknown, code: number, message: string): McpResponse {
  return { httpStatus: 200, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

export function handleMcp(store: Store, rawBody: Buffer): McpResponse {
  let msg: unknown;
  try {
    msg = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return {
      httpStatus: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  const req = (msg ?? {}) as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  if (typeof req.method !== 'string') {
    return rpcError(req.id ?? null, -32600, 'Invalid Request');
  }
  const id = req.id ?? null;
  const params = (req.params ?? {}) as Record<string, unknown>;
  const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };

  switch (req.method) {
    case 'server/discover': {
      const result = {
        supportedVersions: [MODERN_VERSION, ...LEGACY_VERSIONS],
        capabilities: { tools: {} },
        serverInfo,
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      };
      return rpcResult(id, result);
    }
    case 'initialize': {
      const offered = (params as { protocolVersion?: unknown }).protocolVersion;
      const version = typeof offered === 'string' && LEGACY_VERSIONS.includes(offered) ? offered : LEGACY_VERSIONS[0];
      return {
        httpStatus: 200,
        body: {
          jsonrpc: '2.0',
          id,
          result: { protocolVersion: version, capabilities: { tools: {} }, serverInfo },
        },
        headers: { 'mcp-session-id': 'forge-session-1' },
      };
    }
    case 'notifications/initialized':
      // Notification: no reply.
      return { httpStatus: 202, body: null };
    case 'tools/list':
      return rpcResult(id, toolListResult());
    case 'tools/call': {
      const name = String((params as { name?: unknown }).name ?? '');
      const args = ((params as { arguments?: unknown }).arguments ?? {}) as Record<string, unknown>;
      const tool = findTool(name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
      const outcome = callTool(store, name, args);
      if (!outcome.ok) {
        return rpcResult(id, {
          content: [{ type: 'text', text: outcome.message }],
          structuredContent: { error: outcome.message },
          isError: true,
        });
      }
      const text = JSON.stringify(outcome.result);
      return rpcResult(id, {
        content: [{ type: 'text', text }],
        structuredContent: outcome.result,
      });
    }
    default:
      return rpcError(id, -32601, `Method not found: ${req.method}`);
  }
}

export { repoGlobalId };

# github-core-clone-01 — a GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/aminzen03/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/aminzen03/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A single-process, dependency-free GitHub-compatible forge for
[the contest](https://make.fun/bounty/github-core-clone-01): git smart HTTP,
the REST v3 resources, GraphQL v4, and an MCP endpoint, all backed by one
in-memory store with a from-scratch SHA-1 object model. It boots, registers,
and serves the sealed conformance suite the kit ships — **120/120 checks**
on the local runner — with no model calls, no network, and no `git` binary.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips
TypeScript types on its own. There is nothing to install: the program imports
`node:http`, `node:crypto`, `node:zlib`, and its own modules only.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in
`MAKEFUN_ENV_URL` (`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one.
   Never bind 8080: that is the env's port.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <port>}`.
   The first register wins; a later one is answered `409`.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers at once with
   `{"done":false}` while the suite runs and `{"done":true}` once its export
   is written. Poll with a short backoff; never exit before it says `true`.
4. **Exit 0** when it does.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe |
| `GET /api/v3/` | 200, `X-OAuth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, squash merges |
| `POST /api/graphql` | GraphQL v4: viewer, repository, issues, pull requests, mutations, `__type` introspection, batched operations |
| `POST /mcp` | MCP over streamable HTTP: modern `server/discover` (2026-07-28) and legacy `initialize`; six tools |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (v2 + v0), `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

Every reply is `application/json` with a non-empty `X-GitHub-Request-Id`.
Auth is `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; a missing or wrong token
is 401, and any owner other than the token owner is 404, never 403.

## Layout

- `main.ts` — the lifecycle above (the kit starter, kept as-is).
- `app.ts` — the HTTP server, routing, and all REST handlers.
- `git.ts` — SHA-1 object model, loose objects, packfile parse/build
  (plain, OFS-delta, REF-delta), pkt-line framing.
- `store.ts` — the in-memory store: repos, refs, objects, issues, PRs,
  labels, comments; reachability, merge-base, squash merge with 3-way
  conflict detection; deterministic timestamps from `MAKEFUN_TRIAL_NOW`.
- `gitserver.ts` — smart HTTP: v0/v2 advertisements, ls-refs, fetch
  (two-phase v2 negotiation, shallow/deepen incl. `deepen-relative`),
  receive-pack with thin-pack delta resolution and fast-forward enforcement.
- `graphql.ts` — a minimal GraphQL executor: tokenizer, recursive-descent
  parser (variables, aliases, fragments, input objects), per-type field
  tables, introspection, opaque global ids, cursor pagination.
- `mcp.ts` — JSON-RPC 2.0 dispatch for `server/discover`, `initialize`,
  `tools/list`, `tools/call` (canonical names + aliases, byte-identical
  listings, per-request auth).
- `package.json`, `tsconfig.json`, `LICENSE` (MIT).

## Scores (local runner, `--driver process`)

| Run | feature | agent (MCP) | perf | total |
| --- | --- | --- | --- | --- |
| practice trial-0 | 600/600 | 200/200 | 62–99 | 862–899 |
| 3 practice instances | 600/600 each | 200/200 each | varies | — |

Feature and agent columns are a clean 120/120 on every run. The perf column
moves with the machine it runs on (this VM is shared and throttled; the
reference forge's `T_ref` values were calibrated on production hardware):
push ~15–22, clone ~12–24, read ~16–26, write ~19–27 points per workload.

## Determinism

No wall clock (dates come from `MAKEFUN_TRIAL_NOW`), no unseeded
randomness (ids are sequential or content-addressed), one fixed order for
every list the suite reads. The state export replays byte-for-byte.

## License

MIT.

---

<sub>Entered on [make.fun](https://make.fun/?ref=avjec4z5&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

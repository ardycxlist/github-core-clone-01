# makefun-forge

A GitHub-compatible git forge: git smart HTTP (protocol v2 + v0),
REST v3, GraphQL and MCP, served from its own in-memory store.
Written from the wire protocol up — no git binary at runtime, no
vendored git library, Node standard library only.

## Run

```sh
# Trial mode (the env provides MAKEFUN_ENV_URL and MAKEFUN_SHOP_TOKEN):
node --experimental-strip-types main.ts
```

The entry binds an ephemeral port, registers it with the env
(`POST $MAKEFUN_ENV_URL/register {"port": N}`), serves until the env
answers `{"done": true}` on `GET $MAKEFUN_ENV_URL/done`, then exits 0.
Without `MAKEFUN_ENV_URL` it exits 1.

## Layout

- `main.ts` — entry <-> env lifecycle (bind, register, wait for done).
- `app.ts` — HTTP server: routing, git smart HTTP, REST v3 dispatch,
  GraphQL (`POST /api/graphql`, `/graphql`) and MCP (`POST /mcp`), healthz.
- `rest.ts` — full REST v3 (`/api/v3`): repos, branches, commits, contents,
  labels, issues, pull requests, deterministic squash merge. Also exports
  the shared services (`createIssueRecord`, `addCommentRecord`,
  `createPullRecord`, `pullChangedFiles`, `mergeableState`,
  `squashMergeRecord`) used by GraphQL and MCP — one store, three surfaces.
- `graphql.ts` — hand-written GraphQL lexer/parser/executor (queries,
  mutations, variables, fragments incl. inline `... on Type`, aliases,
  directives, batching). Global ids are base64 of `Type:dbid`; cursors are
  base64 of `cursor:offset` — both pure functions, no clock, no random.
- `mcp.ts` — MCP server (JSON-RPC 2.0 over Streamable HTTP): modern
  `server/discover` (revision 2026-07-28) plus the legacy `initialize`
  handshake; six tools (`create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`) on the same
  store as REST and GraphQL.
- `scenario.ts` — the trial scenario's viewer identity, re-derived
  deterministically from the fixed `SCENARIO_SEED` (FNV-1a-64 labelling,
  splitmix64 finalizer, xorshift64* stream): viewer `adaiversen`, id 1000.
- `http-util.ts` — shared HTTP plumbing: JSON replies, request ids, auth, errors.
- `git.ts` — git object model, pkt-line codec, pack codec (plain objects
  only), protocol v2 ls-refs / fetch, protocol v0 receive-pack, plus tree /
  commit / merge helpers for the REST surface.
- `store.ts` — deterministic in-memory state (repos, objects, refs, labels,
  issues, pulls).

## Determinism

The forge is replay-deterministic: no `Date.now()`, no `new Date()`,
no `Math.random()`. All timestamps come from `MAKEFUN_TRIAL_NOW`
(or a fixed epoch in local dev); all ids come from sequential counters;
all output order is sorted. A replay of the same trial produces the
same state byte-for-byte.

## Milestones

- **M1 (this build):** core object store + git smart HTTP + minimal REST
  for the git-check fixtures. Git group 30/30 against `sdk/run.ts`.
- **M2:** full REST v3 + determinism hardening. 85/120 verified
  (git 30/30, repos 15/15, issues 15/15, pulls 20/20, protocol 5/5).
- **M3:** GraphQL + MCP. **120/120 verified** (`sdk/run.ts --perf`):
  graphql 20/20, mcp 15/15, all earlier groups intact; score 924/1000
  (feature 600, agent 200, perf 124). Cross-surface determinism probe
  (REST + GraphQL + MCP, 28 steps, two fresh forges) byte-identical.
- **M4:** performance optimisation + stress test.

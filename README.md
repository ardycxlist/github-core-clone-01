# Raven Forge

A GitHub-compatible git forge in a single Node 22 process: git smart HTTP
(upload-pack protocol v2, receive-pack v0), the REST v3 API, GraphQL v4,
and an MCP endpoint, all served from one in-memory store. Standard library
only — no dependencies, no git binary at runtime, no outside service, no
persistent disk. State lives in memory and is gone when the process stops.

## Run

```sh
# Trial mode (the environment provides MAKEFUN_ENV_URL and MAKEFUN_SHOP_TOKEN):
node --experimental-strip-types main.ts
```

The entry binds an ephemeral port, registers it with the environment
(`POST $MAKEFUN_ENV_URL/register {"port": N}`), serves until the
environment answers `{"done": true}` on `GET $MAKEFUN_ENV_URL/done`,
then exits 0.

```sh
# Standalone, for local checks (prints the port it bound):
MAKEFUN_SHOP_TOKEN='a-disposable-local-test-token' node main.ts --standalone
```

`/healthz` answers without a token; every other route needs the bearer
token from `MAKEFUN_SHOP_TOKEN` (HTTP Basic with the token as password
works for native git clients).

## Layout

- `main.ts` — entrypoint: bind, register with the environment, poll
  `/done`, exit. Standalone mode reports the port.
- `server.mjs` — HTTP server: routing, bearer/Basic auth, `/healthz`,
  request IDs, JSON errors, body cap.
- `store.mjs` — `Store`: repositories, issues, pull requests, labels,
  comments, contents, and the whole REST v3 surface. One store feeds all
  three API surfaces, so an object created through REST reads identically
  through GraphQL and MCP.
- `git.mjs` — `GitRepo`: the in-memory SHA-1 object store (blobs, trees,
  commits, tags), refs, three-way merge, diffs, pack read/write, and the
  smart-HTTP handlers.
- `graphql.mjs` — GraphQL v4 executor (queries, mutations, batching,
  cursor pagination).
- `mcp.mjs` — MCP endpoint (JSON-RPC 2.0 over Streamable HTTP).

## Determinism

The store runs on a counter clock: timestamps are a fixed epoch plus the
counter times one second, and IDs are sequential. The same sequence of
operations therefore produces byte-identical state, which is what makes
the trial's state export reproducible.

## Merges

Squash only. A merge creates one commit on the base branch with a single
parent. An explicit `MERGE` or `REBASE` method is rejected with 422 —
never silently squashed — and the advertised capabilities say squash
only.

## Verification

The official suite (`sdk/run.ts` in the competition kit, process driver,
no Docker) runs against a fresh forge: 120 checks across git, repos,
issues, pulls, GraphQL, MCP, and protocol, plus four timed workloads.
A separate integration harness covers the hardening cases — quarantined
invalid pushes, ref-namespace conflicts, `.git` tree entries, atomic
rejected mutations, cross-surface PR snapshots, node-ID lifecycle,
GraphQL pagination past the 30-item REST page, squash-only merge, and
the 401/400/422 error shapes — all asserted against a live server, not
by inspection.

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
- `app.ts` — HTTP server: routing, git smart HTTP, REST v3 dispatch, healthz.
- `rest.ts` — full REST v3 (`/api/v3`): repos, branches, commits, contents,
  labels, issues, pull requests, deterministic squash merge.
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
- **M2:** full REST v3 + determinism hardening.
- **M3:** GraphQL + MCP.
- **M4:** performance optimisation + stress test.

// app.ts — HTTP server: routing, git smart HTTP, minimal REST v3, healthz.
//
// Auth: Bearer <MAKEFUN_SHOP_TOKEN> on /api/v3/* (when the env var is set).
// Every JSON reply carries X-GitHub-Request-Id (deterministic counter).

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Store, trialNowIso } from "./store.js";
import type { Repo } from "./store.js";
import {
  AGENT,
  buildV0Advertisement,
  buildV2Advertisement,
  handleReceivePack,
  handleUploadPackPost,
} from "./git.js";

export interface Forge {
  server: ReturnType<typeof createServer>;
  store: Store;
  port: number;
}

const VALID_REPO_NAME = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/;

function sendJson(res: ServerResponse, store: Store, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "X-GitHub-Request-Id": store.nextRequestId(),
    "Content-Length": body.length,
  });
  res.end(body);
}

function sendRaw(
  res: ServerResponse,
  store: Store,
  status: number,
  contentType: string,
  body: Buffer,
): void {
  res.writeHead(status, {
    "Content-Type": contentType,
    "X-GitHub-Request-Id": store.nextRequestId(),
    "Content-Length": body.length,
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

function shopToken(): string | null {
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  return token && token.length > 0 ? token : null;
}

/** REST auth: missing or wrong Bearer token -> 401. Null when authorized. */
function authError(req: IncomingMessage): { status: number; message: string } | null {
  const expected = shopToken();
  if (expected === null) return null; // local dev without a token: open
  const got = bearerToken(req);
  if (!got) return { status: 401, message: "Requires authentication" };
  if (got !== expected) return { status: 401, message: "Bad credentials" };
  return null;
}

function repoJson(repo: Repo): Record<string, unknown> {
  const r = repo;
  return {
    id: r.id,
    node_id: `R_${r.id}`,
    name: r.name,
    full_name: r.owner ? `${r.owner}/${r.name}` : r.name,
    owner: { login: r.owner ?? "", id: r.owner ? 1 : 0, type: "User" },
    private: r.isPrivate,
    description: r.description,
    default_branch: r.defaultBranch,
    created_at: trialNowIso(),
    updated_at: trialNowIso(),
    pushed_at: trialNowIso(),
    html_url: `https://github.com/${r.owner ?? ""}/${r.name}`,
    url: `/api/v3/repos/${r.owner ?? ""}/${r.name}`,
    clone_url: `https://github.com/${r.owner ?? ""}/${r.name}.git`,
    git_url: `git://github.com/${r.owner ?? ""}/${r.name}.git`,
    ssh_url: `git@github.com:${r.owner ?? ""}/${r.name}.git`,
    fork: false,
    archived: false,
    disabled: false,
    visibility: r.isPrivate ? "private" : "public",
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    license: null,
    topics: [],
    open_issues_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
  };
}

export function createForge(store: Store): Forge {
  const server = createServer((req, res) => {
    void handleRequest(store, req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        sendJson(res, store, 500, { message: (err as Error).message ?? "internal error" });
      } else {
        res.end();
      }
    });
  });
  return { server, store, port: 0 };
}

async function handleRequest(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  const method = (req.method ?? "GET").toUpperCase();

  // Health probe (no auth).
  if (method === "GET" && path === "/healthz") {
    sendJson(res, store, 200, { ok: true });
    return;
  }

  // API root (no auth needed for the starter's /api/v3 probe; keep it open).
  if (path === "/api/v3" || path === "/api/v3/") {
    if (method === "GET") {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "X-GitHub-Request-Id": store.nextRequestId(),
        "X-OAuth-Scopes": "repo, read:org",
      });
      res.end(JSON.stringify({ current_user_url: "/api/v3/user", rate_limit_url: "/api/v3/rate_limit" }));
      return;
    }
    sendJson(res, store, 404, { message: "Not Found" });
    return;
  }

  // Git smart HTTP: /:owner/:repo.git/...
  const gitMatch = path.match(/^\/([^/]+)\/([^/]+)\.git(\/.*)?$/);
  if (gitMatch) {
    const owner = decodeURIComponent(gitMatch[1]);
    const repoName = decodeURIComponent(gitMatch[2]);
    const suffix = gitMatch[3] ?? "";
    await handleGit(store, req, res, owner, repoName, suffix, url);
    return;
  }

  // Minimal REST v3.
  if (path.startsWith("/api/v3/")) {
    await handleRest(store, req, res, path, method);
    return;
  }

  sendJson(res, store, 404, { message: "Not Found" });
}

async function handleGit(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  suffix: string,
  url: URL,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  const repo = store.resolveRepo(repoName, owner);

  if (method === "GET" && suffix === "/info/refs") {
    const service = url.searchParams.get("service");
    if (service !== "git-upload-pack" && service !== "git-receive-pack") {
      sendJson(res, store, 400, { message: "service parameter is required" });
      return;
    }
    if (!repo) {
      sendJson(res, store, 404, { message: "Not Found" });
      return;
    }
    const useV2 = service === "git-upload-pack" && req.headers["git-protocol"] === "version=2";
    const body = useV2
      ? buildV2Advertisement(service)
      : buildV0Advertisement(repo, service);
    sendRaw(res, store, 200, `application/x-${service}-advertisement`, body);
    return;
  }

  if (method === "POST" && suffix === "/git-upload-pack") {
    if (!repo) {
      sendJson(res, store, 404, { message: "Not Found" });
      return;
    }
    const body = await readBody(req);
    const result = handleUploadPackPost(repo, body);
    sendRaw(res, store, result.status, result.contentType, result.body);
    return;
  }

  if (method === "POST" && suffix === "/git-receive-pack") {
    if (!repo) {
      sendJson(res, store, 404, { message: "Not Found" });
      return;
    }
    const body = await readBody(req);
    const report = handleReceivePack(repo, body);
    sendRaw(res, store, 200, "application/x-git-receive-pack-result", report);
    return;
  }

  sendJson(res, store, 404, { message: "Not Found" });
}

async function handleRest(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
): Promise<void> {
  // POST /api/v3/user/repos — create a repo (the git fixtures' seed path).
  if (method === "POST" && path === "/api/v3/user/repos") {
    const err = authError(req);
    if (err) {
      sendJson(res, store, err.status, { message: err.message });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    } catch {
      sendJson(res, store, 400, { message: "Problems parsing JSON" });
      return;
    }
    const body = (parsed ?? {}) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name : "";
    if (!VALID_REPO_NAME.test(name)) {
      sendJson(res, store, 422, { message: "Validation Failed", errors: [{ field: "name", code: "invalid" }] });
      return;
    }
    if (store.getRepo(name)) {
      sendJson(res, store, 422, { message: `Repository ${name} already exists` });
      return;
    }
    const repo = store.createRepo(
      name,
      typeof body.description === "string" ? body.description : "",
      body.private === true,
    );
    sendJson(res, store, 201, repoJson(repo));
    return;
  }

  // GET /api/v3/repos/{owner}/{repo}
  const repoMatch = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/);
  if (method === "GET" && repoMatch) {
    const err = authError(req);
    if (err) {
      sendJson(res, store, err.status, { message: err.message });
      return;
    }
    const owner = decodeURIComponent(repoMatch[1]);
    const repoName = decodeURIComponent(repoMatch[2]);
    const repo = store.resolveRepo(repoName, owner);
    if (!repo) {
      sendJson(res, store, 404, { message: "Not Found" });
      return;
    }
    sendJson(res, store, 200, repoJson(repo));
    return;
  }

  sendJson(res, store, 404, { message: "Not Found" });
}

export { AGENT };

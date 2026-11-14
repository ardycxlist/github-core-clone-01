// app.ts — HTTP server: routing, git smart HTTP, REST v3 dispatch, healthz.
//
// Auth: Bearer <MAKEFUN_SHOP_TOKEN> on /api/v3/* (when the env var is set).
// Every JSON reply carries X-GitHub-Request-Id (deterministic counter).

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Store } from "./store.ts";
import {
  AGENT,
  buildV0Advertisement,
  buildV2Advertisement,
  handleReceivePack,
  handleUploadPackPost,
} from "./git.ts";
import { readBody, sendJson, sendRaw } from "./http-util.ts";
import { handleRest } from "./rest.ts";
import { handleGraphQL } from "./graphql.ts";
import { handleMcp } from "./mcp.ts";

export interface Forge {
  server: ReturnType<typeof createServer>;
  store: Store;
  port: number;
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

  // API root (no auth).
  if (path === "/api/v3" || path === "/api/v3/") {
    if (method === "GET") {
      sendJson(
        res,
        store,
        200,
        { current_user_url: "/api/v3/user", rate_limit_url: "/api/v3/rate_limit" },
        { "X-OAuth-Scopes": "repo, read:org" },
      );
      return;
    }
    sendJson(res, store, 404, { message: "Not Found" });
    return;
  }

  // GraphQL (before the /api/v3/ REST dispatch).
  if (method === "POST" && (path === "/api/graphql" || path === "/graphql")) {
    await handleGraphQL(store, req, res);
    return;
  }

  // MCP (JSON-RPC 2.0 over Streamable HTTP).
  if (path === "/mcp") {
    await handleMcp(store, req, res);
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

  // REST v3.
  if (path.startsWith("/api/v3/")) {
    await handleRest(store, req, res, path, method, url);
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

export { AGENT };

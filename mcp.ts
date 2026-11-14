// mcp.ts — Model Context Protocol endpoint (POST /mcp), JSON-RPC 2.0 over
// Streamable HTTP. Modern revision 2026-07-28 (server/discover) plus the
// legacy initialize handshake; tools run on the same store as REST and
// GraphQL. Every request answers in well under 3 seconds (in-memory only).
//
// Determinism: the tools list is a fixed constant (byte-identical every
// call); ids come from the request; no clock, no random.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "./store.ts";
import type { Repo } from "./store.ts";
import { viewerLogin } from "./scenario.ts";
import {
  createIssueRecord,
  createPullRecord,
  issueJson,
  pullJson,
  repoJson,
  squashMergeRecord,
} from "./rest.ts";
import { HttpError, bearerToken, readBody, sendJson, shopToken } from "./http-util.ts";

const SERVER_NAME = "github-core-clone-forge";
const SERVER_VERSION = "1.0.0";

/** Revisions this server speaks, newest first. */
const SUPPORTED_VERSIONS: readonly string[] = [
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];

const SERVER_INFO = { name: SERVER_NAME, version: SERVER_VERSION };

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

class ToolError extends Error {}

interface ToolResult {
  text: string;
  structured: unknown;
}

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string }>;
  required: string[];
  run: (store: Store, args: Record<string, unknown>) => ToolResult;
}

function strArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : "";
}

function numArg(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return -1;
}

function requireRepo(store: Store, args: Record<string, unknown>): Repo {
  const owner = strArg(args, "owner");
  const name = strArg(args, "repo");
  if (owner === "" || name === "") throw new ToolError("Missing required argument: owner and repo");
  const repo = store.resolveRepo(name, owner);
  if (!repo) throw new ToolError(`Repository ${owner}/${name} not found`);
  return repo;
}

const TOOLS: readonly ToolDef[] = [
  {
    name: "create_repo",
    description: "Create a repository for the viewer.",
    properties: {
      name: { type: "string" },
      description: { type: "string" },
      private: { type: "boolean" },
      owner: { type: "string" },
    },
    required: ["name"],
    run: (store, args) => {
      const name = strArg(args, "name");
      if (name === "") throw new ToolError("Missing required argument: name");
      if (store.getRepo(name)) throw new ToolError(`Repository ${name} already exists`);
      const owner = strArg(args, "owner") || viewerLogin();
      const repo = store.createRepo(
        name,
        strArg(args, "description"),
        args.private === true,
      );
      const view = {
        ...repoJson(repo),
        full_name: `${owner}/${name}`,
        owner: { login: owner, id: 1000, type: "User" },
      };
      return { text: JSON.stringify(view), structured: view };
    },
  },
  {
    name: "get_repo",
    description: "Get a repository by owner and name.",
    properties: {
      owner: { type: "string" },
      repo: { type: "string" },
    },
    required: ["owner", "repo"],
    run: (store, args) => {
      const repo = requireRepo(store, args);
      const view = repoJson(repo);
      return { text: JSON.stringify(view), structured: view };
    },
  },
  {
    name: "create_issue",
    description: "Create an issue in a repository.",
    properties: {
      owner: { type: "string" },
      repo: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
    },
    required: ["owner", "repo", "title"],
    run: (store, args) => {
      const title = strArg(args, "title");
      if (title === "") throw new ToolError("Missing required argument: title");
      const repo = requireRepo(store, args);
      const issue = createIssueRecord(store, repo, title, strArg(args, "body"), []);
      const view = issueJson(repo, issue);
      return { text: JSON.stringify(view), structured: view };
    },
  },
  {
    name: "list_issues",
    description: "List the issues of a repository.",
    properties: {
      owner: { type: "string" },
      repo: { type: "string" },
      state: { type: "string" },
    },
    required: ["owner", "repo"],
    run: (store, args) => {
      const repo = requireRepo(store, args);
      const state = strArg(args, "state") || "open";
      let list = [...repo.issues.values()];
      if (state === "open") list = list.filter((i) => i.state === "open");
      else if (state === "closed") list = list.filter((i) => i.state === "closed");
      list.sort((a, b) => b.createdSeq - a.createdSeq);
      const views = list.map((issue) => issueJson(repo, issue));
      return { text: JSON.stringify(views), structured: { issues: views } };
    },
  },
  {
    name: "create_pull_request",
    description: "Open a pull request from a head branch into a base branch.",
    properties: {
      owner: { type: "string" },
      repo: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
      head: { type: "string" },
      base: { type: "string" },
    },
    required: ["owner", "repo", "title", "head", "base"],
    run: (store, args) => {
      const repo = requireRepo(store, args);
      const title = strArg(args, "title");
      const head = strArg(args, "head");
      const base = strArg(args, "base");
      if (title === "" || head === "" || base === "") {
        throw new ToolError("Missing required argument: title, head and base");
      }
      const pull = createPullRecord(store, repo, head, base, title, strArg(args, "body"));
      const view = pullJson(repo, pull);
      return { text: JSON.stringify(view), structured: view };
    },
  },
  {
    name: "merge_pull_request",
    description: "Squash-merge a pull request.",
    properties: {
      owner: { type: "string" },
      repo: { type: "string" },
      pull_number: { type: "integer" },
    },
    required: ["owner", "repo", "pull_number"],
    run: (store, args) => {
      const repo = requireRepo(store, args);
      const number = numArg(args, "pull_number");
      const pull = number >= 0 ? repo.pulls.get(number) : undefined;
      if (!pull) throw new ToolError(`Pull request #${number} not found`);
      const { sha } = squashMergeRecord(store, repo, pull);
      const view = { sha, merged: true, number: pull.number, state: pull.state };
      return { text: JSON.stringify(view), structured: view };
    },
  },
];

function publicTool(tool: ToolDef): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: "object",
      properties: tool.properties,
      required: tool.required,
    },
  };
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findTool(name: string): ToolDef | null {
  for (const tool of TOOLS) if (tool.name === name) return tool;
  const wanted = normalizeName(name);
  for (const tool of TOOLS) {
    const candidate = normalizeName(tool.name);
    if (candidate === wanted) return tool;
    if (candidate.length < wanted.length && wanted.endsWith(candidate)) return tool;
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSON-RPC layer
// ---------------------------------------------------------------------------

interface RpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: string | number | null, error: RpcErrorBody): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error };
}

function callTool(store: Store, params: Record<string, unknown>): Record<string, unknown> {
  const name = typeof params.name === "string" ? params.name : "";
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  const tool = findTool(name);
  if (!tool) {
    throw new HttpError(200, "Method not found", { rpcCode: -32601 });
  }
  const missing = tool.required.filter((key) => {
    const value = args[key];
    return value === undefined || value === null || (typeof value === "string" && value === "");
  });
  if (missing.length > 0) {
    return {
      content: [{ type: "text", text: `Missing required argument(s): ${missing.join(", ")}` }],
      isError: true,
    };
  }
  try {
    const outcome = tool.run(store, args);
    return {
      content: [{ type: "text", text: outcome.text }],
      structuredContent: outcome.structured,
    };
  } catch (err) {
    if (err instanceof ToolError) {
      return { content: [{ type: "text", text: err.message }], isError: true };
    }
    if (err instanceof HttpError) {
      return { content: [{ type: "text", text: err.message }], isError: true };
    }
    throw err;
  }
}

function dispatchMethod(
  store: Store,
  method: string,
  params: Record<string, unknown>,
): unknown {
  if (method === "server/discover") {
    return {
      resultType: "discover",
      supportedVersions: [...SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      serverInfo: { ...SERVER_INFO },
      _meta: { "io.modelcontextprotocol/serverInfo": { ...SERVER_INFO } },
    };
  }
  if (method === "initialize") {
    const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
    const negotiated = (SUPPORTED_VERSIONS as readonly string[]).includes(requested)
      ? requested
      : "2025-11-25";
    return {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { ...SERVER_INFO },
    };
  }
  if (method === "tools/list") {
    return { tools: TOOLS.map(publicTool) };
  }
  if (method === "tools/call") {
    return callTool(store, params);
  }
  if (method === "ping") {
    return {};
  }
  throw new HttpError(200, "Method not found", { rpcCode: -32601 });
}

export async function handleMcp(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "DELETE") {
    res.writeHead(204, { "X-GitHub-Request-Id": store.nextRequestId() });
    res.end();
    return;
  }
  if (method !== "POST") {
    sendJson(res, store, 405, { message: "Method Not Allowed" });
    return;
  }

  // Auth is decided before any tool exists: no (or a wrong) Bearer token is 401.
  const expected = shopToken();
  if (expected !== null) {
    const got = bearerToken(req);
    if (!got || got !== expected) {
      sendJson(res, store, 401, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32001, message: "Requires authentication" },
      });
      return;
    }
  }

  const raw = (await readBody(req)).toString("utf8");
  let body: unknown;
  try {
    body = raw.trim() === "" ? null : JSON.parse(raw);
  } catch {
    sendJson(res, store, 400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    return;
  }

  if (Array.isArray(body)) {
    sendJson(res, store, 200, rpcError(null, { code: -32600, message: "Invalid Request" }));
    return;
  }
  if (typeof body !== "object" || body === null) {
    sendJson(res, store, 200, rpcError(null, { code: -32600, message: "Invalid Request" }));
    return;
  }
  const record = body as Record<string, unknown>;
  const id =
    typeof record.id === "string" || typeof record.id === "number" ? record.id : null;
  const hasId = "id" in record;
  const rpcMethod = typeof record.method === "string" ? record.method : "";

  // A notification (no id) is answered with 202 and no body.
  if (!hasId) {
    res.writeHead(202, { "X-GitHub-Request-Id": store.nextRequestId() });
    res.end();
    return;
  }
  if (rpcMethod === "") {
    sendJson(res, store, 200, rpcError(id, { code: -32600, message: "Invalid Request" }));
    return;
  }

  const params = (record.params ?? {}) as Record<string, unknown>;
  try {
    const result = dispatchMethod(store, rpcMethod, params);
    sendJson(res, store, 200, rpcResult(id, result));
  } catch (err) {
    if (err instanceof HttpError && typeof err.extra?.rpcCode === "number") {
      sendJson(
        res,
        store,
        200,
        rpcError(id, { code: err.extra.rpcCode as number, message: err.message }),
      );
      return;
    }
    throw err;
  }
}

// http-util.ts — shared HTTP plumbing for the forge server.
//
// Every reply is JSON (never HTML) and carries X-GitHub-Request-Id.
// Errors are HttpError: the router turns them into a JSON {"message"} body.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "./store.ts";

export class HttpError extends Error {
  status: number;
  extra: Record<string, unknown> | undefined;
  constructor(status: number, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function sendJson(
  res: ServerResponse,
  store: Store,
  status: number,
  value: unknown,
  extraHeaders?: Record<string, string>,
): void {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "X-GitHub-Request-Id": store.nextRequestId(),
    "Content-Length": body.length,
    ...extraHeaders,
  });
  res.end(body);
}

export function sendNoContent(
  res: ServerResponse,
  store: Store,
  extraHeaders?: Record<string, string>,
): void {
  res.writeHead(204, {
    "Content-Type": "application/json; charset=utf-8",
    "X-GitHub-Request-Id": store.nextRequestId(),
    ...extraHeaders,
  });
  res.end();
}

export function sendRaw(
  res: ServerResponse,
  store: Store,
  status: number,
  contentType: string,
  body: Buffer,
  extraHeaders?: Record<string, string>,
): void {
  res.writeHead(status, {
    "Content-Type": contentType,
    "X-GitHub-Request-Id": store.nextRequestId(),
    "Content-Length": body.length,
    ...extraHeaders,
  });
  res.end(body);
}

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Parse a request body as a JSON object. Empty body -> {}. Malformed -> 400. */
export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = (await readBody(req)).toString("utf8").trim();
  if (raw === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Problems parsing JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "Problems parsing JSON");
  }
  return parsed as Record<string, unknown>;
}

export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

export function shopToken(): string | null {
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  return token && token.length > 0 ? token : null;
}

/** Throws 401 when the request carries no (or a wrong) Bearer token. */
export function requireAuth(req: IncomingMessage): void {
  const expected = shopToken();
  if (expected === null) return; // local dev without a token: open
  const got = bearerToken(req);
  if (!got) throw new HttpError(401, "Requires authentication");
  if (got !== expected) throw new HttpError(401, "Bad credentials");
}

/** An integer query parameter, or `fallback` when absent or unparseable. */
export function queryInt(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

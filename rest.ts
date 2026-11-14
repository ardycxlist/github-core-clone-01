// rest.ts — GitHub REST v3 API (/api/v3) on the same in-memory store as
// the git smart HTTP surface. One store, two surfaces: a repository created
// through REST can be pushed to through git, and contents commits made here
// are real git objects (blob/tree/commit) visible to clone/fetch.
//
// Determinism: every timestamp is the trial clock, every id a sequential
// counter, every list sorted. No wall clock, no unseeded random.

import type { IncomingMessage, ServerResponse } from "node:http";
import { Store, trialNowEpochSec, trialNowIso } from "./store.ts";
import type { Issue, IssueComment, Label, Pull, Repo } from "./store.ts";
import {
  buildCommit,
  buildTreeFromPaths,
  commitHistory,
  diffTrees,
  flattenTree,
  hashObject,
  mergeBase,
  parseCommit,
  subtreeOid,
  threeWayMerge,
} from "./git.ts";
import type { FlatEntry } from "./git.ts";
import { HttpError, queryInt, readJsonBody, requireAuth, sendJson, sendNoContent } from "./http-util.ts";

const VALID_REPO_NAME = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/;
const SHA40 = /^[0-9a-f]{40}$/i;

// ---------------------------------------------------------------------------
// Serializers (extra fields are allowed by the suite's shape checks)
// ---------------------------------------------------------------------------

function repoJson(repo: Repo): Record<string, unknown> {
  const owner = repo.owner ?? "";
  let openCount = 0;
  for (const issue of repo.issues.values()) if (issue.state === "open") openCount += 1;
  for (const pull of repo.pulls.values()) if (pull.state === "open") openCount += 1;
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: owner === "" ? repo.name : `${owner}/${repo.name}`,
    owner: { login: owner, id: owner === "" ? 0 : 1, type: "User" },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: trialNowIso(),
    updated_at: trialNowIso(),
    pushed_at: trialNowIso(),
    html_url: `https://github.com/${owner}/${repo.name}`,
    url: `/api/v3/repos/${owner}/${repo.name}`,
    clone_url: `https://github.com/${owner}/${repo.name}.git`,
    git_url: `git://github.com/${owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${owner}/${repo.name}.git`,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? "private" : "public",
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    license: null,
    topics: [],
    open_issues_count: openCount,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: `L_${label.id}`,
    url: `/api/v3/labels/${label.id}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  const owner = repo.owner ?? "";
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: { login: issue.userLogin, id: 1, type: "User" },
    assignee: null,
    locked: false,
    comments: issue.comments.length,
    created_at: trialNowIso(),
    updated_at: trialNowIso(),
    closed_at: issue.state === "closed" ? trialNowIso() : null,
    html_url: `https://github.com/${owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${owner}/${repo.name}`,
  };
}

function commentJson(repo: Repo, issue: Issue, comment: IssueComment): Record<string, unknown> {
  const owner = repo.owner ?? "";
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    body: comment.body,
    user: { login: comment.userLogin, id: 1, type: "User" },
    created_at: trialNowIso(),
    updated_at: trialNowIso(),
    html_url: `https://github.com/${owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const owner = repo.owner ?? "";
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const repoStub = { name: repo.name, full_name: owner === "" ? repo.name : `${owner}/${repo.name}` };
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { label: `${owner}:${pull.headRef}`, ref: pull.headRef, sha: headSha, user: { login: owner, id: 1, type: "User" }, repo: repoStub },
    base: { label: `${owner}:${pull.baseRef}`, ref: pull.baseRef, sha: baseSha, user: { login: owner, id: 1, type: "User" }, repo: repoStub },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: pull.userLogin, id: 1, type: "User" },
    created_at: trialNowIso(),
    updated_at: trialNowIso(),
    closed_at: pull.state === "closed" ? trialNowIso() : null,
    html_url: `https://github.com/${owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${owner}/${repo.name}/pulls/${pull.number}`,
    draft: false,
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function resolveRepoOr404(store: Store, name: string, owner: string): Repo {
  const repo = store.resolveRepo(name, owner);
  if (!repo) throw new HttpError(404, "Not Found");
  return repo;
}

function parseNumber(segment: string): number {
  const n = parseInt(segment, 10);
  if (!Number.isFinite(n) || n < 0 || String(n) !== segment) return -1;
  return n;
}

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

/** Slice a sorted list into one page; builds the Link header when paged. */
function paginate<T>(
  items: T[],
  url: URL,
  req: IncomingMessage,
): { page: T[]; link: string | null } {
  const perPage = Math.min(100, Math.max(1, queryInt(url, "per_page", 30)));
  const page = Math.max(1, queryInt(url, "page", 1));
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (totalPages <= 1) return { page: slice, link: null };
  const host = req.headers.host ?? "127.0.0.1";
  const pageUrl = (p: number): string => {
    const q = new URLSearchParams(url.searchParams);
    q.set("per_page", String(perPage));
    q.set("page", String(p));
    return `http://${host}${url.pathname}?${q.toString()}`;
  };
  const parts: string[] = [];
  if (page < totalPages) parts.push(`<${pageUrl(page + 1)}>; rel="next"`);
  if (page > 1) parts.push(`<${pageUrl(page - 1)}>; rel="prev"`);
  parts.push(`<${pageUrl(1)}>; rel="first"`);
  parts.push(`<${pageUrl(totalPages)}>; rel="last"`);
  return { page: slice, link: parts.join(", ") };
}

function linkHeader(link: string | null): Record<string, string> | undefined {
  return link ? { Link: link } : undefined;
}

/** The tip commit of a branch, or null when the branch has no commits yet. */
function branchTipCommit(repo: Repo, branch: string): { oid: string; tree: string } | null {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (!tip) return null;
  const obj = repo.objects.get(tip);
  if (!obj || obj.type !== "commit") return null;
  return { oid: tip, tree: parseCommit(obj.data).tree };
}

/** Resolve a ref parameter (branch name or commit oid) to a commit oid. */
function resolveRefParam(repo: Repo, ref: string): string | null {
  const asBranch = repo.refs.get(`refs/heads/${ref}`);
  if (asBranch) return asBranch;
  if (SHA40.test(ref) && repo.objects.has(ref)) return ref;
  return null;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function handleRest(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  url: URL,
): Promise<void> {
  try {
    await routeRest(store, req, res, path, method, url);
  } catch (err) {
    if (err instanceof HttpError) {
      if (!res.headersSent) {
        sendJson(res, store, err.status, { message: err.message, ...(err.extra ?? {}) });
      }
      return;
    }
    throw err;
  }
}

async function routeRest(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  url: URL,
): Promise<void> {
  const segments = path.split("/").filter((s) => s.length > 0);
  const rest = segments.slice(2); // after ["api", "v3"]

  // GET /api/v3/meta is public (like GitHub's); everything else needs auth.
  if (!(method === "GET" && rest.length === 1 && rest[0] === "meta")) {
    requireAuth(req);
  }

  // GET /api/v3/meta
  if (method === "GET" && rest.length === 1 && rest[0] === "meta") {
    sendJson(res, store, 200, { installed_version: "1.0.0" });
    return;
  }

  // /api/v3/user/repos
  if (rest.length === 2 && rest[0] === "user" && rest[1] === "repos") {
    if (method === "GET") {
      const all = [...store.reposByName.values()].sort((a, b) => a.createdSeq - b.createdSeq);
      const { page, link } = paginate(all, url, req);
      sendJson(res, store, 200, page.map(repoJson), linkHeader(link));
      return;
    }
    if (method === "POST") {
      const body = await readJsonBody(req);
      const name = typeof body.name === "string" ? body.name : "";
      if (!VALID_REPO_NAME.test(name)) {
        throw new HttpError(422, "Validation Failed", {
          errors: [{ field: "name", code: "invalid" }],
        });
      }
      if (store.getRepo(name)) {
        throw new HttpError(422, `Repository ${name} already exists`);
      }
      const repo = store.createRepo(
        name,
        typeof body.description === "string" ? body.description : "",
        body.private === true,
      );
      sendJson(res, store, 201, repoJson(repo));
      return;
    }
    throw new HttpError(404, "Not Found");
  }

  // /api/v3/repos/{owner}/{name}[/...]
  if (rest.length >= 3 && rest[0] === "repos") {
    const owner = decodeURIComponent(rest[1]);
    const name = decodeURIComponent(rest[2]);
    const repo = resolveRepoOr404(store, name, owner);
    const tail = rest.slice(3);

    // /api/v3/repos/{o}/{r}
    if (tail.length === 0) {
      if (method === "GET") {
        sendJson(res, store, 200, repoJson(repo));
        return;
      }
      if (method === "PATCH") {
        const body = await readJsonBody(req);
        if (typeof body.description === "string") repo.description = body.description;
        sendJson(res, store, 200, repoJson(repo));
        return;
      }
      if (method === "DELETE") {
        store.reposByName.delete(name);
        sendNoContent(res, store);
        return;
      }
      throw new HttpError(404, "Not Found");
    }

    // GET /api/v3/repos/{o}/{r}/branches
    if (tail.length === 1 && tail[0] === "branches") {
      if (method !== "GET") throw new HttpError(404, "Not Found");
      const branches: Array<Record<string, unknown>> = [];
      for (const [refName, sha] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        if (!refName.startsWith("refs/heads/")) continue;
        branches.push({ name: refName.slice("refs/heads/".length), commit: { sha }, protected: false });
      }
      sendJson(res, store, 200, branches);
      return;
    }

    // GET /api/v3/repos/{o}/{r}/commits
    if (tail.length === 1 && tail[0] === "commits") {
      if (method !== "GET") throw new HttpError(404, "Not Found");
      const refParam = url.searchParams.get("sha") ?? url.searchParams.get("branch") ?? repo.defaultBranch;
      const tip = resolveRefParam(repo, refParam);
      if (!tip) throw new HttpError(404, "Not Found");
      const commits = commitHistory(repo, tip).map((oid) => {
        const obj = repo.objects.get(oid);
        const view = obj ? parseCommit(obj.data) : null;
        return {
          sha: oid,
          commit: {
            message: view?.message ?? "",
            author: { name: "Conformance", email: "conformance@make.fun", date: trialNowIso() },
            committer: { name: "Conformance", email: "conformance@make.fun", date: trialNowIso() },
          },
          parents: (view?.parents ?? []).map((p) => ({ sha: p })),
          url: `/api/v3/repos/${owner}/${name}/commits/${oid}`,
        };
      });
      const { page, link } = paginate(commits, url, req);
      sendJson(res, store, 200, page, linkHeader(link));
      return;
    }

    // POST /api/v3/repos/{o}/{r}/git/refs
    if (tail.length === 2 && tail[0] === "git" && tail[1] === "refs") {
      if (method !== "POST") throw new HttpError(404, "Not Found");
      const body = await readJsonBody(req);
      const ref = typeof body.ref === "string" ? body.ref : "";
      const sha = typeof body.sha === "string" ? body.sha.toLowerCase() : "";
      if (!ref.startsWith("refs/") || !SHA40.test(sha)) {
        throw new HttpError(422, "Validation Failed");
      }
      if (repo.refs.has(ref)) throw new HttpError(422, "Reference already exists");
      const obj = repo.objects.get(sha);
      if (!obj || obj.type !== "commit") throw new HttpError(422, "Object does not exist");
      repo.refs.set(ref, sha);
      sendJson(res, store, 201, { ref, object: { sha, type: "commit" } });
      return;
    }

    // /api/v3/repos/{o}/{r}/contents/{path...}
    if (tail.length >= 1 && tail[0] === "contents") {
      const filePath = tail.slice(1).map((s) => decodeURIComponent(s)).join("/");
      if (method === "GET") {
        await getContents(store, req, res, repo, filePath, url);
        return;
      }
      if (method === "PUT") {
        await putContents(store, req, res, repo, filePath);
        return;
      }
      if (method === "DELETE") {
        await deleteContents(store, req, res, repo, filePath);
        return;
      }
      throw new HttpError(404, "Not Found");
    }

    // /api/v3/repos/{o}/{r}/labels
    if (tail.length === 1 && tail[0] === "labels") {
      if (method === "GET") {
        sendJson(res, store, 200, [...repo.labels.values()].map(labelJson));
        return;
      }
      if (method === "POST") {
        const body = await readJsonBody(req);
        const labelName = typeof body.name === "string" ? body.name : "";
        if (labelName === "") throw new HttpError(422, "Validation Failed");
        if (repo.labels.has(labelName)) throw new HttpError(422, `Label ${labelName} already exists`);
        const label: Label = {
          id: store.nextSeq(),
          name: labelName,
          color: typeof body.color === "string" ? body.color : "ededed",
          description: typeof body.description === "string" ? body.description : "",
        };
        repo.labels.set(labelName, label);
        sendJson(res, store, 201, labelJson(label));
        return;
      }
      throw new HttpError(404, "Not Found");
    }

    // /api/v3/repos/{o}/{r}/issues[/...]
    if (tail.length >= 1 && tail[0] === "issues") {
      if (tail.length === 1) {
        if (method === "GET") {
          await listIssues(store, req, res, repo, url);
          return;
        }
        if (method === "POST") {
          await createIssue(store, req, res, repo);
          return;
        }
        throw new HttpError(404, "Not Found");
      }
      const issueNumber = parseNumber(tail[1]);
      const issue = issueNumber >= 0 ? repo.issues.get(issueNumber) : undefined;
      if (!issue) throw new HttpError(404, "Not Found");
      if (tail.length === 2) {
        if (method === "GET") {
          sendJson(res, store, 200, issueJson(repo, issue));
          return;
        }
        if (method === "PATCH") {
          const body = await readJsonBody(req);
          if (body.state === "open" || body.state === "closed") issue.state = body.state;
          if (typeof body.title === "string") issue.title = body.title;
          if (typeof body.body === "string") issue.body = body.body;
          sendJson(res, store, 200, issueJson(repo, issue));
          return;
        }
        throw new HttpError(404, "Not Found");
      }
      if (tail.length === 3 && tail[2] === "comments") {
        if (method === "GET") {
          sendJson(res, store, 200, issue.comments.map((c) => commentJson(repo, issue, c)));
          return;
        }
        if (method === "POST") {
          const body = await readJsonBody(req);
          const comment: IssueComment = {
            id: store.nextSeq(),
            body: typeof body.body === "string" ? body.body : "",
            userLogin: repo.owner ?? "",
            createdSeq: store.nextSeq(),
          };
          issue.comments.push(comment);
          sendJson(res, store, 201, commentJson(repo, issue, comment));
          return;
        }
        throw new HttpError(404, "Not Found");
      }
      throw new HttpError(404, "Not Found");
    }

    // /api/v3/repos/{o}/{r}/pulls[/...]
    if (tail.length >= 1 && tail[0] === "pulls") {
      if (tail.length === 1) {
        if (method === "GET") {
          await listPulls(store, req, res, repo, url);
          return;
        }
        if (method === "POST") {
          await createPull(store, req, res, repo);
          return;
        }
        throw new HttpError(404, "Not Found");
      }
      const pullNumber = parseNumber(tail[1]);
      const pull = pullNumber >= 0 ? repo.pulls.get(pullNumber) : undefined;
      if (!pull) throw new HttpError(404, "Not Found");
      if (tail.length === 2) {
        if (method === "GET") {
          sendJson(res, store, 200, pullJson(repo, pull));
          return;
        }
        throw new HttpError(404, "Not Found");
      }
      if (tail.length === 3 && tail[2] === "files") {
        if (method !== "GET") throw new HttpError(404, "Not Found");
        await listPullFiles(store, res, repo, pull);
        return;
      }
      if (tail.length === 3 && tail[2] === "merge") {
        if (method !== "PUT") throw new HttpError(404, "Not Found");
        await mergePull(store, req, res, repo, pull);
        return;
      }
      throw new HttpError(404, "Not Found");
    }
  }

  throw new HttpError(404, "Not Found");
}

// ---------------------------------------------------------------------------
// Contents API (real git objects: blob + tree + commit on the target branch)
// ---------------------------------------------------------------------------

async function getContents(
  store: Store,
  _req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  filePath: string,
  url: URL,
): Promise<void> {
  const refParam = url.searchParams.get("ref");
  let tip: string | null = null;
  if (refParam) {
    tip = resolveRefParam(repo, refParam);
  } else {
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  if (!tip) throw new HttpError(404, "Not Found");
  const commitObj = repo.objects.get(tip);
  if (!commitObj || commitObj.type !== "commit") throw new HttpError(404, "Not Found");
  const treeOid = parseCommit(commitObj.data).tree;
  const flat = flattenTree(repo, treeOid);

  const file = flat.get(filePath);
  if (file) {
    const blob = repo.objects.get(file.oid);
    const data = blob ? blob.data : Buffer.alloc(0);
    sendJson(res, store, 200, {
      type: "file",
      encoding: "base64",
      content: data.toString("base64"),
      sha: file.oid,
      size: data.length,
      name: basename(filePath),
      path: filePath,
    });
    return;
  }

  // Directory listing: direct children of filePath ("": the root).
  const prefix = filePath === "" ? "" : `${filePath}/`;
  const entries: Array<Record<string, unknown>> = [];
  const seenDirs = new Set<string>();
  for (const [p, entry] of [...flat.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      const blob = repo.objects.get(entry.oid);
      entries.push({
        type: "file",
        name: rest,
        path: p,
        sha: entry.oid,
        size: blob ? blob.data.length : 0,
      });
    } else {
      const dirName = rest.slice(0, slash);
      if (seenDirs.has(dirName)) continue;
      seenDirs.add(dirName);
      const dirOid = subtreeOid(repo, treeOid, `${prefix}${dirName}`);
      entries.push({
        type: "dir",
        name: dirName,
        path: `${prefix}${dirName}`,
        sha: dirOid ?? "",
        size: 0,
      });
    }
  }
  if (entries.length === 0) throw new HttpError(404, "Not Found");
  sendJson(res, store, 200, entries);
}

async function putContents(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  filePath: string,
): Promise<void> {
  const body = await readJsonBody(req);
  const branchName =
    typeof body.branch === "string" && body.branch !== "" ? body.branch : repo.defaultBranch;
  const refName = `refs/heads/${branchName}`;
  const tip = repo.refs.get(refName);
  if (tip === undefined && branchName !== repo.defaultBranch) {
    throw new HttpError(422, `Branch ${branchName} does not exist`);
  }
  const contentB64 = typeof body.content === "string" ? body.content : "";
  const content = Buffer.from(contentB64.replace(/\s+/g, ""), "base64");
  const message =
    typeof body.message === "string" && body.message !== "" ? body.message : `Update ${filePath}`;

  const treeOid = tip ? parseCommit((repo.objects.get(tip) as { data: Buffer }).data).tree : null;
  const flat: Map<string, FlatEntry> = treeOid ? flattenTree(repo, treeOid) : new Map();
  const existing = flat.get(filePath);
  const sha = typeof body.sha === "string" ? body.sha.toLowerCase() : undefined;
  if (existing) {
    if (!sha) throw new HttpError(409, "sha is required to update an existing file");
    if (sha !== existing.oid.toLowerCase()) throw new HttpError(409, "sha does not match the current file");
  } else if (sha) {
    throw new HttpError(422, "sha does not match: the file does not exist");
  }

  const blobOid = hashObject("blob", content);
  if (!repo.objects.has(blobOid)) repo.objects.set(blobOid, { type: "blob", data: content });
  flat.set(filePath, { mode: "100644", oid: blobOid });
  const newTree = buildTreeFromPaths(repo, flat);
  const parents = tip ? [tip] : [];
  const commitOid = buildCommit(repo, newTree, parents, message, trialNowEpochSec());
  repo.refs.set(refName, commitOid);
  sendJson(res, store, existing ? 200 : 201, {
    content: {
      name: basename(filePath),
      path: filePath,
      sha: blobOid,
      size: content.length,
      type: "file",
      encoding: "base64",
    },
    commit: { sha: commitOid, message },
  });
}

async function deleteContents(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  filePath: string,
): Promise<void> {
  const body = await readJsonBody(req);
  const branchName =
    typeof body.branch === "string" && body.branch !== "" ? body.branch : repo.defaultBranch;
  const refName = `refs/heads/${branchName}`;
  const tip = repo.refs.get(refName);
  if (!tip) throw new HttpError(404, "Not Found");
  const treeOid = parseCommit((repo.objects.get(tip) as { data: Buffer }).data).tree;
  const flat = flattenTree(repo, treeOid);
  const existing = flat.get(filePath);
  if (!existing) throw new HttpError(404, "Not Found");
  const sha = typeof body.sha === "string" ? body.sha.toLowerCase() : undefined;
  if (sha && sha !== existing.oid.toLowerCase()) {
    throw new HttpError(409, "sha does not match the current file");
  }
  const message =
    typeof body.message === "string" && body.message !== "" ? body.message : `Delete ${filePath}`;
  flat.delete(filePath);
  const newTree = buildTreeFromPaths(repo, flat);
  const commitOid = buildCommit(repo, newTree, [tip], message, trialNowEpochSec());
  repo.refs.set(refName, commitOid);
  sendJson(res, store, 200, { commit: { sha: commitOid, message } });
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

async function createIssue(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
): Promise<void> {
  const body = await readJsonBody(req);
  const title = typeof body.title === "string" ? body.title : "";
  const issueBody = typeof body.body === "string" ? body.body : "";
  const rawLabels = Array.isArray(body.labels) ? body.labels : [];
  const labels: Label[] = [];
  for (const item of rawLabels) {
    const name =
      typeof item === "string"
        ? item
        : typeof (item as Record<string, unknown> | null)?.name === "string"
          ? ((item as Record<string, unknown>).name as string)
          : "";
    if (name === "") continue;
    const label = repo.labels.get(name);
    if (!label) throw new HttpError(422, `Label ${name} does not exist`);
    labels.push(label);
  }
  const number = repo.numberSeq;
  repo.numberSeq += 1;
  const issue: Issue = {
    id: store.nextSeq(),
    number,
    title,
    body: issueBody,
    state: "open",
    labels,
    comments: [],
    createdSeq: store.nextSeq(),
    userLogin: repo.owner ?? "",
  };
  repo.issues.set(number, issue);
  sendJson(res, store, 201, issueJson(repo, issue));
}

async function listIssues(
  store: Store,
  _req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  url: URL,
): Promise<void> {
  const state = url.searchParams.get("state") ?? "open";
  const sort = url.searchParams.get("sort") ?? "created";
  const direction = url.searchParams.get("direction") ?? "desc";
  let list = [...repo.issues.values()];
  if (state === "open") list = list.filter((i) => i.state === "open");
  else if (state === "closed") list = list.filter((i) => i.state === "closed");
  if (sort === "created") {
    list.sort((a, b) =>
      direction === "asc" ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq,
    );
  }
  const { page, link } = paginate(list, url, _req);
  sendJson(res, store, 200, page.map((i) => issueJson(repo, i)), linkHeader(link));
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

async function createPull(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
): Promise<void> {
  const body = await readJsonBody(req);
  const head = typeof body.head === "string" ? body.head : "";
  const base =
    typeof body.base === "string" && body.base !== "" ? body.base : repo.defaultBranch;
  const title = typeof body.title === "string" ? body.title : "";
  const pullBody = typeof body.body === "string" ? body.body : "";
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (!headSha || !baseSha) throw new HttpError(422, "head or base branch does not exist");
  const number = repo.numberSeq;
  repo.numberSeq += 1;
  const pull: Pull = {
    id: store.nextSeq(),
    number,
    title,
    body: pullBody,
    state: "open",
    headRef: head,
    headSha,
    baseRef: base,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdSeq: store.nextSeq(),
    userLogin: repo.owner ?? "",
  };
  repo.pulls.set(number, pull);
  sendJson(res, store, 201, pullJson(repo, pull));
}

async function listPulls(
  store: Store,
  _req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  url: URL,
): Promise<void> {
  const state = url.searchParams.get("state") ?? "open";
  let list = [...repo.pulls.values()];
  if (state === "open") list = list.filter((p) => p.state === "open");
  else if (state === "closed") list = list.filter((p) => p.state === "closed");
  list.sort((a, b) => b.createdSeq - a.createdSeq);
  const { page, link } = paginate(list, url, _req);
  sendJson(res, store, 200, page.map((p) => pullJson(repo, p)), linkHeader(link));
}

async function listPullFiles(
  store: Store,
  res: ServerResponse,
  repo: Repo,
  pull: Pull,
): Promise<void> {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const base = mergeBase(repo, headTip, baseTip);
  const baseTree = base
    ? parseCommit((repo.objects.get(base) as { data: Buffer }).data).tree
    : null;
  const headObj = repo.objects.get(headTip);
  if (!headObj || headObj.type !== "commit") throw new HttpError(404, "Not Found");
  const headTree = parseCommit(headObj.data).tree;
  const changes = diffTrees(repo, baseTree, headTree);
  sendJson(
    res,
    store,
    200,
    changes.map((c) => ({
      filename: c.filename,
      status: c.status,
      additions: c.additions,
      deletions: c.deletions,
      changes: c.additions + c.deletions,
    })),
  );
}

/** Squash-merge a pull request: three-way tree merge, deterministic commit. */
async function mergePull(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  pull: Pull,
): Promise<void> {
  if (pull.merged || pull.state === "closed") {
    throw new HttpError(405, "Pull request has already been merged");
  }
  await readJsonBody(req); // body carries merge_method; any method merges as squash
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!baseTip) throw new HttpError(404, "Not Found");
  const headObj = repo.objects.get(headTip);
  const baseObj = repo.objects.get(baseTip);
  if (!headObj || headObj.type !== "commit" || !baseObj || baseObj.type !== "commit") {
    throw new HttpError(404, "Not Found");
  }
  const base = mergeBase(repo, headTip, baseTip);
  const baseTree = base
    ? parseCommit((repo.objects.get(base) as { data: Buffer }).data).tree
    : null;
  const baseFlat = baseTree ? flattenTree(repo, baseTree) : new Map<string, FlatEntry>();
  const headFlat = flattenTree(repo, parseCommit(headObj.data).tree);
  const tipFlat = flattenTree(repo, parseCommit(baseObj.data).tree);
  const { merged, conflicts } = threeWayMerge(baseFlat, headFlat, tipFlat);
  if (!merged) {
    throw new HttpError(405, `Merge conflict in ${conflicts.join(", ")}`);
  }
  const newTree = buildTreeFromPaths(repo, merged);
  const message = `Merge pull request #${pull.number}: ${pull.title}`;
  const squashSha = buildCommit(repo, newTree, [baseTip], message, trialNowEpochSec());
  repo.refs.set(`refs/heads/${pull.baseRef}`, squashSha);
  pull.state = "closed";
  pull.merged = true;
  pull.mergedAt = trialNowIso();
  pull.mergeCommitSha = squashSha;
  pull.baseSha = squashSha;
  sendJson(res, store, 200, { sha: squashSha, merged: true, message });
}

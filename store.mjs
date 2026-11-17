// Raven Forge — store (M2 rebuild).
// One in-memory store shared by REST, GraphQL and MCP. All stored state is
// deterministic: timestamps come from a counter clock (fixed epoch + counter
// seconds) and IDs from a sequential counter, so identical operation
// sequences produce byte-identical state. No wall clock, no randomness.
import { GitRepo } from './git.mjs';

const EPOCH_MS = 1704067200000; // 2024-01-01T00:00:00Z
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const enc = encodeURIComponent;
const repoKey = (owner, name) => `${owner}/${name}`.toLowerCase();
const makeNodeId = (type, id) => Buffer.from(`${type}:${id}`).toString('base64');
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const needText = (value, field, required = false) => {
  if (typeof value !== 'string' || (required && !value.trim())) fail(422, `${field} must be ${required ? 'a non-empty' : 'a'} string`);
  return value;
};
const shortRef = ref => String(ref).replace(/^refs\/heads\//, '');
const isSafeRef = ref => typeof ref === 'string' && /^refs\/(heads|tags)\/.+/.test(ref)
  && !/[\x00-\x20\x7f~^:?*\[\\]/.test(ref) && !ref.includes('..') && !ref.includes('@{')
  && ref.split('/').every(p => p && !p.startsWith('.') && !p.endsWith('.') && !p.endsWith('.lock'));
const checkPath = path => {
  if (!path || path.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git') || /[\0\r\n]/.test(path)) fail(422, 'Invalid file path');
  return path;
};
const decodeB64 = value => {
  needText(value, 'content');
  const compact = value.replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.replace(/=+$/, '').length % 4 === 1) fail(422, 'content is not valid base64');
  return Buffer.from(compact, 'base64');
};
const respond = (status, body, headers) => headers ? { status, body, headers } : { status, body };

/** A single authenticated account; every API surface shares these domain objects. */
export class Store {
  constructor(options = {}) {
    if (typeof options === 'string') options = { login: options };
    this._login = options.login || '';
    this.baseUrl = (options.baseUrl || '').replace(/\/$/, '');
    this.repos = new Map();
    this._nodes = new Map();
    this._id = 2; // id 1 is the account user
    this._clock = 0;
    this._issueCache = new WeakMap();
    this._commitCache = new WeakMap();
  }
  get login() { return this._login || 'forge'; }
  set login(value) { this.bindLogin(value); }
  time() { return new Date(EPOCH_MS + this._clock++ * 1000).toISOString(); }
  bindLogin(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) fail(422, 'Invalid owner login');
    if (this._login) return this._login.toLowerCase() === value.toLowerCase();
    const previousLogin = this.login;
    this._login = value;
    const account = this.userJSON();
    const isAccountUser = user => user?.id === account.id || user?.login === previousLogin;
    const rebindUser = user => { if (isAccountUser(user)) Object.assign(user, account); return user; };
    const repos = [...this.repos.values()];
    this.repos.clear();
    for (const repo of repos) {
      repo.owner = rebindUser(repo.owner);
      repo.full_name = `${value}/${repo.name}`;
      this.repos.set(repoKey(value, repo.name), repo);
      for (const label of repo.labels.values()) label.url = `${this.repoPath(repo)}/labels/${enc(label.name)}`;
      for (const item of [...repo.issues.values(), ...repo.pulls.values()]) {
        rebindUser(item.user);
        if (item.merged_by) rebindUser(item.merged_by);
        item.assignees = item.assignees.map(user => typeof user === 'string' ? (user === previousLogin ? value : user) : rebindUser(user));
        for (const comment of item.comments) {
          rebindUser(comment.user);
          comment.url = `${this.repoPath(repo)}/issues/comments/${comment.id}`;
          comment.html_url = `${this.repoWeb(repo)}/issues/${item.number}#issuecomment-${comment.id}`;
          comment.issue_url = `${this.repoPath(repo)}/issues/${item.number}`;
        }
      }
    }
    this._issueCache = new WeakMap();
    return true;
  }
  userJSON() {
    return { login: this.login, id: 1, node_id: makeNodeId('User', 1), type: 'User', site_admin: false,
      name: this.login, avatar_url: '', url: `${this.baseUrl}/api/v3/users/${enc(this.login)}`,
      html_url: `${this.baseUrl}/${enc(this.login)}` };
  }
  getRepo(owner, name) {
    if (typeof owner !== 'string' || typeof name !== 'string') return undefined;
    // An initially anonymous account may be named by its first scoped
    // repository request. Allowed once, only for a repository already created.
    if (!this._login && this.repos.has(repoKey(this.login, name))) this.bindLogin(owner);
    if (owner.toLowerCase() !== this.login.toLowerCase()) return undefined;
    return this.repos.get(repoKey(owner, name));
  }
  repoPath(repo) { return `${this.baseUrl}/api/v3/repos/${enc(repo.owner.login)}/${enc(repo.name)}`; }
  repoWeb(repo) { return `${this.baseUrl}/${enc(repo.owner.login)}/${enc(repo.name)}`; }
  register(type, repo, value) { this._nodes.set(value.node_id, { type, repo, value }); return value; }
  node(id) { return this._nodes.get(id) || null; }
  createRepo(body) {
    if (!isObj(body)) fail(422, 'Expected a repository object');
    const name = needText(body.name, 'name', true);
    if (name.length > 100 || !/^[A-Za-z0-9_.-]+$/.test(name) || name === '.' || name === '..') fail(422, 'Invalid repository name');
    let owner = typeof body.owner === 'string' ? body.owner : body.owner?.login;
    owner ||= typeof body.user === 'string' ? body.user : body.user?.login;
    owner ||= body.login;
    if (!owner && typeof body.full_name === 'string' && body.full_name.endsWith(`/${name}`)) owner = body.full_name.slice(0, -name.length - 1);
    if (owner !== undefined && owner !== null && owner !== '') {
      if (typeof owner !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(owner)) fail(422, 'Invalid owner login');
      if (this._login && this._login.toLowerCase() !== owner.toLowerCase()) fail(404, 'Not Found');
    }
    if (this.repos.has(repoKey(this.login, name))) fail(422, 'Repository already exists');
    if (body.private !== undefined && typeof body.private !== 'boolean') fail(422, 'private must be a boolean');
    const description = body.description == null ? '' : needText(body.description, 'description');
    const branch = body.default_branch === undefined ? 'main' : needText(body.default_branch, 'default_branch', true);
    if (!isSafeRef(`refs/heads/${branch}`)) fail(422, 'Invalid default branch');
    const git = new GitRepo();
    git.defaultBranch = branch;
    if (body.auto_init) {
      const result = git.writeFile('README.md', Buffer.from(`# ${name}\n`), 'Initial commit', branch);
      this.validateRefTarget(git, `refs/heads/${branch}`, result.sha);
    }
    // Validation and isolated Git construction finish before publishing or
    // binding the account, so a rejected create leaves no trace behind.
    if (owner) this.bindLogin(owner);
    const id = this._id++, stamp = this.time();
    const repo = { id, node_id: makeNodeId('Repository', id), name, full_name: `${this.login}/${name}`,
      owner: this.userJSON(), description,
      private: body.private === true, default_branch: branch, created_at: stamp, updated_at: stamp,
      has_issues: body.has_issues !== false, archived: false, git,
      issues: new Map(), pulls: new Map(), labels: new Map(), comments: new Map(), nextNumber: 1 };
    this.repos.set(repoKey(this.login, name), repo);
    this.register('Repository', repo, repo);
    return repo;
  }
  repoJSON(repo) {
    const url = this.repoPath(repo), web = this.repoWeb(repo);
    let open = 0;
    for (const item of repo.issues.values()) if (item.state === 'open') open++;
    for (const item of repo.pulls.values()) if (item.state === 'open') open++;
    return { id: repo.id, node_id: repo.node_id, name: repo.name, full_name: repo.full_name,
      owner: repo.owner, private: repo.private, description: repo.description, fork: false,
      default_branch: repo.default_branch, visibility: repo.private ? 'private' : 'public',
      archived: repo.archived, disabled: false, has_issues: repo.has_issues, has_projects: true,
      has_wiki: true, has_downloads: true, is_template: false, allow_squash_merge: true,
      allow_merge_commit: false, allow_rebase_merge: false, created_at: repo.created_at,
      updated_at: repo.updated_at, pushed_at: repo.updated_at, open_issues: open, open_issues_count: open,
      forks: 0, forks_count: 0, stargazers_count: 0, watchers: 0, watchers_count: 0, size: 0, language: null,
      permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
      url, html_url: web, clone_url: `${web}.git`, git_url: `${web}.git`, ssh_url: `${web}.git`,
      contents_url: `${url}/contents/{+path}`, issues_url: `${url}/issues{/number}`,
      pulls_url: `${url}/pulls{/number}`, branches_url: `${url}/branches{/branch}`,
      commits_url: `${url}/commits{/sha}`, labels_url: `${url}/labels{/name}` };
  }
  label(repo, name) {
    if (typeof name !== 'string') return undefined;
    return repo.labels.get(name) || [...repo.labels.values()].find(l => l.name.toLowerCase() === name.toLowerCase());
  }
  labelsFor(repo, values) {
    if (values === undefined) return [];
    if (!Array.isArray(values)) fail(422, 'labels must be an array');
    const labels = [];
    for (const value of values) {
      const name = typeof value === 'string' ? value : value?.name;
      const label = this.label(repo, name);
      if (!label) fail(422, `Label does not exist: ${String(name)}`);
      if (!labels.includes(label)) labels.push(label);
    }
    return labels;
  }
  createIssue(repo, body = {}) {
    const title = needText(body.title, 'title', true);
    const detail = body.body == null ? '' : needText(body.body, 'body');
    const labels = this.labelsFor(repo, body.labels);
    const id = this._id++, stamp = this.time(), number = repo.nextNumber++;
    const issue = { id, node_id: makeNodeId('Issue', id), number, title, body: detail,
      state: 'open', state_reason: null, labels, user: this.userJSON(), assignees: [],
      created_at: stamp, updated_at: stamp, closed_at: null, comments: [], locked: false,
      milestone: null, _version: 0 };
    repo.issues.set(number, issue);
    repo.updated_at = stamp;
    return this.register('Issue', repo, issue);
  }
  touch(repo, item) {
    item.updated_at = this.time();
    item._version = (item._version || 0) + 1;
    repo.updated_at = item.updated_at;
    this._issueCache.delete(item);
    return item;
  }
  updateIssue(repo, item, body) {
    if (body.state !== undefined && !['open', 'closed'].includes(body.state)) fail(422, 'Invalid issue state');
    const changes = {};
    if (has(body, 'title')) changes.title = needText(body.title, 'title', true);
    if (has(body, 'body')) changes.body = body.body == null ? '' : needText(body.body, 'body');
    if (has(body, 'labels')) changes.labels = this.labelsFor(repo, body.labels);
    if (has(body, 'state_reason')) {
      if (body.state_reason !== null && !['completed', 'not_planned', 'reopened'].includes(body.state_reason)) fail(422, 'Invalid state_reason');
      changes.state_reason = body.state_reason;
    }
    if (item.merged && body.state === 'open') fail(422, 'A merged pull request cannot be reopened');
    if (repo.pulls.has(item.number)) {
      if (has(body, 'base')) {
        const ref = shortRef(needText(body.base, 'base', true)), sha = repo.git.refs.get(`refs/heads/${ref}`);
        if (!sha || ref === item.head.ref || item.merged || item.state !== 'open') fail(422, 'Invalid base branch');
        changes.base = { ref, sha };
      }
      // Capture live tips at the open -> closed transition, even if nobody
      // read the PR. A closed PR keeps this snapshot as branches advance.
      if (item.state === 'open' && body.state === 'closed') {
        const refs = this.pullRefs(repo, item);
        changes.head = refs.head;
        changes.base ||= refs.base;
      }
      if (item.state !== 'open' && body.state === 'open') {
        const refs = this.pullRefs(repo, { ...item, state: 'open' });
        changes.head = refs.head;
        changes.base = refs.base;
      }
    }
    if (body.state) changes.state = body.state;
    Object.assign(item, changes);
    this.touch(repo, item);
    if (body.state === 'closed') { item.closed_at ||= item.updated_at; item.state_reason ||= 'completed'; }
    if (body.state === 'open') { item.closed_at = null; item.state_reason = null; }
    return item;
  }
  issueJSON(repo, item) {
    const prior = this._issueCache.get(item);
    if (prior && prior.version === item._version && prior.state === item.state && prior.title === item.title
        && prior.text === item.body && prior.updated === item.updated_at && prior.count === item.comments.length) return prior.json;
    const url = `${this.repoPath(repo)}/issues/${item.number}`, web = this.repoWeb(repo);
    const json = { id: item.id, node_id: item.node_id, number: item.number, title: item.title, body: item.body,
      state: item.state, state_reason: item.state_reason, user: item.user, labels: item.labels,
      assignee: item.assignees[0] || null, assignees: item.assignees, milestone: item.milestone,
      locked: item.locked, active_lock_reason: null, comments: item.comments.length,
      created_at: item.created_at, updated_at: item.updated_at, closed_at: item.closed_at,
      author_association: 'OWNER', url, repository_url: this.repoPath(repo),
      html_url: `${web}/${repo.pulls.has(item.number) ? 'pull' : 'issues'}/${item.number}`,
      comments_url: `${url}/comments`, labels_url: `${url}/labels{/name}`, events_url: `${url}/events` };
    if (repo.pulls.has(item.number)) json.pull_request = {
      url: `${this.repoPath(repo)}/pulls/${item.number}`, html_url: `${web}/pull/${item.number}`,
      diff_url: `${web}/pull/${item.number}.diff`, patch_url: `${web}/pull/${item.number}.patch`, merged_at: item.merged_at,
    };
    this._issueCache.set(item, { version: item._version, state: item.state, title: item.title, text: item.body,
      updated: item.updated_at, count: item.comments.length, json, serialized: undefined });
    return json;
  }
  issueResponse(repo, item, status = 200) {
    const body = this.issueJSON(repo, item), cache = this._issueCache.get(item);
    cache.serialized ??= JSON.stringify(body);
    return { status, body, serialized: cache.serialized };
  }
  createComment(repo, item, body) {
    const content = needText(typeof body === 'string' ? body : body.body, 'body', true);
    const id = this._id++, stamp = this.time(), url = `${this.repoPath(repo)}/issues/comments/${id}`;
    const comment = { id, node_id: makeNodeId('IssueComment', id), body: content, user: this.userJSON(),
      created_at: stamp, updated_at: stamp, author_association: 'OWNER', url,
      html_url: `${this.repoWeb(repo)}/issues/${item.number}#issuecomment-${id}`,
      issue_url: `${this.repoPath(repo)}/issues/${item.number}` };
    item.comments.push(comment);
    repo.comments.set(id, { item, comment });
    this.register('IssueComment', repo, comment);
    this.touch(repo, item);
    return comment;
  }
  createPull(repo, body = {}) {
    const title = needText(body.title, 'title', true), detail = body.body == null ? '' : needText(body.body, 'body');
    let head = needText(body.head, 'head', true), base = needText(body.base, 'base', true);
    if (head.includes(':')) {
      const colon = head.indexOf(':');
      if (head.slice(0, colon).toLowerCase() !== repo.owner.login.toLowerCase()) fail(422, 'Head repository does not exist');
      head = head.slice(colon + 1);
    }
    head = shortRef(head); base = shortRef(base);
    if (!isSafeRef(`refs/heads/${head}`) || !isSafeRef(`refs/heads/${base}`) || head === base) fail(422, 'Invalid head or base branch');
    const headSha = repo.git.refs.get(`refs/heads/${head}`), baseSha = repo.git.refs.get(`refs/heads/${base}`);
    if (!headSha || !baseSha) fail(422, 'Head or base branch does not exist');
    if (headSha === baseSha) fail(422, 'No commits between base and head');
    for (const pull of repo.pulls.values()) if (pull.state === 'open' && pull.head.ref === head && pull.base.ref === base) fail(422, 'A pull request already exists for these branches');
    const labels = this.labelsFor(repo, body.labels);
    const id = this._id++, stamp = this.time(), number = repo.nextNumber++;
    const pull = { id, node_id: makeNodeId('PullRequest', id), number, title, body: detail, state: 'open',
      state_reason: null, labels, user: this.userJSON(), assignees: [], comments: [], milestone: null,
      locked: false, draft: body.draft === true, head: { ref: head, sha: headSha }, base: { ref: base, sha: baseSha },
      created_at: stamp, updated_at: stamp, closed_at: null, merged: false, merged_at: null,
      merge_commit_sha: null, mergeable: null, _version: 0 };
    repo.pulls.set(number, pull);
    repo.updated_at = stamp;
    return this.register('PullRequest', repo, pull);
  }
  pullRefs(repo, pull) {
    const read = ref => ({ ...ref, sha: pull.state === 'open' ? repo.git.refs.get(`refs/heads/${ref.ref}`) || ref.sha : ref.sha });
    return { head: read(pull.head), base: read(pull.base) };
  }
  pullJSON(repo, pull) {
    const refs = this.pullRefs(repo, pull);
    const url = `${this.repoPath(repo)}/pulls/${pull.number}`, web = `${this.repoWeb(repo)}/pull/${pull.number}`;
    const endpoint = ref => ({ ...ref, label: `${repo.owner.login}:${ref.ref}`, user: repo.owner,
      repo: { id: repo.id, node_id: repo.node_id, name: repo.name, full_name: repo.full_name,
        owner: repo.owner, private: repo.private, default_branch: repo.default_branch, url: this.repoPath(repo) } });
    return { ...this.issueJSON(repo, pull), url, html_url: web, diff_url: `${web}.diff`, patch_url: `${web}.patch`,
      issue_url: `${this.repoPath(repo)}/issues/${pull.number}`, head: endpoint(refs.head), base: endpoint(refs.base),
      merged: pull.merged, merged_at: pull.merged_at, merged_by: pull.merged ? this.userJSON() : null,
      merge_commit_sha: pull.merge_commit_sha, mergeable: pull.mergeable, mergeable_state: pull.mergeable === false ? 'dirty' : pull.mergeable === true ? 'clean' : 'unknown',
      draft: pull.draft, maintainer_can_modify: true, review_comments: 0, requested_reviewers: [], requested_teams: [] };
  }
  pullFiles(repo, pull) {
    const refs = this.pullRefs(repo, pull), head = refs.head.sha, base = refs.base.sha;
    return repo.git.diff(this.commonAncestor(repo.git, base, head) || base, head);
  }
  mergePull(repo, number, body = {}) {
    const pull = repo.pulls.get(Number(number));
    if (!pull) fail(404, 'Not Found');
    if (has(body, 'merge_method') && (typeof body.merge_method !== 'string' || body.merge_method.toLowerCase() !== 'squash')) fail(422, 'Only the squash merge method is supported');
    if (pull.state !== 'open' || pull.draft) fail(405, 'Pull request is not mergeable');
    const headRef = `refs/heads/${pull.head.ref}`, baseRef = `refs/heads/${pull.base.ref}`;
    const headSha = repo.git.refs.get(headRef), baseSha = repo.git.refs.get(baseRef);
    if (!headSha || !baseSha) fail(405, 'Head or base branch does not exist');
    this.validateRefTarget(repo.git, headRef, headSha);
    this.validateRefTarget(repo.git, baseRef, baseSha);
    if (body.sha && body.sha !== headSha) fail(409, 'Head branch was modified');
    const title = body.commit_title == null ? `${pull.title} (#${pull.number})` : needText(body.commit_title, 'commit_title');
    const message = title + (body.commit_message ? `\n\n${needText(body.commit_message, 'commit_message')}` : '');
    const result = this.mutateBranch(repo.git, baseRef, () => repo.git.merge(pull.head.ref, pull.base.ref, message));
    if (result.conflict) { pull.mergeable = false; fail(405, 'Pull request has merge conflicts'); }
    pull.head.sha = headSha; pull.base.sha = baseSha;
    pull.state = 'closed'; pull.merged = true; pull.mergeable = true; pull.merge_commit_sha = result.sha;
    this.touch(repo, pull);
    pull.closed_at = pull.updated_at; pull.merged_at = pull.updated_at;
    return { sha: result.sha, merged: true, message: 'Pull request successfully merged' };
  }
  commit(repo, sha) {
    const git = repo.git || repo;
    let cache = this._commitCache.get(git);
    if (!cache) this._commitCache.set(git, cache = new Map());
    if (cache.has(sha)) return cache.get(sha);
    const obj = git.get(sha);
    if (!obj || obj.type !== 'commit') return undefined;
    const raw = obj.data.toString('utf8'), cut = raw.indexOf('\n\n');
    const fields = { sha, tree: '', parents: [], author: {}, committer: {}, message: cut < 0 ? '' : raw.slice(cut + 2).replace(/\n$/, '') };
    for (const line of raw.slice(0, cut < 0 ? raw.length : cut).split('\n')) {
      const space = line.indexOf(' '), name = line.slice(0, space), value = line.slice(space + 1);
      if (name === 'tree') fields.tree = value;
      else if (name === 'parent') fields.parents.push(value);
      else if (name === 'author' || name === 'committer') {
        const parts = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(value);
        if (parts) fields[name] = { name: parts[1], email: parts[2], date: new Date(Number(parts[3]) * 1000).toISOString() };
      }
    }
    cache.set(sha, fields);
    return fields;
  }
  commitJSON(repo, sha) {
    const c = this.commit(repo, sha);
    if (!c) fail(404, 'Commit not found');
    const url = `${this.repoPath(repo)}/commits/${sha}`;
    return { sha, node_id: makeNodeId('Commit', sha), url, html_url: `${this.repoWeb(repo)}/commit/${sha}`,
      author: repo.owner, committer: repo.owner,
      commit: { author: c.author, committer: c.committer, message: c.message,
        tree: { sha: c.tree, url: `${this.repoPath(repo)}/git/trees/${c.tree}` },
        url: `${this.repoPath(repo)}/git/commits/${sha}`, comment_count: 0,
        verification: { verified: false, reason: 'unsigned', signature: null, payload: null } },
      parents: c.parents.map(parent => ({ sha: parent, url: `${this.repoPath(repo)}/commits/${parent}` })) };
  }
  ancestors(git, tip) {
    const result = new Set(), queue = tip ? [tip] : [];
    for (let i = 0; i < queue.length; i++) {
      const sha = queue[i];
      if (result.has(sha)) continue;
      result.add(sha);
      const commit = this.commit(git, sha);
      if (commit) queue.push(...commit.parents);
    }
    return result;
  }
  commonAncestor(git, left, right) {
    const lefts = this.ancestors(git, left), queue = right ? [right] : [], seen = new Set();
    for (let i = 0; i < queue.length; i++) {
      const sha = queue[i];
      if (lefts.has(sha)) return sha;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const c = this.commit(git, sha);
      if (c) queue.push(...c.parents);
    }
    return undefined;
  }
  tree(repo, sha) {
    const obj = repo.git.get(sha);
    if (!obj || obj.type !== 'tree') fail(404, 'Tree not found');
    const entries = [], data = obj.data;
    let pos = 0;
    while (pos < data.length) {
      const space = data.indexOf(32, pos), nul = data.indexOf(0, space + 1);
      if (space < 0 || nul < 0 || nul + 21 > data.length) fail(422, 'Invalid tree object');
      const mode = data.subarray(pos, space).toString(), path = data.subarray(space + 1, nul).toString();
      const id = data.subarray(nul + 1, nul + 21).toString('hex');
      const type = mode === '40000' || mode === '040000' ? 'tree' : mode === '160000' ? 'commit' : 'blob';
      entries.push({ path, mode: mode.padStart(6, '0'), type, sha: id });
      pos = nul + 21;
    }
    return entries;
  }
  directory(repo, ref, path = '') {
    let sha = this.commit(repo, repo.git.resolve(ref))?.tree;
    if (!sha) fail(404, 'Not Found');
    if (path) for (const component of path.split('/')) {
      const entry = this.tree(repo, sha).find(item => item.path === component && item.type === 'tree');
      if (!entry) fail(404, 'Not Found');
      sha = entry.sha;
    }
    return { sha, entries: this.tree(repo, sha) };
  }
  contentJSON(repo, path, file, ref, includeContent = true) {
    const name = path.slice(path.lastIndexOf('/') + 1), url = `${this.repoPath(repo)}/contents/${path.split('/').map(enc).join('/')}?ref=${enc(ref)}`;
    const html = `${this.repoWeb(repo)}/blob/${enc(ref)}/${path.split('/').map(enc).join('/')}`;
    const gitUrl = `${this.repoPath(repo)}/git/blobs/${file.sha}`;
    const json = { type: 'file', name, path, sha: file.sha, size: file.content.length, url,
      html_url: html, git_url: gitUrl, download_url: url, _links: { self: url, git: gitUrl, html } };
    if (includeContent) { json.encoding = 'base64'; json.content = file.content.toString('base64'); }
    return json;
  }
  validateRefName(git, ref) {
    if (!isSafeRef(ref)) fail(422, 'Invalid reference');
    for (const name of git.refs.keys()) {
      if (name !== ref && (name.startsWith(`${ref}/`) || ref.startsWith(`${name}/`))) fail(422, 'Reference conflicts with an existing reference');
    }
  }
  validateRefTarget(git, ref, sha) {
    this.validateRefName(git, ref);
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha) || !git.get(sha)) fail(422, 'Object does not exist');
    if (ref.startsWith('refs/heads/') && git.get(sha).type !== 'commit') fail(422, 'Branch must point to a commit');
    try { git.validateClosure(sha); }
    catch (error) { fail(422, `Invalid reference target: ${error.message}`); }
  }
  mutateBranch(git, ref, mutate) {
    this.validateRefName(git, ref);
    const previous = git.refs.get(ref);
    if (previous) this.validateRefTarget(git, ref, previous);
    try {
      const result = mutate();
      this.validateRefTarget(git, ref, git.refs.get(ref));
      return result;
    } catch (error) {
      if (previous === undefined) git.refs.delete(ref); else git.refs.set(ref, previous);
      throw error;
    }
  }
  refJSON(repo, ref, sha) {
    return { ref, node_id: makeNodeId('Ref', `${repo.id}:${ref}`), url: `${this.repoPath(repo)}/git/${ref}`,
      object: { type: repo.git.get(sha)?.type || 'commit', sha, url: `${this.repoPath(repo)}/git/commits/${sha}` } };
  }
  paginate(items, path, query, map = value => value) {
    const integer = (value, fallback, max) => /^\d+$/.test(value || '') ? Math.max(1, Math.min(max, Number(value))) : fallback;
    const per = integer(query.get('per_page'), 30, 100), page = integer(query.get('page'), 1, Number.MAX_SAFE_INTEGER);
    const start = (page - 1) * per, count = Math.max(1, Math.ceil(items.length / per));
    const link = (target, rel) => {
      const q = new URLSearchParams(query); q.set('page', String(target)); q.set('per_page', String(per));
      return `<${this.baseUrl}/api/v3${path}?${q}>; rel="${rel}"`;
    };
    const links = [];
    if (page < count) links.push(link(page + 1, 'next'), link(count, 'last'));
    if (page > 1) links.push(link(1, 'first'), link(page - 1, 'prev'));
    return respond(200, items.slice(start, start + per).map(map), links.length ? { Link: links.join(', ') } : undefined);
  }
  listIssues(repo, query, pullsOnly = false) {
    const state = query.get('state') || 'open', labels = (query.get('labels') || '').split(',').filter(Boolean);
    const items = pullsOnly ? [...repo.pulls.values()] : [...repo.issues.values(), ...repo.pulls.values()];
    const filtered = items.filter(item => (state === 'all' || item.state === state)
      && labels.every(label => item.labels.some(value => value.name.toLowerCase() === label.toLowerCase()))
      && (!query.has('creator') || item.user.login.toLowerCase() === query.get('creator').toLowerCase())
      && (!query.has('since') || item.updated_at >= query.get('since'))
      && (!query.has('base') || item.base?.ref === query.get('base'))
      && (!query.has('head') || `${repo.owner.login}:${item.head?.ref}` === query.get('head') || item.head?.ref === query.get('head')));
    const sort = query.get('sort') || 'created', direction = query.get('direction') === 'asc' ? 1 : -1;
    const field = sort === 'updated' ? 'updated_at' : 'created_at';
    filtered.sort((a, b) => direction * ((sort === 'comments' ? a.comments.length - b.comments.length : a[field].localeCompare(b[field])) || a.number - b.number));
    return filtered;
  }
  rest(method, path, body = {}, query = new URLSearchParams()) {
    try {
      method = method.toUpperCase();
      if (typeof path !== 'string') fail(400, 'Invalid request path');
      if (/^https?:\/\//i.test(path)) {
        const url = new URL(path);
        if (!this.baseUrl) this.baseUrl = url.origin;
        path = `${url.pathname}${url.search}`;
      }
      const question = path.indexOf('?');
      if (!(query instanceof URLSearchParams)) query = new URLSearchParams(query);
      if (question >= 0) {
        const inline = new URLSearchParams(path.slice(question + 1));
        for (const [name, value] of inline) if (!query.has(name)) query.set(name, value);
        path = path.slice(0, question);
      }
      path = path.replace(/^\/api\/v3(?=\/|$)/, '').replace(/\/$/, '') || '/';
      if (!path.startsWith('/')) path = `/${path}`;
      let segments;
      try { segments = path.slice(1).split('/').map(decodeURIComponent); }
      catch { fail(400, 'Invalid URL encoding'); }
      if (!isObj(body)) fail(400, 'Request body must be a JSON object');
      if (method === 'GET' && path === '/') return respond(200, {
        current_user_url: `${this.baseUrl}/api/v3/user`, current_user_repositories_url: `${this.baseUrl}/api/v3/user/repos`,
        repository_url: `${this.baseUrl}/api/v3/repos/{owner}/{repo}`, issues_url: `${this.baseUrl}/api/v3/issues`,
      }, { 'X-OAuth-Scopes': 'repo, user' });
      if (method === 'GET' && path === '/meta') return respond(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
      if (method === 'GET' && path === '/user') return respond(200, this.userJSON());
      if (segments[0] === 'users' && segments.length === 2 && method === 'GET') {
        if (segments[1].toLowerCase() !== this.login.toLowerCase()) fail(404, 'Not Found');
        return respond(200, this.userJSON());
      }
      const userRepos = path === '/user/repos' || (segments[0] === 'users' && segments[2] === 'repos' && segments.length === 3);
      if (userRepos) {
        if (segments[0] === 'users' && segments[1].toLowerCase() !== this.login.toLowerCase()) fail(404, 'Not Found');
        if (method === 'POST' && path === '/user/repos') {
          const repo = this.createRepo(body);
          return respond(201, this.repoJSON(repo), { Location: this.repoPath(repo) });
        }
        if (method === 'GET') {
          let repos = [...this.repos.values()];
          const type = query.get('type');
          if (type === 'private') repos = repos.filter(repo => repo.private);
          if (type === 'public') repos = repos.filter(repo => !repo.private);
          const sort = query.get('sort') || 'full_name', direction = (query.get('direction') || (sort === 'full_name' ? 'asc' : 'desc')) === 'asc' ? 1 : -1;
          const field = sort === 'created' ? 'created_at' : sort === 'updated' || sort === 'pushed' ? 'updated_at' : 'full_name';
          repos.sort((a, b) => direction * (a[field].localeCompare(b[field]) || a.id - b.id));
          return this.paginate(repos, path, query, repo => this.repoJSON(repo));
        }
      }
      if (segments[0] === 'search' && method === 'GET') return this.search(segments[1], query, path);
      if ((path === '/issues' || path === '/user/issues') && method === 'GET') {
        const rows = [...this.repos.values()].flatMap(repo => this.listIssues(repo, query).map(item => this.issueJSON(repo, item)));
        return this.paginate(rows, path, query);
      }
      if (segments[0] !== 'repos' || segments.length < 3) fail(404, 'Not Found');
      const repo = this.getRepo(segments[1], segments[2]);
      if (!repo) fail(404, 'Not Found');
      if (segments.length === 3) {
        if (method === 'GET') return respond(200, this.repoJSON(repo));
        if (method === 'DELETE') {
          this.repos.delete(repoKey(repo.owner.login, repo.name));
          for (const [id, node] of this._nodes) if (node.repo === repo) this._nodes.delete(id);
          return respond(204, null);
        }
        if (method === 'PATCH') {
          const changes = {};
          if (has(body, 'description')) changes.description = body.description == null ? '' : needText(body.description, 'description');
          if (has(body, 'private')) { if (typeof body.private !== 'boolean') fail(422, 'private must be a boolean'); changes.private = body.private; }
          if (has(body, 'archived')) changes.archived = body.archived === true;
          if (has(body, 'has_issues')) changes.has_issues = body.has_issues !== false;
          if (has(body, 'default_branch')) {
            const branch = needText(body.default_branch, 'default_branch', true);
            if (!repo.git.refs.has(`refs/heads/${branch}`)) fail(422, 'Default branch does not exist');
            changes.default_branch = branch;
          }
          Object.assign(repo, changes);
          repo.git.defaultBranch = repo.default_branch;
          repo.updated_at = this.time();
          return respond(200, this.repoJSON(repo));
        }
      }
      const route = segments.slice(3), endpoint = route[0];
      if (endpoint === 'contents') return this.contents(repo, method, route.slice(1).join('/'), body, query);
      if (endpoint === 'git') return this.gitRest(repo, method, route.slice(1), body, query, path);
      if (endpoint === 'labels') return this.labelsRest(repo, method, route.slice(1), body, query, path);
      if (endpoint === 'issues' || endpoint === 'pulls') return this.itemsRest(repo, endpoint, method, route.slice(1), body, query, path);
      if (endpoint === 'branches' && method === 'GET') {
        const branch = name => { const sha = repo.git.refs.get(`refs/heads/${name}`); if (!sha) fail(404, 'Branch not found'); return { name, commit: { sha, url: `${this.repoPath(repo)}/commits/${sha}` }, protected: false }; };
        if (route.length > 1) return respond(200, branch(route.slice(1).join('/')));
        return this.paginate([...repo.git.refs.keys()].filter(ref => ref.startsWith('refs/heads/')).map(ref => ref.slice(11)).sort(), path, query, branch);
      }
      if (endpoint === 'commits' && method === 'GET') {
        const ref = route.length > 1 ? route.slice(1).join('/') : query.get('sha') || repo.default_branch;
        const sha = repo.git.resolve(ref);
        if (!sha) { if (repo.git.refs.size === 0 && route.length === 1) return respond(200, []); fail(404, 'Commit not found'); }
        if (route.length > 1) return respond(200, this.commitJSON(repo, sha));
        return this.paginate([...this.ancestors(repo.git, sha)], path, query, id => this.commitJSON(repo, id));
      }
      if (endpoint === 'compare' && method === 'GET') {
        const [base, head] = route.slice(1).join('/').split('...');
        const baseSha = repo.git.resolve(base), headSha = repo.git.resolve(head);
        if (!baseSha || !headSha) fail(404, 'Commit not found');
        const ancestors = this.ancestors(repo.git, baseSha), headAncestors = this.ancestors(repo.git, headSha);
        const commits = [...headAncestors].filter(id => !ancestors.has(id));
        return respond(200, { status: baseSha === headSha ? 'identical' : ancestors.has(headSha) ? 'behind' : 'ahead', ahead_by: commits.length,
          behind_by: [...ancestors].filter(id => !headAncestors.has(id)).length,
          total_commits: commits.length, base_commit: this.commitJSON(repo, baseSha),
          merge_base_commit: this.commitJSON(repo, this.commonAncestor(repo.git, baseSha, headSha) || baseSha),
          commits: commits.reverse().map(id => this.commitJSON(repo, id)), files: repo.git.diff(baseSha, headSha) });
      }
      fail(404, 'Not Found');
    } catch (error) {
      if (error.status) return respond(error.status, { message: error.message });
      throw error;
    }
  }
  contents(repo, method, path, body, query) {
    const ref = method === 'GET' ? query.get('ref') || repo.default_branch : body.branch || repo.default_branch;
    const tip = repo.git.resolve(ref);
    if (!tip && (method === 'GET' || repo.git.refs.size)) fail(404, 'Branch or ref not found');
    if (method === 'PUT' || method === 'DELETE') {
      const branchRef = `refs/heads/${shortRef(ref)}`;
      this.validateRefName(repo.git, branchRef);
      if (tip && !repo.git.refs.has(branchRef)) fail(422, 'A branch is required for a content mutation');
      if (tip) this.validateRefTarget(repo.git, branchRef, tip);
    }
    const files = repo.git.files(ref), existing = files.get(path);
    if (method === 'GET') {
      if (existing) return respond(200, this.contentJSON(repo, path, existing, ref));
      const directory = this.directory(repo, ref, path);
      return respond(200, directory.entries.map(entry => {
        const child = path ? `${path}/${entry.path}` : entry.path;
        if (entry.type === 'blob') return this.contentJSON(repo, child, files.get(child) || { sha: entry.sha, content: repo.git.get(entry.sha)?.data || Buffer.alloc(0) }, ref, false);
        return { type: entry.type === 'tree' ? 'dir' : 'file', name: entry.path, path: child, sha: entry.sha, size: 0,
          url: `${this.repoPath(repo)}/contents/${child.split('/').map(enc).join('/')}?ref=${enc(ref)}` };
      }));
    }
    if (method !== 'PUT' && method !== 'DELETE') fail(404, 'Not Found');
    checkPath(path);
    const message = needText(body.message, 'message', true);
    if (method === 'DELETE' && !existing) fail(404, 'Not Found');
    if (existing && !body.sha) fail(422, 'sha is required to update or delete a file');
    if (body.sha && body.sha !== existing?.sha) fail(409, 'The supplied sha does not match the current file');
    for (const candidate of files.keys()) if (candidate !== path && (candidate.startsWith(`${path}/`) || path.startsWith(`${candidate}/`))) fail(422, 'Path conflicts with an existing file or directory');
    const data = method === 'PUT' ? decodeB64(body.content) : Buffer.alloc(0);
    const result = this.mutateBranch(repo.git, `refs/heads/${shortRef(ref)}`, () => repo.git.writeFile(path, data, message, shortRef(ref), method === 'DELETE'));
    repo.updated_at = this.time();
    return respond(method === 'PUT' && !existing ? 201 : 200, { content: method === 'DELETE' ? null : this.contentJSON(repo, path, { sha: result.blobSha, content: data }, ref), commit: this.commitJSON(repo, result.sha) });
  }
  labelsRest(repo, method, parts, body, query, path) {
    const name = parts.join('/');
    if (!name && method === 'GET') return this.paginate([...repo.labels.values()], path, query);
    const existing = name ? this.label(repo, name) : undefined;
    if (name && !existing) fail(404, 'Label not found');
    if (method === 'GET') return respond(200, existing);
    if (method === 'DELETE' && existing) {
      repo.labels.delete(existing.name);
      this._nodes.delete(existing.node_id);
      for (const item of [...repo.issues.values(), ...repo.pulls.values()]) {
        if (item.labels.includes(existing)) { item.labels = item.labels.filter(label => label !== existing); this.touch(repo, item); }
      }
      return respond(204, null);
    }
    if ((method === 'POST' && !name) || (method === 'PATCH' && existing)) {
      const newName = needText(body.new_name ?? body.name ?? existing?.name, 'name', true);
      const duplicate = this.label(repo, newName);
      if (duplicate && duplicate !== existing) fail(422, 'Label already exists');
      const color = body.color ?? existing?.color ?? 'ededed';
      if (typeof color !== 'string' || !/^[0-9a-f]{6}$/i.test(color)) fail(422, 'color must be six hexadecimal digits');
      const description = body.description == null ? existing?.description ?? null : needText(body.description, 'description');
      let label = existing;
      if (!label) { const id = this._id++; label = { id, node_id: makeNodeId('Label', id), default: false }; }
      if (existing) repo.labels.delete(existing.name);
      Object.assign(label, { name: newName, color: color.toLowerCase(), description, url: `${this.repoPath(repo)}/labels/${enc(newName)}` });
      repo.labels.set(newName, label);
      this.register('Label', repo, label);
      for (const item of [...repo.issues.values(), ...repo.pulls.values()]) if (item.labels.includes(label)) this.touch(repo, item);
      return respond(existing ? 200 : 201, label);
    }
    fail(404, 'Not Found');
  }
  itemsRest(repo, endpoint, method, parts, body, query, path) {
    const pulls = endpoint === 'pulls';
    if (!parts.length) {
      if (method === 'POST') {
        const item = pulls ? this.createPull(repo, body) : this.createIssue(repo, body);
        return pulls ? respond(201, this.pullJSON(repo, item)) : this.issueResponse(repo, item, 201);
      }
      if (method === 'GET') return this.paginate(this.listIssues(repo, query, pulls), path, query, item => pulls ? this.pullJSON(repo, item) : this.issueJSON(repo, item));
    }
    if (!pulls && parts[0] === 'comments') {
      if (parts.length === 1 && method === 'GET') return this.paginate([...repo.comments.values()].map(value => value.comment), path, query);
      const found = repo.comments.get(Number(parts[1]));
      if (!found || parts.length !== 2) fail(404, 'Comment not found');
      if (method === 'GET') return respond(200, found.comment);
      if (method === 'PATCH') { found.comment.body = needText(body.body, 'body', true); this.touch(repo, found.item); found.comment.updated_at = found.item.updated_at; return respond(200, found.comment); }
      if (method === 'DELETE') { repo.comments.delete(found.comment.id); this._nodes.delete(found.comment.node_id); found.item.comments = found.item.comments.filter(comment => comment !== found.comment); this.touch(repo, found.item); return respond(204, null); }
    }
    if (!/^[1-9]\d*$/.test(parts[0] || '')) fail(404, 'Not Found');
    const number = Number(parts[0]), item = pulls ? repo.pulls.get(number) : repo.issues.get(number) || repo.pulls.get(number);
    if (!item) fail(404, 'Not Found');
    if (parts.length === 1) {
      if (method === 'PATCH') {
        this.updateIssue(repo, item, body);
      } else if (method !== 'GET') fail(404, 'Not Found');
      return pulls ? respond(200, this.pullJSON(repo, item)) : this.issueResponse(repo, item);
    }
    const action = parts[1];
    if (pulls && action === 'merge' && parts.length === 2) {
      if (method === 'PUT') return respond(200, this.mergePull(repo, number, body));
      if (method === 'GET') return respond(item.merged ? 204 : 404, item.merged ? null : { message: 'Not Found' });
    }
    if (pulls && action === 'files' && parts.length === 2 && method === 'GET') return this.paginate(this.pullFiles(repo, item), path, query);
    if (pulls && action === 'commits' && parts.length === 2 && method === 'GET') {
      const refs = this.pullRefs(repo, item);
      const base = this.ancestors(repo.git, refs.base.sha);
      const head = this.ancestors(repo.git, refs.head.sha);
      return this.paginate([...head].filter(sha => !base.has(sha)).reverse(), path, query, sha => this.commitJSON(repo, sha));
    }
    if (!pulls && action === 'comments' && parts.length === 2) {
      if (method === 'POST') return respond(201, this.createComment(repo, item, body));
      if (method === 'GET') return this.paginate(item.comments, path, query);
    }
    if (!pulls && action === 'labels') {
      if (method === 'GET' && parts.length === 2) return respond(200, item.labels);
      if ((method === 'POST' || method === 'PUT') && parts.length === 2) {
        const labels = this.labelsFor(repo, body.labels);
        item.labels = method === 'PUT' ? labels : [...new Set([...item.labels, ...labels])];
        this.touch(repo, item);
        return respond(200, item.labels);
      }
      if (method === 'DELETE') {
        if (parts.length === 2) item.labels = [];
        else { const label = this.label(repo, parts.slice(2).join('/')); if (!label || !item.labels.includes(label)) fail(404, 'Label not found'); item.labels = item.labels.filter(value => value !== label); }
        this.touch(repo, item); return respond(200, item.labels);
      }
    }
    if (!pulls && action === 'lock' && parts.length === 2 && (method === 'PUT' || method === 'DELETE')) {
      item.locked = method === 'PUT'; this.touch(repo, item); return respond(204, null);
    }
    fail(404, 'Not Found');
  }
  gitRest(repo, method, parts, body, query, path) {
    const type = parts[0], suffix = parts.slice(1).join('/'), git = repo.git;
    if (['refs', 'ref', 'matching-refs'].includes(type)) {
      const ref = suffix.startsWith('refs/') ? suffix : `refs/${suffix}`;
      if (method === 'GET') {
        if (suffix && git.refs.has(ref) && type !== 'matching-refs') return respond(200, this.refJSON(repo, ref, git.refs.get(ref)));
        if (type === 'ref') fail(404, 'Reference not found');
        const matches = [...git.refs].filter(([name]) => !suffix || name.startsWith(ref)).sort(([a], [b]) => a.localeCompare(b));
        if (!matches.length && suffix && type !== 'matching-refs') fail(404, 'Reference not found');
        return this.paginate(matches, path, query, ([name, sha]) => this.refJSON(repo, name, sha));
      }
      if (method === 'POST' && type === 'refs' && !suffix) {
        this.validateRefName(git, body.ref);
        if (git.refs.has(body.ref)) fail(422, 'Reference already exists');
        this.validateRefTarget(git, body.ref, body.sha);
        git.refs.set(body.ref, body.sha); repo.updated_at = this.time();
        return respond(201, this.refJSON(repo, body.ref, body.sha));
      }
      if (method === 'PATCH' && suffix) {
        const previous = git.refs.get(ref);
        if (!previous) fail(404, 'Reference not found');
        if (has(body, 'force') && typeof body.force !== 'boolean') fail(422, 'force must be a boolean');
        this.validateRefTarget(git, ref, body.sha);
        if (!body.force && !this.ancestors(git, body.sha).has(previous)) fail(422, 'Update is not a fast forward');
        git.refs.set(ref, body.sha); repo.updated_at = this.time();
        return respond(200, this.refJSON(repo, ref, body.sha));
      }
      if (method === 'DELETE' && suffix) {
        if (!git.refs.has(ref)) fail(404, 'Reference not found');
        if (ref === `refs/heads/${repo.default_branch}`) fail(422, 'Cannot delete the default branch');
        git.refs.delete(ref); repo.updated_at = this.time(); return respond(204, null);
      }
    }
    if (type === 'blobs') {
      if (method === 'GET' && parts.length === 2) {
        const blob = git.get(suffix);
        if (blob?.type !== 'blob') fail(404, 'Blob not found');
        return respond(200, { sha: suffix, node_id: makeNodeId('Blob', suffix), size: blob.data.length, encoding: 'base64', content: blob.data.toString('base64'), url: `${this.repoPath(repo)}/git/blobs/${suffix}` });
      }
      if (method === 'POST' && parts.length === 1) {
        const encoding = body.encoding || 'utf-8';
        if (encoding !== 'base64' && encoding !== 'utf-8') fail(422, 'Invalid blob encoding');
        const data = encoding === 'base64' ? decodeB64(body.content) : Buffer.from(needText(body.content, 'content'));
        const sha = git.put('blob', data);
        return respond(201, { sha, url: `${this.repoPath(repo)}/git/blobs/${sha}` });
      }
    }
    if (type === 'commits') {
      const render = sha => {
        const commit = this.commit(repo, sha); if (!commit) fail(404, 'Commit not found');
        return { sha, node_id: makeNodeId('Commit', sha), url: `${this.repoPath(repo)}/git/commits/${sha}`, message: commit.message,
          author: commit.author, committer: commit.committer, tree: { sha: commit.tree, url: `${this.repoPath(repo)}/git/trees/${commit.tree}` },
          parents: commit.parents.map(parent => ({ sha: parent, url: `${this.repoPath(repo)}/git/commits/${parent}` })) };
      };
      if (method === 'GET' && parts.length === 2) return respond(200, render(git.resolve(suffix) || suffix));
      if (method === 'POST' && parts.length === 1) {
        const message = needText(body.message, 'message', true);
        if (git.get(body.tree)?.type !== 'tree' || !Array.isArray(body.parents) || body.parents.some(parent => git.get(parent)?.type !== 'commit')) fail(422, 'Invalid tree or parents');
        const seconds = Math.floor((EPOCH_MS + this._clock++ * 1000) / 1000);
        const identity = who => {
          const name = who?.name || this.login, email = who?.email || `${this.login}@localhost`;
          if (typeof name !== 'string' || typeof email !== 'string' || /[\n\r<>]/.test(name + email)) fail(422, 'Invalid commit identity');
          const time = who?.date ? Date.parse(who.date) : seconds * 1000;
          if (!Number.isFinite(time)) fail(422, 'Invalid commit date');
          return `${name} <${email}> ${Math.floor(time / 1000)} +0000`;
        };
        const raw = `tree ${body.tree}\n${body.parents.map(parent => `parent ${parent}\n`).join('')}author ${identity(body.author)}\ncommitter ${identity(body.committer || body.author)}\n\n${message}\n`;
        return respond(201, render(git.put('commit', Buffer.from(raw))));
      }
    }
    if (type === 'trees' && method === 'GET' && parts.length === 2) {
      let sha = git.resolve(suffix) || suffix;
      if (git.get(sha)?.type === 'commit') sha = this.commit(repo, sha).tree;
      const rows = [], walk = (id, prefix, depth) => {
        if (depth > 100) fail(422, 'Tree nesting is too deep');
        for (const item of this.tree(repo, id)) {
          const entry = { ...item, path: prefix + item.path, url: `${this.repoPath(repo)}/git/${item.type === 'tree' ? 'trees' : item.type === 'blob' ? 'blobs' : 'commits'}/${item.sha}` };
          if (item.type === 'blob') entry.size = git.get(item.sha)?.data.length || 0;
          rows.push(entry);
          if (query.get('recursive') === '1' && item.type === 'tree') walk(item.sha, `${entry.path}/`, depth + 1);
        }
      };
      walk(sha, '', 0);
      return respond(200, { sha, url: `${this.repoPath(repo)}/git/trees/${sha}`, tree: rows, truncated: false });
    }
    fail(404, 'Not Found');
  }
  search(type, query, path) {
    if (type !== 'issues' && type !== 'repositories') fail(404, 'Not Found');
    const tokens = (query.get('q') || '').match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    const terms = [], filters = [];
    for (const token of tokens) {
      const colon = token.indexOf(':');
      if (colon > 0) filters.push([token.slice(0, colon).toLowerCase(), token.slice(colon + 1).replace(/^"|"$/g, '').toLowerCase()]);
      else terms.push(token.replace(/^"|"$/g, '').toLowerCase());
    }
    const matchesRepo = repo => filters.every(([name, value]) => name === 'repo' ? repo.full_name.toLowerCase() === value
      : name === 'user' || name === 'org' ? repo.owner.login.toLowerCase() === value
      : name === 'is' && ['private', 'public'].includes(value) ? repo.private === (value === 'private') : true);
    const results = [];
    for (const repo of this.repos.values()) {
      if (!matchesRepo(repo)) continue;
      if (type === 'repositories') {
        if (terms.every(term => `${repo.name} ${repo.description}`.toLowerCase().includes(term))) results.push(this.repoJSON(repo));
        continue;
      }
      for (const item of [...repo.issues.values(), ...repo.pulls.values()]) {
        const pull = repo.pulls.has(item.number);
        const fields = filters.find(([name]) => name === 'in')?.[1]?.split(',') || ['title', 'body'];
        const haystack = fields.map(field => field === 'comments' ? item.comments.map(c => c.body).join(' ') : item[field] || '').join(' ').toLowerCase();
        if (!terms.every(term => haystack.includes(term))) continue;
        if (!filters.every(([name, value]) => {
          if (name === 'is' || name === 'type') {
            if (value === 'pr' || value === 'pull-request') return pull;
            if (value === 'issue') return !pull;
            if (value === 'open' || value === 'closed') return item.state === value;
            if (value === 'merged') return item.merged === true;
            if (value === 'unmerged') return pull && !item.merged;
          }
          if (name === 'state') return item.state === value;
          if (name === 'label') return item.labels.some(label => label.name.toLowerCase() === value);
          if (name === 'author') return item.user.login.toLowerCase() === value || value === '@me';
          return true;
        })) continue;
        results.push(this.issueJSON(repo, item));
      }
    }
    const sort = query.get('sort') || 'created', direction = query.get('order') === 'asc' ? 1 : -1;
    results.sort((a, b) => direction * ((sort === 'comments' ? a.comments - b.comments : String(a[sort === 'updated' ? 'updated_at' : 'created_at']).localeCompare(String(b[sort === 'updated' ? 'updated_at' : 'created_at']))) || a.id - b.id));
    const page = this.paginate(results, path, query);
    return { ...page, body: { total_count: results.length, incomplete_results: false, items: page.body } };
  }
}

export const rest = (store, method, path, body = {}, query = new URLSearchParams()) => store.rest(method, path, body, query);
export default Store;

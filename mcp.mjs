// Raven Forge — MCP endpoint (M3 rebuild).
// Stateless Streamable HTTP JSON-RPC 2.0. Every tool call runs through the
// shared REST layer, so MCP reads and writes the same objects as REST and
// GraphQL. No per-connection state is kept.
const str = description => ({ type: 'string', description });
const integer = description => ({ type: 'integer', minimum: 1, description });
const ownerRepo = { owner: str('Repository owner login'), repo: str('Repository name') };
const defineTool = (name, description, properties, required) =>
  Object.freeze({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } });
const TOOLS = Object.freeze([
  defineTool('create_repo', 'Create a repository owned by the authenticated user.',
    { name: str('Repository name'), description: str('Repository description'), private: { type: 'boolean' } }, ['name']),
  defineTool('get_repo', 'Read repository metadata.', ownerRepo, ['owner', 'repo']),
  defineTool('create_issue', 'Create an issue in a repository.',
    { ...ownerRepo, title: str('Issue title'), body: str('Issue body'), labels: { type: 'array', items: { type: 'string' } } }, ['owner', 'repo', 'title']),
  defineTool('list_issues', 'List repository issues with optional state and pagination.',
    { ...ownerRepo, state: { type: 'string', enum: ['open', 'closed', 'all'] }, page: integer('Page number'), per_page: { type: 'integer', minimum: 1, maximum: 100 } }, ['owner', 'repo']),
  defineTool('create_pull_request', 'Open a pull request between existing Git branches.',
    { ...ownerRepo, title: str('Pull request title'), body: str('Pull request description'), head: str('Head branch'), base: str('Base branch') }, ['owner', 'repo', 'title', 'head', 'base']),
  defineTool('merge_pull_request', 'Squash and merge a conflict-free pull request.',
    { ...ownerRepo, pull_number: integer('Pull request number'), commit_title: str('Merge commit title') }, ['owner', 'repo', 'pull_number']),
  defineTool('get_issue', 'Read an issue by its repository issue number.',
    { ...ownerRepo, issue_number: integer('Issue number') }, ['owner', 'repo', 'issue_number']),
  defineTool('update_issue', 'Update issue title, body or state.',
    { ...ownerRepo, issue_number: integer('Issue number'), title: str('Issue title'), body: str('Issue body'), state: { type: 'string', enum: ['open', 'closed'] } }, ['owner', 'repo', 'issue_number']),
  defineTool('get_file_contents', 'Read a file or directory from a Git ref.',
    { ...ownerRepo, path: str('File or directory path'), ref: str('Branch, tag or commit') }, ['owner', 'repo', 'path']),
  defineTool('create_or_update_file', 'Commit base64-encoded content to a branch.',
    { ...ownerRepo, path: str('File path'), content: str('Base64 file bytes'), message: str('Commit message'), sha: str('Current blob SHA, required on update'), branch: str('Target branch') }, ['owner', 'repo', 'path', 'content', 'message']),
]);
const toolsByName = new Map(TOOLS.map(t => [t.name, t]));
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = Object.freeze({ name: 'raven-forge', version: '1.0.0' });
const CAPABILITIES = Object.freeze({ tools: { listChanged: false } });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const rpcResult = (id, value) => ({ jsonrpc: '2.0', id, result: value });
const enc = encodeURIComponent;

function checkArguments(schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object';
  for (const key of schema.required ?? []) {
    if (!(key in args)) return `Missing required argument: ${key}`;
  }
  for (const [key, value] of Object.entries(args)) {
    // Clients may attach owner/repo as full_name; owner and repo already
    // carry that information, so it is accepted and ignored here.
    if (key === 'full_name') continue;
    const s = schema.properties[key];
    if (!s) {
      if (!schema.additionalProperties) return `Unknown argument: ${key}`;
      continue;
    }
    if (s.type === 'string' && (typeof value !== 'string' || ((schema.required ?? []).includes(key) && value.length === 0))) {
      return `${key} must be a nonempty string`;
    }
    if (s.type === 'integer' && (!Number.isInteger(value) || (s.minimum !== undefined && value < s.minimum) || (s.maximum !== undefined && value > s.maximum))) {
      return `${key} must be an integer within its bounds`;
    }
    if (s.type === 'boolean' && typeof value !== 'boolean') return `${key} must be a boolean`;
    if (s.type === 'array' && (!Array.isArray(value) || value.some(v => typeof v !== 'string'))) {
      return `${key} must be an array of strings`;
    }
    if (s.enum && !s.enum.includes(value)) return `Invalid ${key}`;
  }
  return null;
}

function routeTool(name, a) {
  const root = `/repos/${enc(a.owner ?? '')}/${enc(a.repo ?? '')}`;
  const q = new URLSearchParams();
  for (const k of ['state', 'page', 'per_page', 'ref']) if (a[k] !== undefined) q.set(k, String(a[k]));
  switch (name) {
    case 'create_repo': return ['POST', '/user/repos', a, q];
    case 'get_repo': return ['GET', root, {}, q];
    case 'create_issue': return ['POST', `${root}/issues`, a, q];
    case 'list_issues': return ['GET', `${root}/issues`, {}, q];
    case 'get_issue': return ['GET', `${root}/issues/${a.issue_number}`, {}, q];
    case 'update_issue': return ['PATCH', `${root}/issues/${a.issue_number}`, a, q];
    case 'create_pull_request': return ['POST', `${root}/pulls`, a, q];
    case 'merge_pull_request': return ['PUT', `${root}/pulls/${a.pull_number}/merge`, a, q];
    case 'get_file_contents': return ['GET', `${root}/contents/${String(a.path).split('/').map(enc).join('/')}`, {}, q];
    case 'create_or_update_file': return ['PUT', `${root}/contents/${String(a.path).split('/').map(enc).join('/')}`, a, q];
    default: return null;
  }
}

async function handleOne(msg, store) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(msg?.id, -32600, 'Invalid JSON-RPC request');
  }
  const isNotification = !Object.hasOwn(msg, 'id');
  const p = msg.params ?? {};
  if (isNotification) return null;
  if (msg.id !== null && typeof msg.id !== 'string' && typeof msg.id !== 'number') {
    return rpcError(null, -32600, 'Invalid request id');
  }
  switch (msg.method) {
    case 'server/discover':
      return rpcResult(msg.id, { serverInfo: SERVER_INFO, capabilities: CAPABILITIES, supportedVersions: SUPPORTED_VERSIONS });
    case 'initialize':
      return rpcResult(msg.id, {
        serverInfo: SERVER_INFO, capabilities: CAPABILITIES,
        protocolVersion: SUPPORTED_VERSIONS.includes(p.protocolVersion) ? p.protocolVersion : SUPPORTED_VERSIONS[0],
        instructions: 'Repository, issue, pull request and Git content tools share one consistent store.',
      });
    case 'ping':
      return rpcResult(msg.id, {});
    case 'tools/list':
      return rpcResult(msg.id, { tools: TOOLS });
    case 'tools/call': {
      const t = toolsByName.get(p.name);
      if (!t) return rpcError(msg.id, -32602, `Unknown tool: ${String(p.name)}`);
      const invalid = checkArguments(t.inputSchema, p.arguments);
      if (invalid) return rpcError(msg.id, -32602, invalid);
      try {
        const r = store.rest(...routeTool(t.name, p.arguments));
        const failed = r.status >= 400;
        const value = r.body ?? {};
        return rpcResult(msg.id, {
          content: [{ type: 'text', text: JSON.stringify(value) }],
          structuredContent: Array.isArray(value) ? { items: value } : value,
          ...(failed ? { isError: true } : {}),
        });
      } catch (e) {
        return rpcResult(msg.id, { content: [{ type: 'text', text: e.message || 'Tool failed' }], isError: true });
      }
    }
    default:
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

export async function handleMCP(body, store) {
  if (Array.isArray(body)) {
    if (body.length === 0) return { status: 400, body: rpcError(null, -32600, 'Empty batch') };
    const replies = (await Promise.all(body.map(x => handleOne(x, store)))).filter(x => x !== null);
    return replies.length ? { status: 200, body: replies } : { status: 202, body: null };
  }
  const reply = await handleOne(body, store);
  return { status: reply === null ? 202 : 200, body: reply };
}

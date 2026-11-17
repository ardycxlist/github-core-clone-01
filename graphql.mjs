// Raven Forge — GraphQL v4 execution (M3 rebuild).
// Dependency-free: a small lexer, parser, validator and executor that read
// only the shared store. The HTTP layer owns auth, status codes and JSON
// parsing; this module turns one parsed body into GraphQL JSON.
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isRecord = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const MISSING = Symbol('missing');

class GraphQLError extends Error {
  constructor(message, loc, path) {
    super(message);
    this.loc = loc;
    this.path = path;
  }
  toJSON() {
    const out = { message: this.message };
    if (this.loc) out.locations = [this.loc];
    if (this.path) out.path = this.path;
    return out;
  }
}
const fail = (message, node) => { throw new GraphQLError(message, node?.loc); };

// ---------------------------------------------------------------- lexer
// Tokens carry source locations. String contents are never read as syntax.
const PUNCT = new Set(['!', '$', '&', '(', ')', ':', '=', '@', '[', ']', '{', '|', '}']);
class Tokenizer {
  constructor(source) {
    this.source = source;
    this.pos = 0;
    this.line = 1;
    this.col = 1;
    this.seen = 0;
  }
  advance() {
    const ch = this.source[this.pos++];
    if (ch === '\r') {
      if (this.source[this.pos] === '\n') this.pos++;
      this.line++;
      this.col = 1;
    } else if (ch === '\n') {
      this.line++;
      this.col = 1;
    } else {
      this.col++;
    }
    return ch;
  }
  next() {
    const s = this.source;
    while (this.pos < s.length) {
      const c = s[this.pos];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c.charCodeAt(0) === 0xfeff) this.advance();
      else if (c === '#') { while (this.pos < s.length && s[this.pos] !== '\n' && s[this.pos] !== '\r') this.advance(); }
      else break;
    }
    const loc = { line: this.line, column: this.col };
    const start = this.pos;
    if (++this.seen > 50000) throw new GraphQLError('Document contains too many tokens.', loc);
    if (start === s.length) return { kind: 'EOF', value: '', loc };
    const c = s[start];
    if (/[A-Za-z_]/.test(c)) {
      this.advance();
      while (this.pos < s.length && /[A-Za-z0-9_]/.test(s[this.pos])) this.advance();
      return { kind: 'NAME', value: s.slice(start, this.pos), loc };
    }
    if (c === '-' || /[0-9]/.test(c)) {
      if (c === '-') this.advance();
      if (!/[0-9]/.test(s[this.pos] ?? '')) throw new GraphQLError('Invalid number.', loc);
      if (s[this.pos] === '0') this.advance();
      else while (/[0-9]/.test(s[this.pos] ?? '')) this.advance();
      let kind = 'INT';
      if (s[this.pos] === '.') {
        kind = 'FLOAT';
        this.advance();
        if (!/[0-9]/.test(s[this.pos] ?? '')) throw new GraphQLError('Invalid float.', loc);
        while (/[0-9]/.test(s[this.pos] ?? '')) this.advance();
      }
      if (s[this.pos] === 'e' || s[this.pos] === 'E') {
        kind = 'FLOAT';
        this.advance();
        if (s[this.pos] === '+' || s[this.pos] === '-') this.advance();
        if (!/[0-9]/.test(s[this.pos] ?? '')) throw new GraphQLError('Invalid exponent.', loc);
        while (/[0-9]/.test(s[this.pos] ?? '')) this.advance();
      }
      if (/[A-Za-z0-9.]/.test(s[this.pos] ?? '')) throw new GraphQLError('Invalid number suffix.', loc);
      return { kind, value: Number(s.slice(start, this.pos)), loc };
    }
    if (c === '"') {
      if (s.startsWith('"""', start)) {
        this.advance(); this.advance(); this.advance();
        let raw = '';
        while (this.pos < s.length && !s.startsWith('"""', this.pos)) {
          if (s.startsWith('\\"""', this.pos)) {
            for (let n = 0; n < 4; n++) this.advance();
            raw += '"""';
          } else {
            const ch = this.advance();
            raw += ch === '\r' ? '\n' : ch;
          }
        }
        if (this.pos === s.length) throw new GraphQLError('Unterminated block string.', loc);
        this.advance(); this.advance(); this.advance();
        const lines = raw.split('\n');
        let indent = Infinity;
        for (const line of lines.slice(1)) {
          if (line.trim()) indent = Math.min(indent, line.match(/^[ \t]*/)[0].length);
        }
        if (Number.isFinite(indent)) for (let n = 1; n < lines.length; n++) lines[n] = lines[n].slice(indent);
        while (lines.length && !lines[0].trim()) lines.shift();
        while (lines.length && !lines.at(-1).trim()) lines.pop();
        return { kind: 'STRING', value: lines.join('\n'), loc };
      }
      this.advance();
      let value = '';
      while (this.pos < s.length && s[this.pos] !== '"') {
        const ch = this.advance();
        if (ch.charCodeAt(0) < 32) throw new GraphQLError('Invalid control character in string.', loc);
        if (ch !== '\\') { value += ch; continue; }
        const esc = this.advance();
        const table = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (hasOwn(table, esc)) value += table[esc];
        else if (esc === 'u') {
          if (s[this.pos] === '{') {
            this.advance();
            const at = this.pos;
            while (/[0-9a-fA-F]/.test(s[this.pos] ?? '')) this.advance();
            const hex = s.slice(at, this.pos);
            if (s[this.pos] !== '}' || !hex || hex.length > 6) throw new GraphQLError('Invalid Unicode escape.', loc);
            this.advance();
            const cp = parseInt(hex, 16);
            if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) throw new GraphQLError('Invalid Unicode code point.', loc);
            value += String.fromCodePoint(cp);
          } else {
            const hex = s.slice(this.pos, this.pos + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new GraphQLError('Invalid Unicode escape.', loc);
            for (let n = 0; n < 4; n++) this.advance();
            value += String.fromCharCode(parseInt(hex, 16));
          }
        } else throw new GraphQLError('Invalid string escape.', loc);
      }
      if (s[this.pos] !== '"') throw new GraphQLError('Unterminated string.', loc);
      this.advance();
      return { kind: 'STRING', value, loc };
    }
    if (s.startsWith('...', start)) {
      this.advance(); this.advance(); this.advance();
      return { kind: '...', value: '...', loc };
    }
    if (PUNCT.has(c)) { this.advance(); return { kind: c, value: c, loc }; }
    throw new GraphQLError(`Unexpected character ${JSON.stringify(c)}.`, loc);
  }
}

// ---------------------------------------------------------------- parser
class Parser {
  constructor(source) {
    this.lex = new Tokenizer(source);
    this.tok = this.lex.next();
    this.depth = 0;
  }
  eat(kind, value) {
    if (this.tok.kind !== kind || (value !== undefined && this.tok.value !== value)) return null;
    const t = this.tok;
    this.tok = this.lex.next();
    return t;
  }
  expect(kind, value) {
    const t = this.eat(kind, value);
    if (!t) fail(`Expected ${value ?? kind}, found ${this.tok.value || this.tok.kind}.`, this.tok);
    return t;
  }
  guard(fn) {
    if (++this.depth > 100) fail('Document nesting exceeds 100 levels.', this.tok);
    try { return fn(); } finally { this.depth--; }
  }
  parseDocument() {
    const operations = [];
    const fragments = new Map();
    while (this.tok.kind !== 'EOF') {
      if (this.tok.kind === '{') {
        operations.push({ kind: 'query', name: null, variables: [], directives: [], loc: this.tok.loc, selection: this.parseSelection() });
      } else if (this.eat('NAME', 'fragment')) {
        const n = this.expect('NAME');
        if (n.value === 'on') fail('Fragment cannot be named "on".', n);
        this.expect('NAME', 'on');
        const type = this.expect('NAME').value;
        const directives = this.parseDirectives();
        const selection = this.parseSelection();
        if (fragments.has(n.value)) fail(`There can be only one fragment named "${n.value}".`, n);
        fragments.set(n.value, { name: n.value, type, directives, selection, loc: n.loc });
      } else {
        const t = this.expect('NAME');
        if (!['query', 'mutation', 'subscription'].includes(t.value)) fail(`Unexpected definition "${t.value}".`, t);
        const name = this.eat('NAME')?.value ?? null;
        const variables = [];
        if (this.eat('(')) {
          do {
            const v = this.expect('$');
            const vname = this.expect('NAME').value;
            this.expect(':');
            const type = this.parseType();
            const defaultValue = this.eat('=') ? this.parseValue(true) : MISSING;
            variables.push({ name: vname, type, defaultValue, directives: this.parseDirectives(), loc: v.loc });
          } while (this.tok.kind !== ')');
          this.expect(')');
        }
        const directives = this.parseDirectives();
        operations.push({ kind: t.value, name, variables, directives, selection: this.parseSelection(), loc: t.loc });
      }
    }
    if (!operations.length) fail('Must provide an operation.', this.tok);
    return { operations, fragments };
  }
  parseType() {
    return this.guard(() => {
      let t;
      if (this.eat('[')) {
        t = { kind: 'LIST', ofType: this.parseType() };
        this.expect(']');
      } else {
        t = { kind: 'NAMED', name: this.expect('NAME').value };
      }
      return this.eat('!') ? { kind: 'NON_NULL', ofType: t } : t;
    });
  }
  parseSelection() {
    return this.guard(() => {
      this.expect('{');
      const out = [];
      do {
        const loc = this.tok.loc;
        if (this.eat('...')) {
          if (this.eat('NAME', 'on')) {
            out.push({ kind: 'inline', type: this.expect('NAME').value, directives: this.parseDirectives(), selection: this.parseSelection(), loc });
          } else if (this.tok.kind === '@' || this.tok.kind === '{') {
            out.push({ kind: 'inline', type: null, directives: this.parseDirectives(), selection: this.parseSelection(), loc });
          } else {
            out.push({ kind: 'spread', name: this.expect('NAME').value, directives: this.parseDirectives(), loc });
          }
        } else {
          const first = this.expect('NAME').value;
          const alias = this.eat(':') ? first : null;
          const name = alias ? this.expect('NAME').value : first;
          const args = this.parseArguments();
          const directives = this.parseDirectives();
          const selection = this.tok.kind === '{' ? this.parseSelection() : null;
          out.push({ kind: 'field', name, alias, args, directives, selection, loc });
        }
      } while (this.tok.kind !== '}');
      this.expect('}');
      return out;
    });
  }
  parseArguments() {
    const args = [];
    if (this.eat('(')) {
      do {
        const t = this.expect('NAME');
        this.expect(':');
        args.push({ name: t.value, value: this.parseValue(false), loc: t.loc });
      } while (this.tok.kind !== ')');
      this.expect(')');
    }
    return args;
  }
  parseDirectives() {
    const out = [];
    while (this.eat('@')) {
      const t = this.expect('NAME');
      out.push({ name: t.value, args: this.parseArguments(), loc: t.loc });
    }
    return out;
  }
  parseValue(constant = false) {
    return this.guard(() => {
      const t = this.tok;
      if (this.eat('$')) {
        if (constant) fail('Variables are not allowed in constant values.', t);
        return { kind: 'variable', name: this.expect('NAME').value, loc: t.loc };
      }
      if (this.eat('[')) {
        const values = [];
        while (!this.eat(']')) values.push(this.parseValue(constant));
        return { kind: 'list', values, loc: t.loc };
      }
      if (this.eat('{')) {
        const fields = [];
        while (!this.eat('}')) {
          const n = this.expect('NAME');
          this.expect(':');
          fields.push({ name: n.value, value: this.parseValue(constant), loc: n.loc });
        }
        return { kind: 'object', fields, loc: t.loc };
      }
      if (['STRING', 'INT', 'FLOAT', 'NAME'].includes(t.kind)) {
        this.expect(t.kind);
        if (t.kind === 'NAME' && t.value === 'null') return { kind: 'null', value: null, loc: t.loc };
        if (t.kind === 'NAME' && (t.value === 'true' || t.value === 'false')) return { kind: 'boolean', value: t.value === 'true', loc: t.loc };
        return { kind: { STRING: 'string', INT: 'int', FLOAT: 'float', NAME: 'enum' }[t.kind], value: t.value, loc: t.loc };
      }
      fail(`Expected a value, found ${t.value || t.kind}.`, t);
    });
  }
}

// ---------------------------------------------------------------- schema
// Type references are written as strings ('String!', '[IssueEdge]') and
// parsed once into {kind, name, ofType} shapes.
const SCHEMA = Object.create(null);
const refCache = new Map();
function typeRef(s) {
  if (typeof s !== 'string') return s;
  if (!refCache.has(s)) {
    refCache.set(s, s.endsWith('!') ? { kind: 'NON_NULL', ofType: typeRef(s.slice(0, -1)) }
      : s.startsWith('[') ? { kind: 'LIST', ofType: typeRef(s.slice(1, -1)) }
      : { kind: 'NAMED', name: s });
  }
  return refCache.get(s);
}
const typeNameOf = t => t.kind === 'NAMED' ? t.name : typeNameOf(t.ofType);
const typeText = t => t.kind === 'NAMED' ? t.name : t.kind === 'LIST' ? `[${typeText(t.ofType)}]` : `${typeText(t.ofType)}!`;
function argDef(spec) {
  return typeof spec === 'string' ? { type: typeRef(spec) } : { ...spec, type: typeRef(spec.type) };
}
function fieldDef(spec) {
  if (typeof spec === 'string') return { type: typeRef(spec), args: {} };
  const [type, args = {}] = spec;
  return { type: typeRef(type), args: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, argDef(v)])) };
}
function fieldMap(spec) {
  return Object.fromEntries(Object.entries(spec).map(([name, v]) => [name, fieldDef(v)]));
}
function objectType(name, spec, interfaces = []) { SCHEMA[name] = { kind: 'OBJECT', name, fields: fieldMap(spec), interfaces }; }
function inputType(name, spec) { SCHEMA[name] = { kind: 'INPUT_OBJECT', name, inputFields: Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, argDef(v)])) }; }
function enumType(name, values) { SCHEMA[name] = { kind: 'ENUM', name, values: values.split(' ') }; }
function interfaceType(name, spec) { SCHEMA[name] = { kind: 'INTERFACE', name, fields: fieldMap(spec), interfaces: [] }; }
function unionType(name, types) { SCHEMA[name] = { kind: 'UNION', name, possibleTypes: types }; }

for (const name of ['String', 'Int', 'Float', 'Boolean', 'ID', 'DateTime', 'URI', 'GitObjectID', 'GitSSHRemote']) {
  SCHEMA[name] = { kind: 'SCALAR', name };
}
for (const [name, values] of Object.entries({
  IssueState: 'OPEN CLOSED', IssueStateReason: 'COMPLETED NOT_PLANNED REOPENED',
  PullRequestState: 'OPEN CLOSED MERGED', MergeableState: 'MERGEABLE CONFLICTING UNKNOWN',
  PullRequestMergeMethod: 'MERGE SQUASH REBASE',
  MergeStateStatus: 'BEHIND BLOCKED CLEAN DIRTY DRAFT HAS_HOOKS UNKNOWN UNSTABLE',
  RepositoryPermission: 'ADMIN MAINTAIN WRITE TRIAGE READ', RepositoryVisibility: 'PUBLIC PRIVATE INTERNAL',
  SearchType: 'ISSUE REPOSITORY USER DISCUSSION', OrderDirection: 'ASC DESC',
  IssueOrderField: 'CREATED_AT UPDATED_AT COMMENTS', PullRequestOrderField: 'CREATED_AT UPDATED_AT',
  RepositoryOrderField: 'CREATED_AT UPDATED_AT PUSHED_AT NAME STARGAZERS',
  LabelOrderField: 'NAME CREATED_AT', RefOrderField: 'ALPHABETICAL TAG_COMMIT_DATE',
  PullRequestReviewDecision: 'APPROVED CHANGES_REQUESTED REVIEW_REQUIRED',
  FileViewedState: 'DISMISSED VIEWED UNVIEWED', PatchStatus: 'ADDED CHANGED COPIED DELETED MODIFIED RENAMED',
  RepositoryAffiliation: 'OWNER COLLABORATOR ORGANIZATION_MEMBER', RepositoryPrivacy: 'PUBLIC PRIVATE',
  LockReason: 'OFF_TOPIC TOO_HEATED RESOLVED SPAM', SubscriptionState: 'IGNORED SUBSCRIBED UNSUBSCRIBED',
  ReactionContent: 'THUMBS_UP THUMBS_DOWN LAUGH HOORAY CONFUSED HEART ROCKET EYES',
})) enumType(name, values);
for (const [name, field] of [['IssueOrder', 'IssueOrderField'], ['PullRequestOrder', 'PullRequestOrderField'],
  ['RepositoryOrder', 'RepositoryOrderField'], ['LabelOrder', 'LabelOrderField'], ['RefOrder', 'RefOrderField']]) {
  inputType(name, { field: `${field}!`, direction: 'OrderDirection!' });
}
inputType('IssueFilters', { assignee: 'String', createdBy: 'String', mentioned: 'String', labels: '[String!]', milestone: 'String', since: 'DateTime', states: '[IssueState!]', viewerSubscribed: 'Boolean' });
const pageArgs = { first: 'Int', after: 'String', last: 'Int', before: 'String' };
const issueArgs = { ...pageArgs, states: '[IssueState!]', labels: '[String!]', orderBy: 'IssueOrder', filterBy: 'IssueFilters' };
const pullArgs = { ...pageArgs, states: '[PullRequestState!]', labels: '[String!]', orderBy: 'IssueOrder', headRefName: 'String', baseRefName: 'String' };
const repoArgs = { ...pageArgs, orderBy: 'RepositoryOrder', ownerAffiliations: '[RepositoryAffiliation]', affiliations: '[RepositoryAffiliation]', privacy: 'RepositoryPrivacy', isFork: 'Boolean', isLocked: 'Boolean' };

objectType('Query', {
  viewer: 'User!', user: ['User', { login: 'String!' }], repositoryOwner: ['RepositoryOwner', { login: 'String!' }],
  repository: ['Repository', { owner: 'String!', name: 'String!', followRenames: 'Boolean' }],
  node: ['Node', { id: 'ID!' }], nodes: ['[Node]!', { ids: '[ID!]!' }],
  search: ['SearchResultItemConnection!', { ...pageArgs, query: 'String!', type: 'SearchType!' }],
  rateLimit: ['RateLimit', { dryRun: 'Boolean' }], __type: ['__Type', { name: 'String!' }], __schema: '__Schema!',
});
objectType('PageInfo', { hasNextPage: 'Boolean!', hasPreviousPage: 'Boolean!', startCursor: 'String', endCursor: 'String' });
function connection(type, name = type) {
  objectType(`${name}Edge`, { cursor: 'String!', node: type });
  objectType(`${name}Connection`, { edges: `[${name}Edge]`, nodes: `[${type}]`, totalCount: 'Int!', pageInfo: 'PageInfo!' });
}
objectType('User', {
  id: 'ID!', databaseId: 'Int', login: 'String!', name: 'String', email: 'String!', url: 'URI!',
  avatarUrl: ['URI!', { size: 'Int' }], bio: 'String', company: 'String', location: 'String', isViewer: 'Boolean!',
  repositories: ['RepositoryConnection!', repoArgs],
  issues: ['IssueConnection!', { ...issueArgs, filterBy: 'IssueFilters' }],
  pullRequests: ['PullRequestConnection!', pullArgs],
}, ['Node', 'Actor', 'RepositoryOwner']);
objectType('Repository', {
  id: 'ID!', databaseId: 'Int', name: 'String!', nameWithOwner: 'String!', description: 'String', descriptionHTML: 'String!',
  owner: 'RepositoryOwner!', defaultBranchRef: 'Ref', viewerPermission: 'RepositoryPermission', hasIssuesEnabled: 'Boolean!',
  hasWikiEnabled: 'Boolean!', hasDiscussionsEnabled: 'Boolean!', isPrivate: 'Boolean!', visibility: 'RepositoryVisibility!',
  isFork: 'Boolean!', isArchived: 'Boolean!', isEmpty: 'Boolean!', isLocked: 'Boolean!', url: 'URI!', sshUrl: 'GitSSHRemote!',
  createdAt: 'DateTime!', updatedAt: 'DateTime!', pushedAt: 'DateTime', homepageUrl: 'URI',
  stargazerCount: 'Int!', forkCount: 'Int!', diskUsage: 'Int', viewerHasStarred: 'Boolean!',
  mergeCommitAllowed: 'Boolean!', squashMergeAllowed: 'Boolean!', rebaseMergeAllowed: 'Boolean!', deleteBranchOnMerge: 'Boolean!',
  issue: ['Issue', { number: 'Int!' }], pullRequest: ['PullRequest', { number: 'Int!' }],
  issueOrPullRequest: ['IssueOrPullRequest', { number: 'Int!' }],
  issues: ['IssueConnection!', issueArgs], pullRequests: ['PullRequestConnection!', pullArgs],
  label: ['Label', { name: 'String!' }], labels: ['LabelConnection', { ...pageArgs, query: 'String', orderBy: 'LabelOrder' }],
  assignableUsers: ['UserConnection!', { ...pageArgs, query: 'String' }], mentionableUsers: ['UserConnection!', pageArgs],
  ref: ['Ref', { qualifiedName: 'String!' }], refs: ['RefConnection', { ...pageArgs, refPrefix: 'String!', query: 'String', orderBy: 'RefOrder' }],
  object: ['GitObject', { expression: 'String', oid: 'GitObjectID' }],
}, ['Node']);
const sharedIssueFields = {
  id: 'ID!', databaseId: 'Int', number: 'Int!', title: 'String!', body: 'String!', bodyText: 'String!', bodyHTML: 'String!',
  url: 'URI!', createdAt: 'DateTime!', updatedAt: 'DateTime!', closedAt: 'DateTime', closed: 'Boolean!',
  author: 'Actor', repository: 'Repository!', editor: 'Actor', lastEditedAt: 'DateTime',
  labels: ['LabelConnection', pageArgs], assignees: ['UserConnection!', pageArgs],
  comments: ['IssueCommentConnection!', pageArgs], locked: 'Boolean!', activeLockReason: 'LockReason',
  viewerCanUpdate: 'Boolean!', viewerCanSubscribe: 'Boolean!', viewerDidAuthor: 'Boolean!',
  viewerSubscription: 'SubscriptionState!', participants: ['UserConnection!', pageArgs],
  reactionGroups: '[ReactionGroup!]', reactions: ['ReactionConnection!', { ...pageArgs, content: 'ReactionContent' }],
};
objectType('Issue', { ...sharedIssueFields, state: 'IssueState!', stateReason: 'IssueStateReason', isPinned: 'Boolean!' }, ['Node', 'Comment']);
objectType('PullRequest', {
  ...sharedIssueFields, state: 'PullRequestState!', merged: 'Boolean!', mergedAt: 'DateTime', mergedBy: 'Actor',
  isDraft: 'Boolean!', headRefName: 'String!', baseRefName: 'String!', headRefOid: 'GitObjectID!', baseRefOid: 'GitObjectID!',
  headRef: 'Ref', baseRef: 'Ref', headRepository: 'Repository', baseRepository: 'Repository', headRepositoryOwner: 'RepositoryOwner',
  mergeable: 'MergeableState!', mergeStateStatus: 'MergeStateStatus!', mergeCommit: 'Commit',
  reviewDecision: 'PullRequestReviewDecision', maintainerCanModify: 'Boolean!', isCrossRepository: 'Boolean!',
  additions: 'Int!', deletions: 'Int!', changedFiles: 'Int!',
  files: ['PullRequestChangedFileConnection', pageArgs], commits: ['PullRequestCommitConnection!', pageArgs],
}, ['Node', 'Comment']);
objectType('IssueComment', {
  id: 'ID!', databaseId: 'Int', body: 'String!', bodyText: 'String!', bodyHTML: 'String!', author: 'Actor',
  createdAt: 'DateTime!', updatedAt: 'DateTime!', url: 'URI!', viewerCanUpdate: 'Boolean!', viewerCanDelete: 'Boolean!',
  viewerDidAuthor: 'Boolean!', issue: 'Issue', pullRequest: 'PullRequest', repository: 'Repository!',
}, ['Node', 'Comment']);
objectType('Label', { id: 'ID!', name: 'String!', color: 'String!', description: 'String', isDefault: 'Boolean!', url: 'URI!' }, ['Node']);
objectType('PullRequestChangedFile', { path: 'String!', additions: 'Int!', deletions: 'Int!', changeType: 'PatchStatus!', viewerViewedState: 'FileViewedState!' });
objectType('PullRequestCommit', { commit: 'Commit!', url: 'URI!' });
objectType('Reaction', { id: 'ID!', content: 'ReactionContent!', user: 'User', createdAt: 'DateTime!' }, ['Node']);
objectType('ReactionGroup', { content: 'ReactionContent!', viewerHasReacted: 'Boolean!', users: ['UserConnection!', pageArgs], reactors: ['UserConnection!', pageArgs] });
objectType('Ref', { id: 'ID!', name: 'String!', prefix: 'String!', target: 'GitObject!', repository: 'Repository!' }, ['Node']);
objectType('GitActor', { name: 'String', email: 'String', date: 'DateTime', user: 'User', avatarUrl: ['URI!', { size: 'Int' }] });
objectType('Commit', {
  id: 'ID!', oid: 'GitObjectID!', abbreviatedOid: 'String!', message: 'String!', messageHeadline: 'String!',
  messageBody: 'String!', committedDate: 'DateTime!', authoredDate: 'DateTime!', author: 'GitActor', committer: 'GitActor',
  url: 'URI!', tree: 'Tree!', parents: ['CommitConnection!', pageArgs], repository: 'Repository!',
  history: ['CommitConnection!', { ...pageArgs, path: 'String', since: 'DateTime', until: 'DateTime' }],
}, ['Node', 'GitObject']);
objectType('Blob', {
  id: 'ID!', oid: 'GitObjectID!', abbreviatedOid: 'String!', byteSize: 'Int!', text: 'String',
  isBinary: 'Boolean!', isTruncated: 'Boolean!', repository: 'Repository!',
}, ['Node', 'GitObject']);
objectType('Tree', { id: 'ID!', oid: 'GitObjectID!', abbreviatedOid: 'String!', entries: '[TreeEntry!]', repository: 'Repository!' }, ['Node', 'GitObject']);
objectType('TreeEntry', { name: 'String!', path: 'String!', type: 'String!', mode: 'Int!', oid: 'GitObjectID!', object: 'GitObject', repository: 'Repository!' });
objectType('RateLimit', { cost: 'Int!', limit: 'Int!', remaining: 'Int!', used: 'Int!', resetAt: 'DateTime!', nodeCount: 'Int!' });
for (const name of ['User', 'Repository', 'Issue', 'PullRequest', 'Label', 'IssueComment', 'PullRequestChangedFile', 'PullRequestCommit', 'Ref', 'Commit', 'Reaction']) connection(name);
connection('SearchResultItem', 'SearchResultItem');
Object.assign(SCHEMA.SearchResultItemConnection.fields, fieldMap({ issueCount: 'Int!', repositoryCount: 'Int!', userCount: 'Int!', discussionCount: 'Int!', wikiCount: 'Int!' }));
for (const [name, spec] of Object.entries({
  Node: { id: 'ID!' },
  Actor: { login: 'String!', url: 'URI!', avatarUrl: ['URI!', { size: 'Int' }] },
  RepositoryOwner: { id: 'ID!', login: 'String!', url: 'URI!', avatarUrl: ['URI!', { size: 'Int' }], repositories: ['RepositoryConnection!', repoArgs] },
  Comment: { body: 'String!', bodyText: 'String!', bodyHTML: 'String!', author: 'Actor', createdAt: 'DateTime!', updatedAt: 'DateTime!' },
  GitObject: { id: 'ID!', oid: 'GitObjectID!', abbreviatedOid: 'String!', repository: 'Repository!' },
})) interfaceType(name, spec);
for (const [name, types] of Object.entries({ IssueOrPullRequest: ['Issue', 'PullRequest'], SearchResultItem: ['Repository', 'Issue', 'PullRequest', 'User'] })) unionType(name, types);

// Mutations: [input type, input fields, payload fields].
const MUTATIONS = {
  createIssue: ['CreateIssueInput', { repositoryId: 'ID!', title: 'String!', body: 'String', assigneeIds: '[ID!]', labelIds: '[ID!]', milestoneId: 'ID' }, { issue: 'Issue', repository: 'Repository' }],
  updateIssue: ['UpdateIssueInput', { id: 'ID!', title: 'String', body: 'String', state: 'IssueState', stateReason: 'IssueStateReason', assigneeIds: '[ID!]', labelIds: '[ID!]', milestoneId: 'ID' }, { issue: 'Issue' }],
  closeIssue: ['CloseIssueInput', { issueId: 'ID!', stateReason: 'IssueStateReason' }, { issue: 'Issue' }],
  reopenIssue: ['ReopenIssueInput', { issueId: 'ID!' }, { issue: 'Issue' }],
  createPullRequest: ['CreatePullRequestInput', { repositoryId: 'ID!', title: 'String!', body: 'String', baseRefName: 'String!', headRefName: 'String!', headRepositoryId: 'ID', draft: 'Boolean', maintainerCanModify: 'Boolean' }, { pullRequest: 'PullRequest' }],
  updatePullRequest: ['UpdatePullRequestInput', { pullRequestId: 'ID!', title: 'String', body: 'String', baseRefName: 'String', state: 'PullRequestState', maintainerCanModify: 'Boolean', assigneeIds: '[ID!]', labelIds: '[ID!]' }, { pullRequest: 'PullRequest' }],
  closePullRequest: ['ClosePullRequestInput', { pullRequestId: 'ID!' }, { pullRequest: 'PullRequest' }],
  reopenPullRequest: ['ReopenPullRequestInput', { pullRequestId: 'ID!' }, { pullRequest: 'PullRequest' }],
  mergePullRequest: ['MergePullRequestInput', { pullRequestId: 'ID!', mergeMethod: 'PullRequestMergeMethod', commitHeadline: 'String', commitBody: 'String', expectedHeadOid: 'GitObjectID', authorEmail: 'String' }, { pullRequest: 'PullRequest', actor: 'Actor' }],
  addComment: ['AddCommentInput', { subjectId: 'ID!', body: 'String!' }, { commentEdge: 'IssueCommentEdge', subject: 'Node' }],
  updateIssueComment: ['UpdateIssueCommentInput', { id: 'ID!', body: 'String!' }, { issueComment: 'IssueComment' }],
  deleteIssueComment: ['DeleteIssueCommentInput', { id: 'ID!' }, { clientMutationId: 'String' }],
  addLabelsToLabelable: ['AddLabelsToLabelableInput', { labelableId: 'ID!', labelIds: '[ID!]!' }, { labelable: 'IssueOrPullRequest' }],
  removeLabelsFromLabelable: ['RemoveLabelsFromLabelableInput', { labelableId: 'ID!', labelIds: '[ID!]!' }, { labelable: 'IssueOrPullRequest' }],
  createRepository: ['CreateRepositoryInput', { name: 'String!', description: 'String', visibility: 'RepositoryVisibility!', hasIssuesEnabled: 'Boolean', hasWikiEnabled: 'Boolean', ownerId: 'ID' }, { repository: 'Repository' }],
  updateRepository: ['UpdateRepositoryInput', { repositoryId: 'ID!', name: 'String', description: 'String', visibility: 'RepositoryVisibility', hasIssuesEnabled: 'Boolean', hasWikiEnabled: 'Boolean', homepageUrl: 'URI' }, { repository: 'Repository' }],
  deleteRepository: ['DeleteRepositoryInput', { repositoryId: 'ID!' }, { clientMutationId: 'String' }],
};
objectType('Mutation', Object.fromEntries(Object.entries(MUTATIONS).map(([name, [inputName, spec, payload]]) => {
  inputType(inputName, { ...spec, clientMutationId: 'String' });
  const payloadName = inputName.replace(/Input$/, 'Payload');
  objectType(payloadName, { ...payload, clientMutationId: 'String' });
  return [name, [payloadName, { input: `${inputName}!` }]];
})));

// Introspection is derived from the executable type graph above.
enumType('__TypeKind', 'SCALAR OBJECT INTERFACE UNION ENUM INPUT_OBJECT LIST NON_NULL');
enumType('__DirectiveLocation', 'QUERY MUTATION SUBSCRIPTION FIELD FRAGMENT_DEFINITION FRAGMENT_SPREAD INLINE_FRAGMENT VARIABLE_DEFINITION SCHEMA SCALAR OBJECT FIELD_DEFINITION ARGUMENT_DEFINITION INTERFACE UNION ENUM ENUM_VALUE INPUT_OBJECT INPUT_FIELD_DEFINITION');
objectType('__Schema', { description: 'String', queryType: '__Type!', mutationType: '__Type', subscriptionType: '__Type', types: '[__Type!]!', directives: '[__Directive!]!' });
objectType('__Type', {
  kind: '__TypeKind!', name: 'String', description: 'String', specifiedByURL: 'String', isOneOf: 'Boolean',
  fields: ['[__Field!]', { includeDeprecated: { type: 'Boolean', defaultValue: false } }],
  interfaces: '[__Type!]', possibleTypes: '[__Type!]',
  enumValues: ['[__EnumValue!]', { includeDeprecated: { type: 'Boolean', defaultValue: false } }],
  inputFields: ['[__InputValue!]', { includeDeprecated: { type: 'Boolean', defaultValue: false } }],
  ofType: '__Type',
});
objectType('__Field', { name: 'String!', description: 'String', args: ['[__InputValue!]!', { includeDeprecated: { type: 'Boolean', defaultValue: false } }], type: '__Type!', isDeprecated: 'Boolean!', deprecationReason: 'String' });
objectType('__InputValue', { name: 'String!', description: 'String', type: '__Type!', defaultValue: 'String', isDeprecated: 'Boolean!', deprecationReason: 'String' });
objectType('__EnumValue', { name: 'String!', description: 'String', isDeprecated: 'Boolean!', deprecationReason: 'String' });
objectType('__Directive', { name: 'String!', description: 'String', isRepeatable: 'Boolean!', locations: '[__DirectiveLocation!]!', args: ['[__InputValue!]!', { includeDeprecated: { type: 'Boolean', defaultValue: false } }] });
const DIRECTIVES = {
  skip: { args: { if: argDef('Boolean!') }, locations: ['FIELD', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'] },
  include: { args: { if: argDef('Boolean!') }, locations: ['FIELD', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'] },
};
const isComposite = name => ['OBJECT', 'INTERFACE', 'UNION'].includes(SCHEMA[name]?.kind);
function possibleTypes(name) {
  const t = SCHEMA[name];
  if (!t) return [];
  if (t.kind === 'OBJECT') return [name];
  if (t.kind === 'UNION') return t.possibleTypes;
  return Object.values(SCHEMA).filter(x => x.interfaces?.includes(name)).map(x => x.name);
}
const typesOverlap = (a, b) => possibleTypes(a).some(x => possibleTypes(b).includes(x));
function fieldDefOf(type, name) {
  if (name === '__typename' && isComposite(type)) return { type: typeRef('String!'), args: {} };
  return SCHEMA[type]?.fields?.[name];
}

// ------------------------------------------------------- coercion/values
function coerceValue(value, t, label, node) {
  if (t.kind === 'NON_NULL') {
    if (value === null || value === MISSING) fail(`${label} of required type "${typeText(t)}" was ${value === null ? 'null' : 'not provided'}.`, node);
    return coerceValue(value, t.ofType, label, node);
  }
  if (value === MISSING || value === null) return value;
  if (t.kind === 'LIST') {
    return (Array.isArray(value) ? value : [value]).map((x, i) => coerceValue(x, t.ofType, `${label}[${i}]`, node));
  }
  const d = SCHEMA[t.name];
  if (!d) fail(`Unknown type "${t.name}".`, node);
  if (d.kind === 'INPUT_OBJECT') {
    if (!isRecord(value)) fail(`${label} must be an input object of type "${t.name}".`, node);
    const out = Object.create(null);
    for (const k of Object.keys(value)) {
      if (!hasOwn(d.inputFields, k)) fail(`Field "${k}" is not defined by type "${t.name}".`, node);
    }
    for (const [k, f] of Object.entries(d.inputFields)) {
      const v = coerceValue(hasOwn(value, k) ? value[k] : hasOwn(f, 'defaultValue') ? f.defaultValue : MISSING, f.type, `${label}.${k}`, node);
      if (v !== MISSING) out[k] = v;
    }
    return out;
  }
  if (d.kind === 'ENUM') {
    if (typeof value !== 'string' || !d.values.includes(value)) fail(`${label} has invalid value ${JSON.stringify(value)} for enum "${t.name}".`, node);
    return value;
  }
  if (t.name === 'Int') {
    if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) fail(`${label}: Int cannot represent ${JSON.stringify(value)}.`, node);
  } else if (t.name === 'Float') {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label}: Float cannot represent ${JSON.stringify(value)}.`, node);
  } else if (t.name === 'Boolean') {
    if (typeof value !== 'boolean') fail(`${label}: Boolean cannot represent ${JSON.stringify(value)}.`, node);
  } else if (t.name === 'ID') {
    if (typeof value !== 'string' && !Number.isInteger(value)) fail(`${label}: ID cannot represent ${JSON.stringify(value)}.`, node);
    return String(value);
  } else if (typeof value !== 'string') {
    fail(`${label}: ${t.name} cannot represent a non-string value.`, node);
  }
  return value;
}
function literalValue(v, vars) {
  if (v.kind === 'variable') return hasOwn(vars, v.name) ? vars[v.name] : MISSING;
  if (v.kind === 'list') return v.values.map(x => { const r = literalValue(x, vars); return r === MISSING ? null : r; });
  if (v.kind === 'object') {
    const out = Object.create(null);
    for (const f of v.fields) {
      const r = literalValue(f.value, vars);
      if (r !== MISSING) out[f.name] = r;
    }
    return out;
  }
  return v.value;
}
function typesCompatible(variableType, locationType) {
  if (locationType.kind === 'NON_NULL') return variableType.kind === 'NON_NULL' && typesCompatible(variableType.ofType, locationType.ofType);
  if (variableType.kind === 'NON_NULL') return typesCompatible(variableType.ofType, locationType);
  if (locationType.kind === 'LIST') return variableType.kind === 'LIST' && typesCompatible(variableType.ofType, locationType.ofType);
  return variableType.kind === 'NAMED' && locationType.name === variableType.name;
}
function validateLiteral(v, t, vars, used, locationDefault = false) {
  if (v.kind === 'variable') {
    const def = vars.get(v.name);
    if (!def) fail(`Variable "$${v.name}" is not defined by this operation.`, v);
    used.add(v.name);
    const hasNonNullDefault = def.defaultValue !== MISSING && def.defaultValue.kind !== 'null';
    const target = t.kind === 'NON_NULL' && def.type.kind !== 'NON_NULL' && (hasNonNullDefault || locationDefault) ? t.ofType : t;
    if (!typesCompatible(def.type, target)) fail(`Variable "$${v.name}" of type "${typeText(def.type)}" used in position expecting "${typeText(t)}".`, v);
    return;
  }
  if (t.kind === 'NON_NULL') {
    if (v.kind === 'null') fail(`Expected value of type "${typeText(t)}", found null.`, v);
    return validateLiteral(v, t.ofType, vars, used);
  }
  if (v.kind === 'null') return;
  if (t.kind === 'LIST') {
    for (const x of v.kind === 'list' ? v.values : [v]) validateLiteral(x, t.ofType, vars, used);
    return;
  }
  const d = SCHEMA[t.name];
  if (d.kind === 'INPUT_OBJECT') {
    if (v.kind !== 'object') fail(`Expected input object "${t.name}".`, v);
    const seen = new Set();
    for (const f of v.fields) {
      if (seen.has(f.name)) fail(`There can be only one input field named "${f.name}".`, f);
      seen.add(f.name);
      const field = d.inputFields[f.name];
      if (!field) fail(`Field "${f.name}" is not defined by type "${t.name}".`, f);
      validateLiteral(f.value, field.type, vars, used, hasOwn(field, 'defaultValue'));
    }
    for (const [key, field] of Object.entries(d.inputFields)) {
      if (field.type.kind === 'NON_NULL' && !seen.has(key) && !hasOwn(field, 'defaultValue')) {
        fail(`Field "${t.name}.${key}" of required type "${typeText(field.type)}" was not provided.`, v);
      }
    }
    return;
  }
  if (d.kind === 'ENUM') {
    if (v.kind !== 'enum' || !d.values.includes(v.value)) fail(`Enum "${t.name}" cannot represent ${JSON.stringify(v.value)}.`, v);
    return;
  }
  const allowed = t.name === 'ID' ? ['string', 'int'] : t.name === 'Int' ? ['int'] : t.name === 'Float' ? ['int', 'float'] : t.name === 'Boolean' ? ['boolean'] : ['string'];
  if (!allowed.includes(v.kind)) fail(`Expected value of type "${t.name}", found ${JSON.stringify(v.value)}.`, v);
  coerceValue(v.value, t, t.name, v);
}
function validateArgs(args, defs, vars, used, node, label) {
  const seen = new Set();
  for (const a of args) {
    if (seen.has(a.name)) fail(`There can be only one argument named "${a.name}".`, a);
    seen.add(a.name);
    const def = defs[a.name];
    if (!def) fail(`Unknown argument "${a.name}" on ${label}.`, a);
    validateLiteral(a.value, def.type, vars, used, hasOwn(def, 'defaultValue'));
  }
  for (const [name, def] of Object.entries(defs)) {
    if (def.type.kind === 'NON_NULL' && !seen.has(name) && !hasOwn(def, 'defaultValue')) {
      fail(`Argument "${name}" of required type "${typeText(def.type)}" on ${label} was not provided.`, node);
    }
  }
}
function validateDirectives(list, where, vars, used) {
  const seen = new Set();
  for (const d of list) {
    const def = DIRECTIVES[d.name];
    if (!def) fail(`Unknown directive "@${d.name}".`, d);
    if (seen.has(d.name)) fail(`Directive "@${d.name}" may not be used twice at this location.`, d);
    seen.add(d.name);
    if (!def.locations.includes(where)) fail(`Directive "@${d.name}" may not be used on ${where}.`, d);
    validateArgs(d.args, def.args, vars, used, d, `directive "@${d.name}"`);
  }
}
function argsKey(args) {
  const clean = v => v.kind === 'object'
    ? ['object', [...v.fields].sort((a, b) => a.name.localeCompare(b.name)).map(f => [f.name, clean(f.value)])]
    : v.kind === 'list' ? ['list', v.values.map(clean)] : [v.kind, v.kind === 'variable' ? v.name : v.value];
  return JSON.stringify([...args].sort((a, b) => a.name.localeCompare(b.name)).map(a => [a.name, clean(a.value)]));
}
function validateDocument(doc) {
  const operationNames = new Set();
  const usedFragments = new Set();
  if (doc.operations.length > 1 && doc.operations.some(o => !o.name)) {
    fail('An anonymous operation must be the only operation in a document.', doc.operations.find(o => !o.name));
  }
  const checkedFragments = new Set();
  function visitFragment(name, stack = []) {
    const f = doc.fragments.get(name);
    if (!f) fail(`Unknown fragment "${name}".`);
    if (stack.includes(name)) fail(`Cannot spread fragment "${name}" within itself.`, f);
    if (checkedFragments.has(name)) return;
    if (!isComposite(f.type)) fail(`Fragment "${name}" cannot condition on non-composite type "${f.type}".`, f);
    const walk = sel => {
      for (const s of sel) {
        if (s.kind === 'spread') visitFragment(s.name, [...stack, name]);
        else if (s.selection) walk(s.selection);
      }
    };
    walk(f.selection);
    checkedFragments.add(name);
  }
  for (const name of doc.fragments.keys()) visitFragment(name);
  for (const op of doc.operations) {
    if (op.name && operationNames.has(op.name)) fail(`There can be only one operation named "${op.name}".`, op);
    operationNames.add(op.name);
    if (op.kind === 'subscription') fail('Schema does not support subscription operations.', op);
    const vars = new Map();
    const used = new Set();
    for (const v of op.variables) {
      if (vars.has(v.name)) fail(`There can be only one variable named "$${v.name}".`, v);
      vars.set(v.name, v);
      const t = SCHEMA[typeNameOf(v.type)];
      if (!t) fail(`Unknown type "${typeNameOf(v.type)}".`, v);
      if (!['SCALAR', 'ENUM', 'INPUT_OBJECT'].includes(t.kind)) fail(`Variable "$${v.name}" cannot be of non-input type "${typeText(v.type)}".`, v);
      if (v.defaultValue !== MISSING) validateLiteral(v.defaultValue, v.type, new Map(), new Set());
      validateDirectives(v.directives, 'VARIABLE_DEFINITION', vars, used);
    }
    validateDirectives(op.directives, op.kind.toUpperCase(), vars, used);
    let work = 0;
    function checkSelections(sel, type, depth = 0) {
      if (depth > 100) fail('Expanded selection nesting exceeds 100 levels.', op);
      const flat = [];
      const flatten = (nodes, parent, types) => {
        for (const s of nodes) {
          if (++work > 100000) fail('Expanded document is too complex.', s);
          validateDirectives(s.directives, s.kind === 'field' ? 'FIELD' : s.kind === 'spread' ? 'FRAGMENT_SPREAD' : 'INLINE_FRAGMENT', vars, used);
          if (s.kind === 'field') {
            const def = fieldDefOf(parent, s.name);
            if (!def) fail(`Cannot query field "${s.name}" on type "${parent}".`, s);
            validateArgs(s.args, def.args, vars, used, s, `field "${parent}.${s.name}"`);
            if (isComposite(typeNameOf(def.type)) && !s.selection) fail(`Field "${s.name}" of type "${typeText(def.type)}" must have a selection of subfields.`, s);
            if (!isComposite(typeNameOf(def.type)) && s.selection) fail(`Field "${s.name}" must not have a selection since type "${typeText(def.type)}" has no subfields.`, s);
            flat.push({ s, def, types });
          } else {
            const f = s.kind === 'spread' ? doc.fragments.get(s.name) : s;
            if (!f) fail(`Unknown fragment "${s.name}".`, s);
            if (s.kind === 'spread') {
              usedFragments.add(s.name);
              validateDirectives(f.directives, 'FRAGMENT_DEFINITION', vars, used);
            }
            const next = f.type ?? parent;
            if (!isComposite(next)) fail(`Unknown or non-composite type "${next}".`, f);
            if (!typesOverlap(parent, next)) fail(`Fragment on "${next}" cannot be spread within type "${parent}".`, s);
            flatten(f.selection, next, types.filter(t => possibleTypes(next).includes(t)));
          }
        }
      };
      flatten(sel, type, possibleTypes(type));
      const groups = new Map();
      for (const x of flat) {
        const key = x.s.alias ?? x.s.name;
        const group = groups.get(key) ?? [];
        for (const y of group) {
          if (x.types.some(t => y.types.includes(t))) {
            if (x.s.name !== y.s.name || argsKey(x.s.args) !== argsKey(y.s.args)) {
              fail(`Fields "${key}" conflict because they have different fields or arguments. Use different aliases.`, x.s);
            }
          }
        }
        group.push(x);
        groups.set(key, group);
      }
      for (const group of groups.values()) {
        for (const x of group) if (x.s.selection) checkSelections(x.s.selection, typeNameOf(x.def.type), depth + 1);
        if (group.length > 1 && group.every(x => x.s.selection && typeNameOf(x.def.type) === typeNameOf(group[0].def.type))
          && group.some((x, i) => group.slice(i + 1).some(y => x.types.some(t => y.types.includes(t))))) {
          checkSelections(group.flatMap(x => x.s.selection), typeNameOf(group[0].def.type), depth + 1);
        }
      }
    }
    checkSelections(op.selection, op.kind === 'mutation' ? 'Mutation' : 'Query');
    for (const v of op.variables) {
      if (!used.has(v.name)) fail(`Variable "$${v.name}" is never used in operation "${op.name ?? ''}".`, v);
    }
  }
  for (const [name, f] of doc.fragments) {
    if (!usedFragments.has(name)) fail(`Fragment "${name}" is never used.`, f);
  }
}
function resolveArgs(args, defs, vars) {
  const given = new Map(args.map(x => [x.name, x]));
  const out = Object.create(null);
  for (const [name, def] of Object.entries(defs)) {
    const a = given.get(name);
    let value = a ? literalValue(a.value, vars) : MISSING;
    if (value === MISSING && hasOwn(def, 'defaultValue')) value = def.defaultValue;
    value = coerceValue(value, def.type, `Argument "${name}"`, a);
    if (value !== MISSING) out[name] = value;
  }
  return out;
}
function directivesEnabled(list, vars) {
  return list.every(d => {
    const args = resolveArgs(d.args, DIRECTIVES[d.name].args, vars);
    return d.name === 'skip' ? !args.if : d.name === 'include' ? args.if : true;
  });
}

// ------------------------------------------------------- shared resolvers
const wrap = (type, value, repo = null) => value == null ? null : { __kind: type, value, repo };
const FIXED_DATE = '2024-01-01T00:00:00.000Z';
const mapValues = x => x instanceof Map ? [...x.values()] : Array.isArray(x) ? x : [];
const stableNodeId = (type, key) => Buffer.from(`${type}:${key}`).toString('base64');
const enc = encodeURIComponent;
const repoPathOf = repo => `/repos/${enc(repo.owner.login)}/${enc(repo.name)}`;
const webOf = (store, repo) => `${store.baseUrl ?? ''}/${enc(repo.owner.login)}/${enc(repo.name)}`;
const stateOf = (v, type) => type === 'PullRequest' && v.merged ? 'MERGED' : String(v.state ?? 'open').toUpperCase();
const numberOf = x => x.number ?? x.id ?? 0;
const escapeHTML = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function orderItems(items, order, defaultField = 'CREATED_AT', defaultDirection = 'ASC') {
  const field = order?.field ?? defaultField;
  const sign = (order?.direction ?? defaultDirection) === 'DESC' ? -1 : 1;
  const key = x => field === 'NAME' || field === 'ALPHABETICAL' ? x.name ?? ''
    : field === 'COMMENTS' ? (Array.isArray(x.comments) ? x.comments.length : x.comments ?? 0)
    : field === 'STARGAZERS' ? x.stargazers_count ?? 0
    : field === 'UPDATED_AT' ? x.updated_at ?? ''
    : field === 'PUSHED_AT' ? x.pushed_at ?? x.updated_at ?? ''
    : x.created_at ?? '';
  return [...items].sort((a, b) => {
    const x = key(a), y = key(b);
    return sign * (x < y ? -1 : x > y ? 1 : numberOf(a) - numberOf(b));
  });
}
function paginate(items, args, extra = {}) {
  for (const name of ['first', 'last']) {
    if (args[name] != null && (args[name] < 0 || args[name] > 100)) throw new Error(`Argument "${name}" must be between 0 and 100.`);
  }
  const cursor = i => Buffer.from(`cursor:${i}`).toString('base64');
  const position = c => {
    const decoded = Buffer.from(c, 'base64').toString();
    if (!/^cursor:\d+$/.test(decoded)) throw new Error('Invalid pagination cursor.');
    return Number(decoded.slice(7));
  };
  let start = args.after != null ? position(args.after) + 1 : 0;
  let end = args.before != null ? position(args.before) : items.length;
  start = Math.max(0, Math.min(items.length, start));
  end = Math.max(start, Math.min(items.length, end));
  if (args.first != null) end = Math.min(end, start + args.first);
  else if (args.last == null) end = Math.min(end, start + 100);
  if (args.last != null) start = Math.max(start, end - args.last);
  const nodes = items.slice(start, end);
  const edges = nodes.map((node, i) => ({ cursor: cursor(start + i), node }));
  return {
    nodes, edges, totalCount: items.length, ...extra,
    pageInfo: { hasNextPage: end < items.length, hasPreviousPage: start > 0, startCursor: edges[0]?.cursor ?? null, endCursor: edges.at(-1)?.cursor ?? null },
  };
}
function labelNamesOf(v) { return (v.labels ?? []).map(x => typeof x === 'string' ? x : x.name); }
function filterItems(items, type, args, store) {
  const f = args.filterBy ?? {};
  const states = args.states ?? f.states;
  const labels = args.labels ?? f.labels;
  return items.filter(v => (!states || states.includes(stateOf(v, type)))
    && (!labels?.length || labels.every(l => labelNamesOf(v).includes(l)))
    && (!args.headRefName || (v.head?.ref ?? v.head) === args.headRefName)
    && (!args.baseRefName || (v.base?.ref ?? v.base) === args.baseRefName)
    && (!f.createdBy || (v.user?.login ?? store.login) === f.createdBy)
    && (!f.assignee || (v.assignees ?? []).some(a => (a.login ?? a) === f.assignee))
    && (!f.since || String(v.updated_at) >= f.since));
}
function getNode(store, id) {
  const n = store.node(id);
  if (n) return wrap(n.type, n.value, n.repo);
  const user = store.userJSON?.();
  return user?.node_id === id ? wrap('User', user) : null;
}
function requireNode(store, id, types) {
  const n = getNode(store, id);
  if (!n || !types.includes(n.__kind)) throw new Error(`Could not resolve to ${types.join(' or ')} with global id "${id}".`);
  return n;
}
function restCall(store, method, path, body = {}) {
  const r = store.rest(method, path, body);
  if (!r || r.status >= 400) throw new Error(r?.body?.message ?? `Request failed (${r?.status ?? 500}).`);
  return r.body;
}
const currentUser = store => wrap('User', store.userJSON?.() ?? { login: store.login, id: 1, node_id: stableNodeId('User', 1) });
function parseCommit(data) {
  const text = data.toString();
  const split = text.indexOf('\n\n');
  const headers = text.slice(0, split).split('\n');
  const message = text.slice(split + 2).replace(/\n$/, '');
  const header = name => headers.find(x => x.startsWith(`${name} `))?.slice(name.length + 1);
  const actor = value => {
    const m = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(value ?? '');
    return { name: m?.[1] ?? '', email: m?.[2] ?? '', date: m ? new Date(Number(m[3]) * 1000).toISOString() : FIXED_DATE, avatarUrl: '' };
  };
  return {
    tree: header('tree'),
    parents: headers.filter(x => x.startsWith('parent ')).map(x => x.slice(7)),
    message, author: actor(header('author')), committer: actor(header('committer')),
  };
}
function gitObjectOf(repo, oid) {
  const obj = oid && repo.git.get(oid);
  if (!obj) return null;
  const type = { commit: 'Commit', blob: 'Blob', tree: 'Tree' }[obj.type];
  return type ? wrap(type, { oid, ...obj }, repo) : null;
}
function gitRefOf(repo, name) {
  const oid = repo.git.resolve(name);
  if (!oid) return null;
  const full = name.startsWith('refs/') ? name : `refs/heads/${name}`;
  return wrap('Ref', {
    name: full.replace(/^refs\/(heads|tags)\//, ''),
    prefix: full.startsWith('refs/tags/') ? 'refs/tags/' : 'refs/heads/',
    oid,
  }, repo);
}
function searchStore(store, args) {
  const parts = args.query.match(/(?:[^\s"]+|"(?:\\.|[^"])*")+/g) ?? [];
  const qualifiers = new Map();
  const words = [];
  for (const part of parts) {
    const colon = part.indexOf(':');
    if (colon > 0) {
      const key = part.slice(0, colon).toLowerCase();
      const value = part.slice(colon + 1).replace(/^"|"$/g, '');
      qualifiers.set(key, [...(qualifiers.get(key) ?? []), value]);
    } else words.push(part.replace(/^"|"$/g, '').toLowerCase());
  }
  const q = name => qualifiers.get(name) ?? [];
  const all = [];
  for (const repo of mapValues(store.repos)) {
    if (q('repo').length && !q('repo').some(v => v.toLowerCase() === repo.full_name.toLowerCase())) continue;
    if (q('user').length && !q('user').includes(repo.owner.login)) continue;
    if (args.type === 'REPOSITORY') all.push(wrap('Repository', repo));
    else if (args.type === 'ISSUE') {
      for (const i of mapValues(repo.issues)) all.push(wrap('Issue', i, repo));
      for (const p of mapValues(repo.pulls)) all.push(wrap('PullRequest', p, repo));
    }
  }
  if (args.type === 'USER') all.push(currentUser(store));
  const nodes = all.filter(n => {
    const v = n.value;
    const is = [...q('is'), ...q('type')];
    const st = stateOf(v, n.__kind).toLowerCase();
    if (is.includes('issue') && n.__kind !== 'Issue') return false;
    if ((is.includes('pr') || is.includes('pull-request')) && n.__kind !== 'PullRequest') return false;
    if (is.includes('open') && st !== 'open') return false;
    if (is.includes('closed') && st === 'open') return false;
    if (is.includes('merged') && !v.merged) return false;
    if (is.includes('unmerged') && v.merged) return false;
    if (q('state').length && !q('state').includes(st)) return false;
    if (q('label').some(l => !labelNamesOf(v).includes(l))) return false;
    if (q('author').length && !q('author').includes(v.user?.login ?? store.login) && !q('author').includes('@me')) return false;
    if (q('assignee').length && !q('assignee').some(l => (v.assignees ?? []).some(a => (a.login ?? a) === (l === '@me' ? store.login : l)))) return false;
    if (q('draft').length && q('draft')[0] !== String(!!v.draft)) return false;
    const haystack = `${v.title ?? v.name ?? v.login ?? ''} ${v.body ?? v.description ?? ''}`.toLowerCase();
    return words.every(w => haystack.includes(w));
  });
  const sort = q('sort')[0];
  if (sort) {
    const direction = sort.endsWith('-asc') ? 'ASC' : 'DESC';
    const field = sort.startsWith('updated') ? 'UPDATED_AT' : sort.startsWith('comments') ? 'COMMENTS' : 'CREATED_AT';
    const sorted = orderItems(nodes.map(n => n.value), { field, direction });
    const rank = new Map(sorted.map((v, i) => [v, i]));
    nodes.sort((a, b) => rank.get(a.value) - rank.get(b.value));
  }
  return paginate(nodes, args, {
    issueCount: args.type === 'ISSUE' ? nodes.length : 0,
    repositoryCount: args.type === 'REPOSITORY' ? nodes.length : 0,
    userCount: args.type === 'USER' ? nodes.length : 0,
    discussionCount: 0, wikiCount: 0,
  });
}

// ---------------------------------------------------------------- executor
const NULL_BUBBLE = Symbol('non-null propagation');
async function executeOperation(doc, op, vars, store) {
  const ctx = { store, errors: [], work: 0 };
  function report(error, loc, path) {
    ctx.errors.push({ message: error.message ?? String(error), locations: [error.loc ?? loc], path: error.path ?? path });
  }
  async function complete(t, value, selection, path, loc) {
    async function finish(inner) {
      if (value === null || value === undefined) return null;
      if (inner.kind === 'LIST') {
        if (!Array.isArray(value)) throw new Error(`Expected a list for field "${path.join('.')}".`);
        const out = [];
        for (let i = 0; i < value.length; i++) out.push(await complete(inner.ofType, value[i], selection, [...path, i], loc));
        return out;
      }
      const d = SCHEMA[inner.name];
      if (isComposite(inner.name)) {
        const actual = value.__kind ?? inner.name;
        if (!SCHEMA[actual] || SCHEMA[actual].kind !== 'OBJECT' || !possibleTypes(inner.name).includes(actual)) {
          throw new Error(`Abstract type "${inner.name}" could not resolve runtime type "${actual}".`);
        }
        return select(selection, actual, value, path);
      }
      if (d.kind === 'ENUM') {
        if (!d.values.includes(value)) throw new Error(`Enum "${d.name}" cannot represent value ${JSON.stringify(value)}.`);
        return value;
      }
      if (inner.name === 'ID') return String(value);
      if (inner.name === 'String' || !['Int', 'Float', 'Boolean'].includes(inner.name)) {
        if (!['string', 'number', 'boolean'].includes(typeof value)) throw new Error(`String cannot represent value for "${path.join('.')}".`);
        return String(value);
      }
      if (inner.name === 'Boolean') {
        if (typeof value !== 'boolean') throw new Error('Boolean cannot represent a non-boolean value.');
        return value;
      }
      if (!Number.isFinite(value) || (inner.name === 'Int' && (!Number.isInteger(value) || value < -2147483648 || value > 2147483647))) {
        throw new Error(`${inner.name} cannot represent value ${value}.`);
      }
      return value;
    }
    try {
      const result = await finish(t.kind === 'NON_NULL' ? t.ofType : t);
      if (result === null && t.kind === 'NON_NULL') throw new Error(`Cannot return null for non-nullable field "${path.join('.')}".`);
      return result;
    } catch (e) {
      if (e !== NULL_BUBBLE) report(e, loc, path);
      if (t.kind === 'NON_NULL') throw NULL_BUBBLE;
      return null;
    }
  }
  async function select(selection, type, source, path) {
    const groups = new Map();
    const visited = new Set();
    function collect(nodes) {
      for (const s of nodes) {
        if (++ctx.work > 100000) throw new Error('Query execution exceeds the field budget.');
        if (!directivesEnabled(s.directives, vars)) continue;
        if (s.kind === 'field') {
          const key = s.alias ?? s.name;
          const group = groups.get(key) ?? [];
          group.push(s);
          groups.set(key, group);
        } else {
          if (s.kind === 'spread' && visited.has(s.name)) continue;
          const f = s.kind === 'spread' ? doc.fragments.get(s.name) : s;
          if (s.kind === 'spread') visited.add(s.name);
          if ((!f.type || possibleTypes(f.type).includes(type)) && directivesEnabled(f.directives, vars)) collect(f.selection);
        }
      }
    }
    collect(selection);
    const out = Object.create(null);
    for (const [key, group] of groups) {
      const field = group[0];
      const def = fieldDefOf(type, field.name);
      const fieldPath = [...path, key];
      let value;
      try {
        const args = resolveArgs(field.args, def.args, vars);
        value = await resolveField(type, source, field.name, args, ctx);
      } catch (e) {
        report(e, field.loc, fieldPath);
        if (def.type.kind === 'NON_NULL') throw NULL_BUBBLE;
        out[key] = null;
        continue;
      }
      out[key] = await complete(def.type, value, group.flatMap(x => x.selection ?? []), fieldPath, field.loc);
    }
    return out;
  }
  let data;
  try {
    data = await select(op.selection, op.kind === 'mutation' ? 'Mutation' : 'Query', {}, []);
  } catch (e) {
    if (e !== NULL_BUBBLE) report(e, op.loc, []);
    data = null;
  }
  return ctx.errors.length ? { data, errors: ctx.errors } : { data };
}

// ---------------------------------------------------------------- resolvers
function introspect(type, source, field) {
  const asType = r => r == null ? null : { __kind: '__Type', ...r };
  const asField = ([name, x]) => ({ __kind: '__Field', name, type: x.type, args: x.args, description: null, isDeprecated: false, deprecationReason: null });
  const asInput = ([name, x]) => ({ __kind: '__InputValue', name, type: x.type, ...(hasOwn(x, 'defaultValue') ? { defaultValue: x.defaultValue } : {}), description: null, isDeprecated: false, deprecationReason: null });
  if (type === '__Schema') {
    if (field === 'queryType') return asType(typeRef('Query'));
    if (field === 'mutationType') return asType(typeRef('Mutation'));
    if (field === 'subscriptionType' || field === 'description') return null;
    if (field === 'types') return Object.keys(SCHEMA).map(name => asType(typeRef(name)));
    if (field === 'directives') {
      return Object.entries(DIRECTIVES).map(([name, x]) => ({ __kind: '__Directive', name, ...x, isRepeatable: false, description: null }));
    }
  }
  if (type === '__Type') {
    const d = source.kind === 'NAMED' ? SCHEMA[source.name] : null;
    if (field === 'kind') return d?.kind ?? source.kind;
    if (field === 'name') return d?.name ?? null;
    if (field === 'ofType') return asType(source.ofType);
    if (field === 'fields') return d?.fields ? Object.entries(d.fields).filter(([n]) => !n.startsWith('__')).map(asField) : null;
    if (field === 'inputFields') return d?.inputFields ? Object.entries(d.inputFields).map(asInput) : null;
    if (field === 'enumValues') return d?.values ? d.values.map(name => ({ __kind: '__EnumValue', name, description: null, isDeprecated: false, deprecationReason: null })) : null;
    if (field === 'interfaces') return d && ['OBJECT', 'INTERFACE'].includes(d.kind) ? (d.interfaces ?? []).map(r => asType(typeRef(r))) : null;
    if (field === 'possibleTypes') return d && ['INTERFACE', 'UNION'].includes(d.kind) ? possibleTypes(d.name).map(r => asType(typeRef(r))) : null;
    if (field === 'isOneOf') return d?.kind === 'INPUT_OBJECT' ? false : null;
    return null;
  }
  if (field === 'args') return Object.entries(source.args ?? {}).map(asInput);
  if (field === 'type') return asType(source.type);
  if (field === 'isDeprecated') return false;
  if (field === 'description' || field === 'deprecationReason') return null;
  if (field === 'defaultValue') return hasOwn(source, 'defaultValue') ? JSON.stringify(source.defaultValue) : null;
  if (field === 'locations') return source.locations ?? null;
  if (field === 'isRepeatable') return source.isRepeatable ?? false;
  return source[field] ?? null;
}

async function resolveField(type, source, field, args, ctx) {
  const { store } = ctx;
  const v = source?.value ?? source;
  const repo = source?.repo;
  if (field === '__typename') return source?.__kind ?? type;
  if (type.startsWith('__')) return introspect(type, source, field);
  if (type === 'Mutation') return runMutation(field, args.input, store);
  if (type === 'Query') {
    if (field === 'viewer') return currentUser(store);
    if (field === 'user' || field === 'repositoryOwner') return args.login.toLowerCase() === store.login.toLowerCase() ? currentUser(store) : null;
    if (field === 'repository') return wrap('Repository', store.getRepo(args.owner, args.name));
    if (field === 'node') return getNode(store, args.id);
    if (field === 'nodes') return args.ids.map(id => getNode(store, id));
    if (field === 'search') return searchStore(store, args);
    if (field === '__type') return hasOwn(SCHEMA, args.name) ? { __kind: '__Type', ...typeRef(args.name) } : null;
    if (field === '__schema') return { __kind: '__Schema' };
    if (field === 'rateLimit') return { cost: 1, limit: 5000, remaining: 4999, used: 1, resetAt: FIXED_DATE, nodeCount: 0 };
  }
  if (type === 'User') {
    if (field === 'repositories') {
      let list = mapValues(store.repos).filter(r => r.owner.login.toLowerCase() === v.login.toLowerCase());
      if (args.privacy) list = list.filter(r => r.private === (args.privacy === 'PRIVATE'));
      if (args.isFork === true || args.isLocked === true) list = [];
      return paginate(orderItems(list, args.orderBy).map(r => wrap('Repository', r)), args);
    }
    if (field === 'issues' || field === 'pullRequests') {
      const t = field === 'issues' ? 'Issue' : 'PullRequest';
      const list = mapValues(store.repos).flatMap(r => filterItems(mapValues(field === 'issues' ? r.issues : r.pulls), t, args, store).map(x => wrap(t, x, r)));
      return paginate(list, args);
    }
    if (field === 'id') return v.node_id ?? stableNodeId('User', v.id ?? v.login);
    if (field === 'databaseId') return v.id ?? 1;
    if (field === 'isViewer') return v.login === store.login;
    if (field === 'url') return v.html_url ?? `${store.baseUrl ?? ''}/${enc(v.login)}`;
    if (field === 'avatarUrl') return v.avatar_url ?? '';
    if (field === 'email') return v.email ?? '';
    return v[field] ?? null;
  }
  if (type === 'Repository') {
    const r = v;
    if (field === 'id') return r.node_id;
    if (field === 'databaseId') return r.id;
    if (field === 'nameWithOwner') return r.full_name ?? `${r.owner.login}/${r.name}`;
    if (field === 'owner') return wrap('User', r.owner);
    if (field === 'defaultBranchRef') return gitRefOf(r, r.default_branch);
    if (field === 'viewerPermission') return 'ADMIN';
    if (field === 'issue' || field === 'pullRequest' || field === 'issueOrPullRequest') {
      const pull = r.pulls.get(args.number);
      const issue = r.issues.get(args.number);
      return field === 'issue' ? wrap('Issue', issue, r)
        : field === 'pullRequest' ? wrap('PullRequest', pull, r)
        : pull ? wrap('PullRequest', pull, r) : wrap('Issue', issue, r);
    }
    if (field === 'issues' || field === 'pullRequests') {
      const t = field === 'issues' ? 'Issue' : 'PullRequest';
      return paginate(orderItems(filterItems(mapValues(field === 'issues' ? r.issues : r.pulls), t, args, store), args.orderBy).map(x => wrap(t, x, r)), args);
    }
    if (field === 'labels') {
      return paginate(orderItems(mapValues(r.labels).filter(x => !args.query || x.name.toLowerCase().includes(args.query.toLowerCase())), args.orderBy, 'NAME').map(x => wrap('Label', x, r)), args);
    }
    if (field === 'label') return wrap('Label', r.labels.get(args.name), r);
    if (field === 'assignableUsers' || field === 'mentionableUsers') {
      return paginate(!args.query || store.login.toLowerCase().includes(args.query.toLowerCase()) ? [currentUser(store)] : [], args);
    }
    if (field === 'ref') return gitRefOf(r, args.qualifiedName);
    if (field === 'refs') {
      const refs = [...r.git.refs.keys()].filter(x => x.startsWith(args.refPrefix) && (!args.query || x.includes(args.query))).sort();
      if (args.orderBy?.direction === 'DESC') refs.reverse();
      return paginate(refs.map(x => gitRefOf(r, x)), args);
    }
    if (field === 'object') {
      if (args.oid) return gitObjectOf(r, args.oid);
      const expression = args.expression ?? r.default_branch;
      const i = expression.indexOf(':');
      if (i < 0) return gitObjectOf(r, r.git.resolve(expression));
      const entry = r.git.files(expression.slice(0, i)).get(expression.slice(i + 1));
      return entry ? gitObjectOf(r, entry.sha) : null;
    }
    const derived = {
      hasIssuesEnabled: r.has_issues !== false, hasWikiEnabled: r.has_wiki !== false, hasDiscussionsEnabled: false,
      isPrivate: !!r.private, visibility: r.private ? 'PRIVATE' : 'PUBLIC', isFork: !!r.fork, isArchived: !!r.archived,
      isLocked: false, isEmpty: !r.git.resolve(r.default_branch), url: webOf(store, r), sshUrl: `${webOf(store, r)}.git`,
      descriptionHTML: escapeHTML(r.description ?? ''), createdAt: r.created_at ?? FIXED_DATE,
      updatedAt: r.updated_at ?? FIXED_DATE, pushedAt: r.pushed_at ?? r.updated_at ?? null,
      homepageUrl: r.homepage ?? null, stargazerCount: r.stargazers_count ?? 0, forkCount: r.forks_count ?? 0,
      diskUsage: 0, viewerHasStarred: false, mergeCommitAllowed: false, squashMergeAllowed: true,
      rebaseMergeAllowed: false, deleteBranchOnMerge: !!r.delete_branch_on_merge,
    };
    return hasOwn(derived, field) ? derived[field] : r[field] ?? null;
  }
  if (type === 'Issue' || type === 'PullRequest' || type === 'IssueComment') {
    const isPull = type === 'PullRequest';
    const isComment = type === 'IssueComment';
    if (field === 'id') return v.node_id;
    if (field === 'databaseId') return v.id;
    if (field === 'repository') return wrap('Repository', repo);
    if (field === 'author') return wrap('User', v.user ?? store.userJSON?.() ?? { login: store.login });
    if (field === 'editor') return null;
    if (field === 'bodyText' || field === 'body') return v.body ?? '';
    if (field === 'bodyHTML') return escapeHTML(v.body ?? '');
    if (field === 'createdAt' || field === 'updatedAt') return v[field === 'createdAt' ? 'created_at' : 'updated_at'] ?? FIXED_DATE;
    if (field === 'closedAt') return v.closed_at ?? null;
    if (field === 'lastEditedAt') return v.last_edited_at ?? null;
    if (field === 'state') return stateOf(v, type);
    if (field === 'closed') return v.state === 'closed';
    if (field === 'stateReason') return v.state_reason ? v.state_reason.toUpperCase() : v.state === 'closed' ? 'COMPLETED' : null;
    if (field === 'url') return v.html_url ?? `${webOf(store, repo)}/${isPull ? 'pull' : 'issues'}/${v.number ?? ''}${isComment ? `#issuecomment-${v.id}` : ''}`;
    if (['viewerCanUpdate', 'viewerCanDelete', 'viewerCanSubscribe'].includes(field)) return true;
    if (field === 'viewerDidAuthor') return (v.user?.login ?? store.login) === store.login;
    if (field === 'viewerSubscription') return 'UNSUBSCRIBED';
    if (field === 'locked' || field === 'isPinned') return !!v[field];
    if (field === 'activeLockReason') return v.active_lock_reason?.toUpperCase() ?? null;
    if (field === 'labels') return paginate((v.labels ?? []).map(x => wrap('Label', typeof x === 'string' ? repo.labels.get(x) ?? { name: x } : x, repo)), args);
    if (field === 'assignees') return paginate((v.assignees ?? []).map(x => wrap('User', typeof x === 'string' ? { login: x } : x)), args);
    if (field === 'participants') return paginate([wrap('User', v.user ?? store.userJSON?.() ?? { login: store.login })], args);
    if (field === 'comments') return paginate((v.comments ?? []).map(x => wrap('IssueComment', x, repo)), args);
    if (field === 'reactions') return paginate([], args);
    if (field === 'reactionGroups') return [];
    if (isComment && (field === 'issue' || field === 'pullRequest')) {
      const number = v.issue_number ?? v.number;
      return wrap(field === 'issue' ? 'Issue' : 'PullRequest', (field === 'issue' ? repo.issues : repo.pulls).get(number), repo);
    }
    if (isPull) {
      const refs = store.pullRefs(repo, v);
      const head = refs.head.ref;
      const base = refs.base.ref;
      if (field === 'headRefName') return head;
      if (field === 'baseRefName') return base;
      if (field === 'headRefOid') return refs.head.sha ?? '';
      if (field === 'baseRefOid') return refs.base.sha ?? '';
      if (field === 'headRef' || field === 'baseRef') return gitRefOf(repo, field === 'headRef' ? head : base);
      if (field === 'headRepository' || field === 'baseRepository') return wrap('Repository', repo);
      if (field === 'headRepositoryOwner') return wrap('User', repo.owner);
      if (field === 'isCrossRepository') return false;
      if (field === 'merged') return !!v.merged;
      if (field === 'mergedAt') return v.merged_at ?? null;
      if (field === 'mergedBy') return v.merged ? wrap('User', v.merged_by ?? store.userJSON?.() ?? { login: store.login }) : null;
      if (field === 'isDraft') return !!v.draft;
      if (field === 'maintainerCanModify') return v.maintainer_can_modify !== false;
      if (field === 'reviewDecision') return null;
      if (field === 'mergeCommit') return gitObjectOf(repo, v.merge_commit_sha);
      if (field === 'mergeable') return v.mergeable === false ? 'CONFLICTING' : v.mergeable === true ? 'MERGEABLE' : 'UNKNOWN';
      if (field === 'mergeStateStatus') return v.draft ? 'DRAFT' : v.mergeable === false ? 'DIRTY' : v.mergeable === true ? 'CLEAN' : 'UNKNOWN';
      if (['files', 'additions', 'deletions', 'changedFiles'].includes(field)) {
        const changed = store.pullFiles(repo, v);
        if (field === 'files') {
          return paginate(changed.map(x => ({
            path: x.filename, additions: x.additions ?? 0, deletions: x.deletions ?? 0,
            changeType: ({ added: 'ADDED', removed: 'DELETED', renamed: 'RENAMED', copied: 'COPIED' })[x.status] ?? 'MODIFIED',
            viewerViewedState: 'UNVIEWED',
          })), args);
        }
        if (field === 'changedFiles') return changed.length;
        return changed.reduce((n, x) => n + (x[field] ?? 0), 0);
      }
      if (field === 'commits') {
        const baseOid = refs.base.sha;
        const list = [];
        const seen = new Set();
        let oid = refs.head.sha;
        while (oid && !repo.git.isAncestor(oid, baseOid) && !seen.has(oid) && list.length < 10000) {
          seen.add(oid);
          const c = gitObjectOf(repo, oid);
          if (!c || c.__kind !== 'Commit') break;
          list.push({ commit: c, url: `${webOf(store, repo)}/commit/${oid}` });
          oid = parseCommit(c.value.data).parents[0];
        }
        return paginate(list.reverse(), args);
      }
    }
    return v[field] ?? null;
  }
  if (type === 'Label') {
    if (field === 'id') return v.node_id ?? stableNodeId('Label', `${repo.id}:${v.name}`);
    if (field === 'isDefault') return !!v.default;
    if (field === 'url') return `${webOf(store, repo)}/labels/${enc(v.name)}`;
    if (field === 'color') return v.color ?? 'ededed';
    return v[field] ?? null;
  }
  if (type === 'Ref') {
    if (field === 'id') return stableNodeId('Ref', `${repo.id}:${v.prefix}${v.name}`);
    if (field === 'target') return gitObjectOf(repo, v.oid);
    if (field === 'repository') return wrap('Repository', repo);
    return v[field] ?? null;
  }
  if (['Commit', 'Tree', 'Blob'].includes(type)) {
    if (field === 'id') return stableNodeId(type, `${repo.id}:${v.oid}`);
    if (field === 'oid') return v.oid;
    if (field === 'abbreviatedOid') return v.oid.slice(0, 7);
    if (field === 'repository') return wrap('Repository', repo);
    if (type === 'Blob') {
      if (field === 'byteSize') return v.data.length;
      if (field === 'isBinary') return v.data.includes(0);
      if (field === 'isTruncated') return false;
      if (field === 'text') return v.data.includes(0) ? null : v.data.toString();
    }
    if (type === 'Tree' && field === 'entries') {
      const list = [];
      let offset = 0;
      while (offset < v.data.length) {
        const space = v.data.indexOf(32, offset);
        const zero = v.data.indexOf(0, space);
        if (space < 0 || zero < 0 || zero + 21 > v.data.length) break;
        const mode = parseInt(v.data.subarray(offset, space).toString(), 8);
        const name = v.data.subarray(space + 1, zero).toString();
        const oid = v.data.subarray(zero + 1, zero + 21).toString('hex');
        list.push({ name, path: name, mode, oid, type: mode === 0o40000 ? 'tree' : 'blob', object: gitObjectOf(repo, oid), repository: wrap('Repository', repo) });
        offset = zero + 21;
      }
      return list;
    }
    if (type === 'Commit') {
      const info = parseCommit(v.data);
      if (field === 'tree') return gitObjectOf(repo, info.tree);
      if (field === 'parents') return paginate(info.parents.map(x => gitObjectOf(repo, x)), args);
      if (field === 'message') return info.message;
      if (field === 'messageHeadline') return info.message.split('\n')[0];
      if (field === 'messageBody') return info.message.split('\n').slice(1).join('\n').trim();
      if (field === 'author' || field === 'committer') return info[field];
      if (field === 'committedDate' || field === 'authoredDate') return info[field === 'committedDate' ? 'committer' : 'author'].date;
      if (field === 'url') return `${webOf(store, repo)}/commit/${v.oid}`;
      if (field === 'history') {
        const list = [];
        const seen = new Set();
        const stack = [v.oid];
        while (stack.length && list.length < 10000) {
          const oid = stack.shift();
          if (seen.has(oid)) continue;
          seen.add(oid);
          const c = gitObjectOf(repo, oid);
          if (!c || c.__kind !== 'Commit') continue;
          const ci = parseCommit(c.value.data);
          stack.push(...ci.parents);
          if ((!args.since || ci.committer.date >= args.since) && (!args.until || ci.committer.date <= args.until)) list.push(c);
        }
        return paginate(list, args);
      }
    }
  }
  return source?.[field] ?? null;
}

// ---------------------------------------------------------------- mutations
// Mutations run through the store's REST layer so REST, GraphQL and MCP
// always share the same objects and validation.
async function runMutation(name, input, store) {
  const payload = { clientMutationId: input.clientMutationId ?? null };
  const labelNames = ids => ids?.map(id => requireNode(store, id, ['Label']).value.name);
  const assigneeLogins = ids => ids?.map(id => requireNode(store, id, ['User']).value.login);
  if (['createRepository', 'updateRepository', 'deleteRepository'].includes(name)) {
    const n = name === 'createRepository' ? null : requireNode(store, input.repositoryId, ['Repository']);
    if (name === 'deleteRepository') {
      restCall(store, 'DELETE', repoPathOf(n.value));
      return payload;
    }
    const body = {};
    for (const k of ['name', 'description']) if (hasOwn(input, k)) body[k] = input[k];
    if (input.visibility) body.private = input.visibility !== 'PUBLIC';
    for (const [g, r] of [['hasIssuesEnabled', 'has_issues'], ['hasWikiEnabled', 'has_wiki'], ['homepageUrl', 'homepage']]) {
      if (hasOwn(input, g)) body[r] = input[g];
    }
    const r = restCall(store, n ? 'PATCH' : 'POST', n ? repoPathOf(n.value) : '/user/repos', body);
    payload.repository = wrap('Repository', store.getRepo(r.owner?.login ?? store.login, r.name) ?? r);
    return payload;
  }
  if (name === 'createIssue' || name === 'createPullRequest') {
    const r = requireNode(store, input.repositoryId, ['Repository']).value;
    const body = { title: input.title, body: input.body ?? '' };
    if (input.labelIds) body.labels = labelNames(input.labelIds);
    if (input.assigneeIds) body.assignees = assigneeLogins(input.assigneeIds);
    const isPull = name === 'createPullRequest';
    if (isPull) {
      Object.assign(body, { head: input.headRefName, base: input.baseRefName, draft: input.draft ?? false, maintainer_can_modify: input.maintainerCanModify ?? true });
    }
    const value = restCall(store, 'POST', `${repoPathOf(r)}/${isPull ? 'pulls' : 'issues'}`, body);
    payload[isPull ? 'pullRequest' : 'issue'] = wrap(isPull ? 'PullRequest' : 'Issue', (isPull ? r.pulls : r.issues).get(value.number) ?? value, r);
    if (!isPull) payload.repository = wrap('Repository', r);
    return payload;
  }
  if (['addComment', 'updateIssueComment', 'deleteIssueComment'].includes(name)) {
    if (name === 'addComment') {
      const n = requireNode(store, input.subjectId, ['Issue', 'PullRequest']);
      const comment = restCall(store, 'POST', `${repoPathOf(n.repo)}/issues/${n.value.number}/comments`, { body: input.body });
      payload.commentEdge = { cursor: Buffer.from(`cursor:${comment.id}`).toString('base64'), node: wrap('IssueComment', comment, n.repo) };
      payload.subject = n;
    } else {
      const n = requireNode(store, input.id, ['IssueComment']);
      const comment = restCall(store, name === 'deleteIssueComment' ? 'DELETE' : 'PATCH', `${repoPathOf(n.repo)}/issues/comments/${n.value.id}`, { body: input.body });
      if (name === 'updateIssueComment') payload.issueComment = wrap('IssueComment', comment, n.repo);
    }
    return payload;
  }
  if (name === 'addLabelsToLabelable' || name === 'removeLabelsFromLabelable') {
    const n = requireNode(store, input.labelableId, ['Issue', 'PullRequest']);
    const labels = labelNames(input.labelIds);
    const existing = labelNamesOf(n.value);
    const result = name === 'addLabelsToLabelable'
      ? [...new Set([...existing, ...labels])]
      : existing.filter(x => !labels.includes(x));
    const updated = restCall(store, 'PATCH', `${repoPathOf(n.repo)}/issues/${n.value.number}`, { labels: result });
    payload.labelable = wrap(n.__kind, (n.__kind === 'Issue' ? n.repo.issues : n.repo.pulls).get(n.value.number) ?? updated, n.repo);
    return payload;
  }
  const isPull = name.includes('PullRequest');
  const n = requireNode(store, input.pullRequestId ?? input.issueId ?? input.id, [isPull ? 'PullRequest' : 'Issue']);
  if (name === 'mergePullRequest') {
    restCall(store, 'PUT', `${repoPathOf(n.repo)}/pulls/${n.value.number}/merge`, {
      merge_method: (input.mergeMethod ?? 'SQUASH').toLowerCase(),
      commit_title: input.commitHeadline, commit_message: input.commitBody, sha: input.expectedHeadOid,
    });
    payload.pullRequest = wrap('PullRequest', n.repo.pulls.get(n.value.number), n.repo);
    payload.actor = currentUser(store);
    return payload;
  }
  const body = {};
  for (const k of ['title', 'body']) if (hasOwn(input, k)) body[k] = input[k];
  if (input.state) {
    if (input.state === 'MERGED') throw new Error('Use mergePullRequest to merge a pull request.');
    body.state = input.state.toLowerCase();
  }
  if (name.startsWith('close')) body.state = 'closed';
  if (name.startsWith('reopen')) body.state = 'open';
  if (input.stateReason) body.state_reason = input.stateReason.toLowerCase();
  if (input.baseRefName) body.base = input.baseRefName;
  if (hasOwn(input, 'maintainerCanModify')) body.maintainer_can_modify = input.maintainerCanModify;
  if (input.labelIds) body.labels = labelNames(input.labelIds);
  if (input.assigneeIds) body.assignees = assigneeLogins(input.assigneeIds);
  const result = restCall(store, 'PATCH', `${repoPathOf(n.repo)}/${isPull ? 'pulls' : 'issues'}/${n.value.number}`, body);
  payload[isPull ? 'pullRequest' : 'issue'] = wrap(n.__kind, (isPull ? n.repo.pulls : n.repo.issues).get(n.value.number) ?? result, n.repo);
  return payload;
}

// ---------------------------------------------------------------- entry point
async function singleRequest(body, store) {
  try {
    if (!isRecord(body) || typeof body.query !== 'string' || !body.query.trim()) {
      throw new GraphQLError('Must provide a non-empty GraphQL query string.');
    }
    if (body.query.length > 524288) throw new GraphQLError('GraphQL document is too large.');
    if (body.variables != null && !isRecord(body.variables)) throw new GraphQLError('Variables must be a JSON object.');
    if (body.operationName != null && typeof body.operationName !== 'string') throw new GraphQLError('operationName must be a string.');
    const doc = new Parser(body.query).parseDocument();
    validateDocument(doc);
    if (!body.operationName && doc.operations.length > 1) throw new GraphQLError('Must provide operation name if query contains multiple operations.');
    const op = body.operationName ? doc.operations.find(x => x.name === body.operationName) : doc.operations[0];
    if (!op) throw new GraphQLError(`Unknown operation named "${body.operationName}".`);
    const vars = Object.create(null);
    const supplied = body.variables ?? {};
    for (const v of op.variables) {
      const raw = hasOwn(supplied, v.name) ? supplied[v.name] : v.defaultValue !== MISSING ? literalValue(v.defaultValue, {}) : MISSING;
      const value = coerceValue(raw, v.type, `Variable "$${v.name}"`, v);
      if (value !== MISSING) vars[v.name] = value;
    }
    return await executeOperation(doc, op, vars, store);
  } catch (e) {
    return { errors: [e instanceof GraphQLError ? e.toJSON() : { message: e.message ?? String(e) }] };
  }
}

/** The HTTP layer owns authorization/status/JSON parsing; this returns GraphQL JSON. */
export async function handleGraphQL(body, store) {
  if (!Array.isArray(body)) return singleRequest(body, store);
  if (body.length === 0 || body.length > 100) return { errors: [{ message: 'A GraphQL batch must contain between 1 and 100 operations.' }] };
  const out = [];
  for (const request of body) out.push(await singleRequest(request, store));
  return out;
}

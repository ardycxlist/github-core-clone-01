// graphql.ts — a small GraphQL executor for the forge's GraphQL surface.
//
// Hand-written lexer/parser/executor for exactly the documents gh and
// github-mcp-server send (see the kit's checks-graphql.ts): queries,
// mutations, variables, inline fragments, aliases, enums, input objects,
// operation names, batching. No GraphQL library; stdlib only.
//
// Determinism: global ids and cursors are pure functions of stable ids and
// positions (base64 of "Type:dbid" / "cursor:offset"). No clock, no random.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "./store.ts";
import type { Issue, IssueComment, Pull, Repo } from "./store.ts";
import { viewerLogin, viewerUser } from "./scenario.ts";
import {
  addCommentRecord,
  createIssueRecord,
  createPullRecord,
  mergeableState,
  pullChangedFiles,
  squashMergeRecord,
} from "./rest.ts";
import { HttpError, readBody, requireAuth, sendJson } from "./http-util.ts";

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type Token =
  | { kind: "name"; value: string }
  | { kind: "int"; value: string }
  | { kind: "float"; value: string }
  | { kind: "string"; value: string }
  | { kind: "punct"; value: string }
  | { kind: "eof" };

const PUNCT3 = "...";

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i] as string;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === ",") {
      i += 1;
      continue;
    }
    if (ch === "#") {
      while (i < n && source[i] !== "\n") i += 1;
      continue;
    }
    if (source.startsWith(PUNCT3, i)) {
      tokens.push({ kind: "punct", value: "..." });
      i += 3;
      continue;
    }
    if ("{}()[]!:$=@&|".includes(ch)) {
      tokens.push({ kind: "punct", value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new SyntaxError("unterminated block string");
        const raw = source.slice(i + 3, end).replace(/\\"""/g, '"""');
        tokens.push({ kind: "string", value: raw.trim() });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = "";
      while (j < n) {
        const c = source[j] as string;
        if (c === '"') break;
        if (c === "\\") {
          const e = source[j + 1] as string;
          if (e === "n") out += "\n";
          else if (e === "t") out += "\t";
          else if (e === "r") out += "\r";
          else if (e === "b") out += "\b";
          else if (e === "f") out += "\f";
          else if (e === "/") out += "/";
          else if (e === "\\") out += "\\";
          else if (e === '"') out += '"';
          else if (e === "u") {
            out += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += e;
          j += 2;
          continue;
        }
        out += c;
        j += 1;
      }
      if (j >= n) throw new SyntaxError("unterminated string");
      tokens.push({ kind: "string", value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === "-") j += 1;
      while (j < n && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === "." && /[0-9]/.test(source[j + 1] as string)) {
        isFloat = true;
        j += 1;
        while (j < n && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === "e" || source[j] === "E") {
        isFloat = true;
        j += 1;
        if (source[j] === "+" || source[j] === "-") j += 1;
        while (j < n && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? "float" : "int", value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < n && /[_0-9A-Za-z]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: "name", value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new SyntaxError(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: "eof" });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (AST)
// ---------------------------------------------------------------------------

export type ValueNode =
  | { kind: "variable"; name: string }
  | { kind: "int"; value: number }
  | { kind: "float"; value: number }
  | { kind: "string"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "null" }
  | { kind: "enum"; value: string }
  | { kind: "list"; items: ValueNode[] }
  | { kind: "object"; fields: { name: string; value: ValueNode }[] };

interface DirectiveNode {
  name: string;
  args: { name: string; value: ValueNode }[];
}

interface FieldNode {
  kind: "field";
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  directives: DirectiveNode[];
  selections: SelectionNode[] | null;
}

interface SpreadNode {
  kind: "spread";
  name: string;
  directives: DirectiveNode[];
}

interface InlineNode {
  kind: "inline";
  typeCondition: string | null;
  directives: DirectiveNode[];
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | SpreadNode | InlineNode;

interface OperationNode {
  kind: "operation";
  operation: "query" | "mutation";
  name: string | null;
  selections: SelectionNode[];
}

interface FragmentNode {
  kind: "fragment";
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const t = this.tokens[this.pos] as Token;
    this.pos += 1;
    return t;
  }

  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== "punct" || t.value !== value) {
      throw new SyntaxError(`expected "${value}", got ${t.kind} ${"value" in t ? t.value : ""}`);
    }
  }

  private isPunct(value: string): boolean {
    const t = this.peek();
    return t.kind === "punct" && t.value === value;
  }

  private expectName(what = "a name"): string {
    const t = this.next();
    if (t.kind !== "name") throw new SyntaxError(`expected ${what}`);
    return t.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== "eof") {
      const t = this.peek();
      if (t.kind === "punct" && t.value === "{") {
        operations.push({
          kind: "operation",
          operation: "query",
          name: null,
          selections: this.parseSelectionSet(),
        });
        continue;
      }
      if (t.kind === "name" && (t.value === "query" || t.value === "mutation")) {
        const operation = t.value as "query" | "mutation";
        this.next();
        let name: string | null = null;
        if (this.peek().kind === "name") name = this.next().value as string;
        this.parseVariableDefinitions();
        this.parseDirectives();
        operations.push({
          kind: "operation",
          operation,
          name,
          selections: this.parseSelectionSet(),
        });
        continue;
      }
      if (t.kind === "name" && t.value === "fragment") {
        this.next();
        const name = this.expectName("a fragment name");
        const on = this.expectName("the 'on' keyword");
        if (on !== "on") throw new SyntaxError(`expected "on" in a fragment`);
        const typeCondition = this.expectName("a type condition");
        this.parseDirectives();
        fragments.set(name, {
          kind: "fragment",
          name,
          typeCondition,
          selections: this.parseSelectionSet(),
        });
        continue;
      }
      throw new SyntaxError(`unexpected token ${t.kind} ${"value" in t ? t.value : ""}`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    if (!this.isPunct("(")) return;
    this.next();
    while (!this.isPunct(")")) {
      if (this.peek().kind === "eof") throw new SyntaxError("unterminated variable definitions");
      this.expectPunct("$");
      this.expectName("a variable name");
      this.expectPunct(":");
      this.parseType();
      if (this.isPunct("=")) {
        this.next();
        this.parseValue();
      }
    }
    this.expectPunct(")");
  }

  private parseType(): void {
    if (this.isPunct("[")) {
      this.next();
      this.parseType();
      this.expectPunct("]");
    } else {
      this.expectName("a type name");
    }
    if (this.isPunct("!")) this.next();
  }

  private parseDirectives(): DirectiveNode[] {
    const directives: DirectiveNode[] = [];
    while (this.isPunct("@")) {
      this.next();
      const name = this.expectName("a directive name");
      let args: { name: string; value: ValueNode }[] = [];
      if (this.isPunct("(")) args = this.parseArguments();
      directives.push({ name, args });
    }
    return directives;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct("{");
    const selections: SelectionNode[] = [];
    while (!this.isPunct("}")) {
      if (this.peek().kind === "eof") throw new SyntaxError("unterminated selection set");
      selections.push(this.parseSelection());
    }
    this.expectPunct("}");
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.isPunct("...")) {
      this.next();
      const t = this.peek();
      if (t.kind === "name" && t.value === "on") {
        this.next();
        const typeCondition = this.expectName("a type condition");
        const directives = this.parseDirectives();
        return { kind: "inline", typeCondition, directives, selections: this.parseSelectionSet() };
      }
      if (t.kind === "name") {
        const name = this.next().value as string;
        const directives = this.parseDirectives();
        return { kind: "spread", name, directives };
      }
      const directives = this.parseDirectives();
      return { kind: "inline", typeCondition: null, directives, selections: this.parseSelectionSet() };
    }
    let alias: string | null = null;
    let name = this.expectName("a field name");
    if (this.isPunct(":")) {
      this.next();
      alias = name;
      name = this.expectName("a field name");
    }
    let args: { name: string; value: ValueNode }[] = [];
    if (this.isPunct("(")) args = this.parseArguments();
    const directives = this.parseDirectives();
    let selections: SelectionNode[] | null = null;
    if (this.isPunct("{")) selections = this.parseSelectionSet();
    return { kind: "field", alias, name, args, directives, selections };
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    this.expectPunct("(");
    const args: { name: string; value: ValueNode }[] = [];
    while (!this.isPunct(")")) {
      if (this.peek().kind === "eof") throw new SyntaxError("unterminated arguments");
      const name = this.expectName("an argument name");
      this.expectPunct(":");
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(")");
    return args;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === "punct" && t.value === "$") {
      return { kind: "variable", name: this.expectName("a variable name") };
    }
    if (t.kind === "punct" && t.value === "[") {
      const items: ValueNode[] = [];
      while (!this.isPunct("]")) {
        if (this.peek().kind === "eof") throw new SyntaxError("unterminated list");
        items.push(this.parseValue());
      }
      this.expectPunct("]");
      return { kind: "list", items };
    }
    if (t.kind === "punct" && t.value === "{") {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.isPunct("}")) {
        if (this.peek().kind === "eof") throw new SyntaxError("unterminated object");
        const name = this.expectName("an object field name");
        this.expectPunct(":");
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct("}");
      return { kind: "object", fields };
    }
    if (t.kind === "int") return { kind: "int", value: parseInt(t.value, 10) };
    if (t.kind === "float") return { kind: "float", value: parseFloat(t.value) };
    if (t.kind === "string") return { kind: "string", value: t.value };
    if (t.kind === "name") {
      if (t.value === "true") return { kind: "boolean", value: true };
      if (t.value === "false") return { kind: "boolean", value: false };
      if (t.value === "null") return { kind: "null" };
      return { kind: "enum", value: t.value };
    }
    throw new SyntaxError(`unexpected value token ${t.kind}`);
  }
}

function parseDocument(source: string): DocumentNode {
  return new Parser(lex(source)).parseDocument();
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

type Variables = Record<string, unknown>;

function resolveValue(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case "variable":
      return variables[node.name] ?? null;
    case "int":
    case "float":
    case "string":
    case "boolean":
      return node.value;
    case "null":
      return null;
    case "enum":
      return node.value;
    case "list":
      return node.items.map((item) => resolveValue(item, variables));
    case "object": {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

/** Whether @skip/@include directives let this selection run. */
function directivesAllow(directives: DirectiveNode[], variables: Variables): boolean {
  for (const directive of directives) {
    const ifArg = directive.args.find((a) => a.name === "if");
    const flag = ifArg ? resolveValue(ifArg.value, variables) : true;
    if (directive.name === "skip" && flag === true) return false;
    if (directive.name === "include" && flag !== true) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Global ids and cursors (pure functions of stable ids and positions)
// ---------------------------------------------------------------------------

export function globalId(type: string, dbid: number): string {
  return Buffer.from(`${type}:${dbid}`, "utf8").toString("base64");
}

function parseGlobalId(id: unknown): { type: string; dbid: number } | null {
  if (typeof id !== "string" || id === "") return null;
  let text: string;
  try {
    text = Buffer.from(id, "base64").toString("utf8");
  } catch {
    return null;
  }
  const m = /^([A-Za-z]+):(\d+)$/.exec(text);
  if (!m) return null;
  return { type: m[1] as string, dbid: Number(m[2]) };
}

function cursorFor(offset: number): string {
  return Buffer.from(`cursor:${offset}`, "utf8").toString("base64");
}

function offsetOfCursor(cursor: unknown): number {
  if (typeof cursor !== "string" || cursor === "") return -1;
  try {
    const text = Buffer.from(cursor, "base64").toString("utf8");
    const m = /^cursor:(\d+)$/.exec(text);
    if (!m) return -1;
    return Number(m[1]);
  } catch {
    return -1;
  }
}

// ---------------------------------------------------------------------------
// Schema (for validation and introspection)
// ---------------------------------------------------------------------------

interface TypeInfo {
  kind: "OBJECT" | "ENUM" | "INPUT_OBJECT" | "SCALAR";
  fields: string[];
  enumValues: string[];
}

const TYPE_INFO: Record<string, TypeInfo> = {
  Query: {
    kind: "OBJECT",
    fields: ["viewer", "repository", "node", "__type", "__schema"],
    enumValues: [],
  },
  Mutation: {
    kind: "OBJECT",
    fields: ["createIssue", "closeIssue", "createPullRequest", "mergePullRequest", "addComment"],
    enumValues: [],
  },
  User: { kind: "OBJECT", fields: ["id", "login", "name", "email"], enumValues: [] },
  Node: { kind: "OBJECT", fields: ["id"], enumValues: [] },
  Repository: {
    kind: "OBJECT",
    fields: [
      "id", "databaseId", "name", "nameWithOwner", "owner", "defaultBranchRef",
      "viewerPermission", "hasIssuesEnabled", "issue", "issues", "pullRequests", "pullRequest",
    ],
    enumValues: [],
  },
  RepositoryRef: { kind: "OBJECT", fields: ["name"], enumValues: [] },
  Issue: { kind: "OBJECT", fields: ["id", "number", "title", "state", "body"], enumValues: [] },
  IssueConnection: { kind: "OBJECT", fields: ["nodes", "pageInfo", "totalCount"], enumValues: [] },
  PullRequest: {
    kind: "OBJECT",
    fields: ["id", "number", "state", "merged", "headRefName", "baseRefName", "mergeable", "files"],
    enumValues: [],
  },
  PullRequestConnection: { kind: "OBJECT", fields: ["nodes", "pageInfo", "totalCount"], enumValues: [] },
  PullRequestChangedFileConnection: { kind: "OBJECT", fields: ["nodes", "pageInfo", "totalCount"], enumValues: [] },
  PullRequestChangedFile: {
    kind: "OBJECT",
    fields: ["path", "filename", "status", "additions", "deletions", "changes"],
    enumValues: [],
  },
  PageInfo: {
    kind: "OBJECT",
    fields: ["hasNextPage", "hasPreviousPage", "startCursor", "endCursor"],
    enumValues: [],
  },
  IssueComment: { kind: "OBJECT", fields: ["id", "body"], enumValues: [] },
  IssueCommentEdge: { kind: "OBJECT", fields: ["node", "cursor"], enumValues: [] },
  CreateIssuePayload: { kind: "OBJECT", fields: ["issue"], enumValues: [] },
  CloseIssuePayload: { kind: "OBJECT", fields: ["issue"], enumValues: [] },
  CreatePullRequestPayload: { kind: "OBJECT", fields: ["pullRequest"], enumValues: [] },
  MergePullRequestPayload: { kind: "OBJECT", fields: ["pullRequest"], enumValues: [] },
  AddCommentPayload: { kind: "OBJECT", fields: ["commentEdge"], enumValues: [] },
  __Schema: { kind: "OBJECT", fields: ["queryType", "mutationType", "types", "description"], enumValues: [] },
  __Type: {
    kind: "OBJECT",
    fields: ["name", "kind", "description", "fields", "enumValues"],
    enumValues: [],
  },
  __Field: { kind: "OBJECT", fields: ["name", "description", "args", "type"], enumValues: [] },
  __EnumValue: { kind: "OBJECT", fields: ["name", "description"], enumValues: [] },
  __InputValue: { kind: "OBJECT", fields: ["name", "description", "type"], enumValues: [] },
  IssueState: { kind: "ENUM", fields: [], enumValues: ["OPEN", "CLOSED"] },
  PullRequestState: { kind: "ENUM", fields: [], enumValues: ["OPEN", "CLOSED", "MERGED"] },
  MergeableState: { kind: "ENUM", fields: [], enumValues: ["MERGEABLE", "CONFLICTING", "UNKNOWN"] },
  PullRequestMergeMethod: { kind: "ENUM", fields: [], enumValues: ["MERGE", "SQUASH", "REBASE"] },
  RepositoryPermission: {
    kind: "ENUM",
    fields: [],
    enumValues: ["ADMIN", "MAINTAIN", "WRITE", "TRIAGE", "READ"],
  },
  SearchType: {
    kind: "ENUM",
    fields: [],
    enumValues: ["ISSUE", "REPOSITORY", "USER", "CODE", "DISCUSSION", "COMMIT"],
  },
  IssueOrderField: { kind: "ENUM", fields: [], enumValues: ["CREATED_AT", "UPDATED_AT", "COMMENTS"] },
  OrderDirection: { kind: "ENUM", fields: [], enumValues: ["ASC", "DESC"] },
  CreateIssueInput: { kind: "INPUT_OBJECT", fields: ["repositoryId", "title", "body"], enumValues: [] },
  CloseIssueInput: { kind: "INPUT_OBJECT", fields: ["issueId"], enumValues: [] },
  CreatePullRequestInput: {
    kind: "INPUT_OBJECT",
    fields: ["repositoryId", "baseRefName", "headRefName", "title", "body"],
    enumValues: [],
  },
  MergePullRequestInput: { kind: "INPUT_OBJECT", fields: ["pullRequestId", "mergeMethod"], enumValues: [] },
  AddCommentInput: { kind: "INPUT_OBJECT", fields: ["subjectId", "body"], enumValues: [] },
  IssueOrder: { kind: "INPUT_OBJECT", fields: ["field", "direction"], enumValues: [] },
};

/** The return type of a field, for nested selection validation. */
const FIELD_TYPES: Record<string, Record<string, string>> = {
  Query: { viewer: "User", repository: "Repository", node: "Node", __type: "__Type", __schema: "__Schema" },
  Mutation: {
    createIssue: "CreateIssuePayload",
    closeIssue: "CloseIssuePayload",
    createPullRequest: "CreatePullRequestPayload",
    mergePullRequest: "MergePullRequestPayload",
    addComment: "AddCommentPayload",
  },
  Repository: {
    owner: "User",
    defaultBranchRef: "RepositoryRef",
    issue: "Issue",
    issues: "IssueConnection",
    pullRequests: "PullRequestConnection",
    pullRequest: "PullRequest",
  },
  IssueConnection: { nodes: "Issue", pageInfo: "PageInfo" },
  PullRequestConnection: { nodes: "PullRequest", pageInfo: "PageInfo" },
  PullRequestChangedFileConnection: { nodes: "PullRequestChangedFile", pageInfo: "PageInfo" },
  PullRequest: { files: "PullRequestChangedFileConnection" },
  CreateIssuePayload: { issue: "Issue" },
  CloseIssuePayload: { issue: "Issue" },
  CreatePullRequestPayload: { pullRequest: "PullRequest" },
  MergePullRequestPayload: { pullRequest: "PullRequest" },
  AddCommentPayload: { commentEdge: "IssueCommentEdge" },
  IssueCommentEdge: { node: "IssueComment" },
  __Schema: { queryType: "__Type", mutationType: "__Type", types: "__Type" },
  __Type: { fields: "__Field", enumValues: "__EnumValue" },
};

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface GraphQLError {
  message: string;
  path?: (string | number)[];
}

interface RuntimeValue {
  __typename: string;
  [key: string]: unknown;
}

interface ExecContext {
  store: Store;
  fragments: Map<string, FragmentNode>;
  variables: Variables;
  errors: GraphQLError[];
}

function isObjectValue(value: unknown): value is RuntimeValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function repoOwnerName(repo: Repo): string {
  return repo.owner ?? viewerLogin();
}

function issueState(issue: Issue): string {
  return issue.state === "open" ? "OPEN" : "CLOSED";
}

function pullState(pull: Pull): string {
  if (pull.merged) return "MERGED";
  return pull.state === "open" ? "OPEN" : "CLOSED";
}

function repoValue(repo: Repo): RuntimeValue {
  return { __typename: "Repository", __repo: repo };
}

function issueValue(issue: Issue, repo: Repo): RuntimeValue {
  return { __typename: "Issue", __issue: issue, __repo: repo };
}

function pullValue(pull: Pull, repo: Repo): RuntimeValue {
  return { __typename: "PullRequest", __pull: pull, __repo: repo };
}

function commentValue(comment: IssueComment): RuntimeValue {
  return { __typename: "IssueComment", __comment: comment };
}

function userValue(login: string): RuntimeValue {
  return { __typename: "User", __login: login };
}

function viewerValue(): RuntimeValue {
  const viewer = viewerUser();
  return { __typename: "User", __login: viewer.login, __user: viewer };
}

/** Order issues by the orderBy argument (default CREATED_AT DESC, tie by number). */
function sortIssues(
  issues: Issue[],
  orderBy: Record<string, unknown> | null | undefined,
): Issue[] {
  const field = typeof orderBy?.field === "string" ? orderBy.field : "CREATED_AT";
  const direction = orderBy?.direction === "ASC" ? 1 : -1;
  const keyOf = (issue: Issue): number => {
    if (field === "COMMENTS") return issue.comments.length;
    return issue.createdSeq;
  };
  return [...issues].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka !== kb) return (ka - kb) * direction;
    return (a.number - b.number) * direction;
  });
}

function paginate<T>(
  items: T[],
  first: unknown,
  after: unknown,
): { page: T[]; pageInfo: Record<string, unknown>; totalCount: number } {
  // `after` names the last item already seen, so the page starts one past it.
  const afterOffset = offsetOfCursor(after);
  const start = afterOffset >= 0 ? afterOffset + 1 : 0;
  const limit = typeof first === "number" && Number.isFinite(first) && first >= 0 ? Math.trunc(first) : items.length;
  const page = items.slice(start, start + limit);
  const end = start + page.length;
  return {
    page,
    pageInfo: {
      __typename: "PageInfo",
      hasNextPage: end < items.length,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? cursorFor(start) : null,
      endCursor: page.length > 0 ? cursorFor(end - 1) : null,
    },
    totalCount: items.length,
  };
}

function resolveNode(ctx: ExecContext, id: unknown): RuntimeValue | null {
  const parsed = parseGlobalId(id);
  if (!parsed) return null;
  if (parsed.type === "Repository") {
    for (const repo of ctx.store.reposByName.values()) {
      if (repo.id === parsed.dbid) return repoValue(repo);
    }
    return null;
  }
  for (const repo of ctx.store.reposByName.values()) {
    if (parsed.type === "Issue") {
      for (const issue of repo.issues.values()) {
        if (issue.id === parsed.dbid) return issueValue(issue, repo);
      }
    }
    if (parsed.type === "PullRequest") {
      for (const pull of repo.pulls.values()) {
        if (pull.id === parsed.dbid) return pullValue(pull, repo);
      }
    }
    if (parsed.type === "IssueComment") {
      for (const issue of repo.issues.values()) {
        for (const comment of issue.comments) {
          if (comment.id === parsed.dbid) return commentValue(comment);
        }
      }
    }
  }
  return null;
}

function resolveRepoByGlobalId(ctx: ExecContext, id: unknown): Repo | null {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.type !== "Repository") return null;
  for (const repo of ctx.store.reposByName.values()) {
    if (repo.id === parsed.dbid) return repo;
  }
  return null;
}

function resolveIssueByGlobalId(ctx: ExecContext, id: unknown): { repo: Repo; issue: Issue } | null {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.type !== "Issue") return null;
  for (const repo of ctx.store.reposByName.values()) {
    const issue = [...repo.issues.values()].find((entry) => entry.id === parsed.dbid);
    if (issue) return { repo, issue };
  }
  return null;
}

function resolvePullByGlobalId(ctx: ExecContext, id: unknown): { repo: Repo; pull: Pull } | null {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.type !== "PullRequest") return null;
  for (const repo of ctx.store.reposByName.values()) {
    const pull = [...repo.pulls.values()].find((entry) => entry.id === parsed.dbid);
    if (pull) return { repo, pull };
  }
  return null;
}

/** Resolve one field of a runtime value. Returns null for a missing/nullable value. */
function resolveField(
  ctx: ExecContext,
  parentType: string,
  parent: RuntimeValue,
  field: FieldNode,
  args: Record<string, unknown>,
): unknown {
  const name = field.name;
  if (name === "__typename") return parentType === "Node" ? (parent.__typename as string) : parentType;

  switch (parentType) {
    case "Node": {
      if (name === "id") {
        const kind = parent.__typename as string;
        if (kind === "Repository") return globalId("Repository", (parent.__repo as Repo).id);
        if (kind === "Issue") return globalId("Issue", (parent.__issue as Issue).id);
        if (kind === "PullRequest") return globalId("PullRequest", (parent.__pull as Pull).id);
        if (kind === "IssueComment") return globalId("IssueComment", (parent.__comment as IssueComment).id);
      }
      return null;
    }
    case "Query": {
      if (name === "viewer") return viewerValue();
      if (name === "repository") {
        const owner = typeof args.owner === "string" ? args.owner : "";
        const repoName = typeof args.name === "string" ? args.name : "";
        const repo = ctx.store.resolveRepo(repoName, owner);
        return repo ? repoValue(repo) : null;
      }
      if (name === "node") return resolveNode(ctx, args.id);
      if (name === "__type") {
        const typeName = typeof args.name === "string" ? args.name : "";
        const info = TYPE_INFO[typeName];
        if (!info) return null;
        return {
          __typename: "__Type",
          __typeName: typeName,
          __typeInfo: info,
        };
      }
      if (name === "__schema") return { __typename: "__Schema" };
      return null;
    }
    case "Mutation": {
      return resolveMutation(ctx, name, args);
    }
    case "User": {
      const login = (parent.__login as string) ?? "";
      if (name === "login") return login;
      if (name === "id") return globalId("User", 1000);
      if (name === "name") return login;
      if (name === "email") return `${login}@example.invalid`;
      return null;
    }
    case "Repository": {
      const repo = parent.__repo as Repo;
      switch (name) {
        case "id":
          return globalId("Repository", repo.id);
        case "databaseId":
          return repo.id;
        case "name":
          return repo.name;
        case "nameWithOwner":
          return `${repoOwnerName(repo)}/${repo.name}`;
        case "owner":
          return userValue(repoOwnerName(repo));
        case "defaultBranchRef": {
          const ref = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          return ref ? { __typename: "RepositoryRef", __name: repo.defaultBranch } : null;
        }
        case "viewerPermission":
          return "ADMIN";
        case "hasIssuesEnabled":
          return true;
        case "issue": {
          const number = typeof args.number === "number" ? args.number : -1;
          const issue = repo.issues.get(number);
          return issue ? issueValue(issue, repo) : null;
        }
        case "issues": {
          let list = [...repo.issues.values()];
          const states = Array.isArray(args.states) ? (args.states as unknown[]) : null;
          if (states) {
            const wanted = new Set(states.map((s) => String(s)));
            list = list.filter((issue) => wanted.has(issueState(issue)));
          }
          const orderBy = (args.orderBy ?? null) as Record<string, unknown> | null;
          list = sortIssues(list, orderBy);
          const { page, pageInfo, totalCount } = paginate(list, args.first, args.after);
          return {
            __typename: "IssueConnection",
            __nodes: page.map((issue) => issueValue(issue, repo)),
            __pageInfo: pageInfo,
            __totalCount: totalCount,
          };
        }
        case "pullRequests": {
          const list = [...repo.pulls.values()].sort((a, b) => b.createdSeq - a.createdSeq);
          const { page, pageInfo, totalCount } = paginate(list, args.first, args.after);
          return {
            __typename: "PullRequestConnection",
            __nodes: page.map((pull) => pullValue(pull, repo)),
            __pageInfo: pageInfo,
            __totalCount: totalCount,
          };
        }
        case "pullRequest": {
          const number = typeof args.number === "number" ? args.number : -1;
          const pull = repo.pulls.get(number);
          return pull ? pullValue(pull, repo) : null;
        }
        default:
          return null;
      }
    }
    case "RepositoryRef": {
      if (name === "name") return parent.__name as string;
      return null;
    }
    case "Issue": {
      const issue = parent.__issue as Issue;
      switch (name) {
        case "id":
          return globalId("Issue", issue.id);
        case "number":
          return issue.number;
        case "title":
          return issue.title;
        case "state":
          return issueState(issue);
        case "body":
          return issue.body;
        default:
          return null;
      }
    }
    case "IssueConnection": {
      if (name === "nodes") return parent.__nodes as unknown[];
      if (name === "pageInfo") return parent.__pageInfo as unknown;
      if (name === "totalCount") return parent.__totalCount as number;
      return null;
    }
    case "PullRequest": {
      const pull = parent.__pull as Pull;
      const repo = parent.__repo as Repo;
      switch (name) {
        case "id":
          return globalId("PullRequest", pull.id);
        case "number":
          return pull.number;
        case "state":
          return pullState(pull);
        case "merged":
          return pull.merged;
        case "headRefName":
          return pull.headRef;
        case "baseRefName":
          return pull.baseRef;
        case "mergeable":
          return mergeableState(ctx.store, repo, pull);
        case "files": {
          const files = pullChangedFiles(ctx.store, repo, pull).map((file) => ({
            __typename: "PullRequestChangedFile",
            __file: file,
          }));
          const { page, pageInfo, totalCount } = paginate(files, args.first, undefined);
          return {
            __typename: "PullRequestChangedFileConnection",
            __nodes: page,
            __pageInfo: pageInfo,
            __totalCount: totalCount,
          };
        }
        default:
          return null;
      }
    }
    case "PullRequestConnection":
    case "PullRequestChangedFileConnection": {
      if (name === "nodes") return parent.__nodes as unknown[];
      if (name === "pageInfo") return parent.__pageInfo as unknown;
      if (name === "totalCount") return parent.__totalCount as number;
      return null;
    }
    case "PullRequestChangedFile": {
      const file = parent.__file as Record<string, unknown>;
      switch (name) {
        case "path":
          return file.filename as string;
        case "filename":
          return file.filename as string;
        case "status":
          return file.status as string;
        case "additions":
          return file.additions as number;
        case "deletions":
          return file.deletions as number;
        case "changes":
          return file.changes as number;
        default:
          return null;
      }
    }
    case "PageInfo": {
      switch (name) {
        case "hasNextPage":
          return parent.hasNextPage as boolean;
        case "hasPreviousPage":
          return parent.hasPreviousPage as boolean;
        case "startCursor":
          return parent.startCursor as string | null;
        case "endCursor":
          return parent.endCursor as string | null;
        default:
          return null;
      }
    }
    case "IssueComment": {
      const comment = parent.__comment as IssueComment;
      if (name === "id") return globalId("IssueComment", comment.id);
      if (name === "body") return comment.body;
      return null;
    }
    case "IssueCommentEdge": {
      if (name === "node") return parent.__node as unknown;
      if (name === "cursor") return parent.__cursor as string;
      return null;
    }
    case "CreateIssuePayload":
    case "CloseIssuePayload": {
      if (name === "issue") return parent.__issue as unknown;
      return null;
    }
    case "CreatePullRequestPayload":
    case "MergePullRequestPayload": {
      if (name === "pullRequest") return parent.__pull as unknown;
      return null;
    }
    case "AddCommentPayload": {
      if (name === "commentEdge") return parent.__edge as unknown;
      return null;
    }
    case "__Schema": {
      if (name === "queryType") return { __typename: "__Type", __typeName: "Query", __typeInfo: TYPE_INFO.Query };
      if (name === "mutationType") return { __typename: "__Type", __typeName: "Mutation", __typeInfo: TYPE_INFO.Mutation };
      if (name === "description") return null;
      if (name === "types") {
        return Object.keys(TYPE_INFO).map((typeName) => ({
          __typename: "__Type",
          __typeName: typeName,
          __typeInfo: TYPE_INFO[typeName],
        }));
      }
      return null;
    }
    case "__Type": {
      const typeName = parent.__typeName as string;
      const info = parent.__typeInfo as TypeInfo;
      switch (name) {
        case "name":
          return typeName;
        case "kind":
          return info.kind;
        case "description":
          return null;
        case "fields":
          return info.fields.map((fieldName) => ({
            __typename: "__Field",
            __fieldName: fieldName,
          }));
        case "enumValues":
          return info.enumValues.map((valueName) => ({
            __typename: "__EnumValue",
            __valueName: valueName,
          }));
        default:
          return null;
      }
    }
    case "__Field": {
      if (name === "name") return parent.__fieldName as string;
      if (name === "description") return null;
      if (name === "args") return [];
      if (name === "type") return null;
      return null;
    }
    case "__EnumValue": {
      if (name === "name") return parent.__valueName as string;
      if (name === "description") return null;
      return null;
    }
    default:
      return null;
  }
}

function inputOf(args: Record<string, unknown>): Record<string, unknown> {
  const input = args.input;
  return isObjectValue(input) ? (input as Record<string, unknown>) : {};
}

function resolveMutation(
  ctx: ExecContext,
  name: string,
  args: Record<string, unknown>,
): unknown {
  const input = inputOf(args);
  if (name === "createIssue") {
    const repo = resolveRepoByGlobalId(ctx, input.repositoryId);
    if (!repo) throw new HttpError(404, "Repository not found");
    const title = typeof input.title === "string" ? input.title : "";
    const body = typeof input.body === "string" ? input.body : "";
    const issue = createIssueRecord(ctx.store, repo, title, body, []);
    return { __typename: "CreateIssuePayload", __issue: issueValue(issue, repo) };
  }
  if (name === "closeIssue") {
    const found = resolveIssueByGlobalId(ctx, input.issueId);
    if (!found) throw new HttpError(404, "Issue not found");
    found.issue.state = "closed";
    return { __typename: "CloseIssuePayload", __issue: issueValue(found.issue, found.repo) };
  }
  if (name === "createPullRequest") {
    const repo = resolveRepoByGlobalId(ctx, input.repositoryId);
    if (!repo) throw new HttpError(404, "Repository not found");
    const base = typeof input.baseRefName === "string" ? input.baseRefName : repo.defaultBranch;
    const head = typeof input.headRefName === "string" ? input.headRefName : "";
    const title = typeof input.title === "string" ? input.title : "";
    const body = typeof input.body === "string" ? input.body : "";
    const pull = createPullRecord(ctx.store, repo, head, base, title, body);
    return { __typename: "CreatePullRequestPayload", __pull: pullValue(pull, repo) };
  }
  if (name === "mergePullRequest") {
    const found = resolvePullByGlobalId(ctx, input.pullRequestId);
    if (!found) throw new HttpError(404, "Pull request not found");
    squashMergeRecord(ctx.store, found.repo, found.pull);
    return { __typename: "MergePullRequestPayload", __pull: pullValue(found.pull, found.repo) };
  }
  if (name === "addComment") {
    const found = resolveIssueByGlobalId(ctx, input.subjectId);
    if (!found) throw new HttpError(404, "Issue not found");
    const body = typeof input.body === "string" ? input.body : "";
    const comment = addCommentRecord(ctx.store, found.repo, found.issue, body);
    return {
      __typename: "AddCommentPayload",
      __edge: {
        __typename: "IssueCommentEdge",
        __node: commentValue(comment),
        __cursor: cursorFor(0),
      },
    };
  }
  return null;
}

/** The runtime type of a value (for fragment type conditions). */
function runtimeType(parentType: string, value: RuntimeValue): string {
  if (parentType === "Node") return value.__typename as string;
  return parentType;
}

function executeSelections(
  ctx: ExecContext,
  parentType: string,
  parent: RuntimeValue,
  selections: SelectionNode[],
  path: (string | number)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === "spread") {
      if (!directivesAllow(selection.directives, ctx.variables)) continue;
      const fragment = ctx.fragments.get(selection.name);
      if (!fragment) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".`, path });
        continue;
      }
      if (fragment.typeCondition !== parentType && fragment.typeCondition !== runtimeType(parentType, parent)) {
        continue;
      }
      const inner = executeSelections(ctx, fragment.typeCondition, parent, fragment.selections, path);
      Object.assign(out, inner);
      continue;
    }
    if (selection.kind === "inline") {
      if (!directivesAllow(selection.directives, ctx.variables)) continue;
      const condition = selection.typeCondition;
      if (condition !== null && condition !== parentType && condition !== runtimeType(parentType, parent)) {
        continue;
      }
      const effectiveType = condition ?? parentType;
      const inner = executeSelections(ctx, effectiveType, parent, selection.selections, path);
      Object.assign(out, inner);
      continue;
    }
    // Field.
    if (!directivesAllow(selection.directives, ctx.variables)) continue;
    const responseKey = selection.alias ?? selection.name;
    const fieldPath = [...path, responseKey];
    const known = selection.name === "__typename" || (TYPE_INFO[parentType]?.fields.includes(selection.name) ?? false);
    if (!known) {
      ctx.errors.push({
        message: `Cannot query field "${selection.name}" on type "${parentType}".`,
        path: fieldPath,
      });
      out[responseKey] = null;
      continue;
    }
    const args = argsOf(selection, ctx.variables);
    let value: unknown;
    try {
      value = resolveField(ctx, parentType, parent, selection, args);
    } catch (err) {
      if (err instanceof HttpError) {
        ctx.errors.push({ message: err.message, path: fieldPath });
      } else {
        ctx.errors.push({ message: (err as Error).message ?? "internal error", path: fieldPath });
      }
      out[responseKey] = null;
      continue;
    }
    if (selection.selections === null || selection.selections.length === 0) {
      out[responseKey] = value;
      continue;
    }
    if (value === null || value === undefined) {
      out[responseKey] = null;
      continue;
    }
    const childType = FIELD_TYPES[parentType]?.[selection.name] ?? parentType;
    if (Array.isArray(value)) {
      out[responseKey] = value.map((item, index) =>
        isObjectValue(item)
          ? executeSelections(ctx, childType, item, selection.selections as SelectionNode[], [...fieldPath, index])
          : item,
      );
      continue;
    }
    if (isObjectValue(value)) {
      out[responseKey] = executeSelections(ctx, childType, value, selection.selections, fieldPath);
      continue;
    }
    out[responseKey] = value;
  }
  return out;
}

interface OperationResult {
  data: Record<string, unknown> | null;
  errors?: GraphQLError[];
}

function executeOperation(
  store: Store,
  doc: DocumentNode,
  variables: Variables,
  operationName: string | undefined,
): OperationResult {
  let operation: OperationNode | undefined;
  if (operationName !== undefined && operationName !== null) {
    operation = doc.operations.find((op) => op.name === operationName);
    if (!operation) {
      return {
        data: null,
        errors: [{ message: `Unknown operation named "${operationName}".` }],
      };
    }
  } else if (doc.operations.length === 1) {
    operation = doc.operations[0];
  } else if (doc.operations.length === 0) {
    return { data: null, errors: [{ message: "No operation in the document." }] };
  } else {
    return {
      data: null,
      errors: [{ message: "Must provide operation name if query contains multiple operations." }],
    };
  }
  const ctx: ExecContext = { store, fragments: doc.fragments, variables, errors: [] };
  const rootType = operation.operation === "mutation" ? "Mutation" : "Query";
  const root: RuntimeValue = { __typename: rootType };
  const data = executeSelections(ctx, rootType, root, operation.selections, []);
  const result: OperationResult = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

export async function handleGraphQL(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    requireAuth(req);
    const raw = (await readBody(req)).toString("utf8");
    let body: unknown;
    try {
      body = raw.trim() === "" ? null : JSON.parse(raw);
    } catch {
      sendJson(res, store, 400, { message: "Problems parsing JSON" });
      return;
    }
    if (Array.isArray(body)) {
      const results: OperationResult[] = [];
      for (const entry of body) {
        results.push(executeEntry(store, entry));
      }
      sendJson(res, store, 200, results);
      return;
    }
    if (typeof body !== "object" || body === null) {
      sendJson(res, store, 400, { message: "Problems parsing JSON" });
      return;
    }
    sendJson(res, store, 200, executeEntry(store, body as Record<string, unknown>));
  } catch (err) {
    if (err instanceof HttpError) {
      if (!res.headersSent) sendJson(res, store, err.status, { message: err.message });
      return;
    }
    throw err;
  }
}

function executeEntry(store: Store, entry: unknown): OperationResult {
  if (typeof entry !== "object" || entry === null) {
    return { data: null, errors: [{ message: "An operation must be a JSON object." }] };
  }
  const record = entry as Record<string, unknown>;
  const query = record.query;
  if (typeof query !== "string" || query === "") {
    return { data: null, errors: [{ message: "Must provide query string." }] };
  }
  const variables = (record.variables ?? {}) as Variables;
  const operationName =
    typeof record.operationName === "string" ? record.operationName : undefined;
  let doc: DocumentNode;
  try {
    doc = parseDocument(query);
  } catch (err) {
    return { data: null, errors: [{ message: (err as Error).message ?? "Syntax Error" }] };
  }
  return executeOperation(store, doc, variables, operationName);
}

import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type pg from "pg";
import type { RequestDatabaseCost } from "../request-timing.js";
import { DATABASE_CONTEXT_STATEMENTS } from "../db-context.js";
import { CENSUS_PROFILES } from "./load-budget-census.js";

export const IDLE_WINDOW_MS = 300_000;
export const LOAD_BUDGETS = [
  { phase: "R1", scenario: "idle", metric: "requests", baseline: 211, maximum: 30, expectedFailure: true },
  { phase: "R1", scenario: "idle", metric: "statements", baseline: 4425, maximum: 200, expectedFailure: true },
  { phase: "R1", scenario: "r1-fallback-idle", metric: "requests", baseline: 20, maximum: 30, expectedFailure: false },
  { phase: "R1", scenario: "r1-fallback-idle", metric: "statements", baseline: 441, maximum: 200, expectedFailure: true },
  { phase: "R1", scenario: "census-stopped", metric: "requests", baseline: 18, maximum: 6, expectedFailure: true },
  { phase: "R1", scenario: "census-stopped", metric: "statements", baseline: 377, maximum: 40, expectedFailure: true },
  { phase: "R1", scenario: "census-stopped", metric: "transactions", baseline: 49, maximum: 49, expectedFailure: false },
  { phase: "R1", scenario: "census-connected", metric: "requests", baseline: 41, maximum: 10, expectedFailure: true },
  { phase: "R1", scenario: "census-connected", metric: "statements", baseline: 1478, maximum: 40, expectedFailure: true },
  { phase: "R1", scenario: "census-connected", metric: "transactions", baseline: 199, maximum: 199, expectedFailure: false },
  { phase: "R2", scenario: "turn-lease", metric: "transactions", baseline: 9, maximum: 6, expectedFailure: true },
  { phase: "R2", scenario: "turn-path", metric: "transactions", baseline: 31, maximum: 20, expectedFailure: true },
  { phase: "R2", scenario: "renewal", metric: "transactions", baseline: 5, maximum: 2, expectedFailure: true },
  { phase: "R1", scenario: "workspace-list", metric: "transactions", baseline: 3, maximum: 3, expectedFailure: false },
  { phase: "R1", scenario: "cold-list", metric: "githubCalls", baseline: 0, maximum: 0, expectedFailure: false },
  { phase: "R1", scenario: "cold-open", metric: "githubCalls", baseline: 0, maximum: 0, expectedFailure: false },
  { phase: "R1", scenario: "cold-connect", metric: "githubCalls", baseline: 0, maximum: 0, expectedFailure: false },
  { phase: "R1", scenario: "cold-connect", metric: "transactions", baseline: 3, maximum: 3, expectedFailure: false },
  { phase: "R1", scenario: "cold-history", metric: "githubCalls", baseline: 0, maximum: 0, expectedFailure: false },
  { phase: "R1", scenario: "read-frame", metric: "workspaceUpdateLocks", baseline: 0, maximum: 0, expectedFailure: false },
  { phase: "R1", scenario: "read-frame", metric: "queries", baseline: 0, maximum: 0, expectedFailure: false },
  { phase: "R1", scenario: "read-frame", metric: "transactions", baseline: 0, maximum: 0, expectedFailure: false },
  { phase: "R2", scenario: "periodic-renewals", metric: "requests", baseline: 27, maximum: 0, expectedFailure: true },
  { phase: "R3", scenario: "running-stream", metric: "writeTransactions", baseline: 53, maximum: 30, expectedFailure: true },
  { phase: "R3", scenario: "running-stream", metric: "writeStatements", baseline: 106, maximum: 150, expectedFailure: false },
  { phase: "R3", scenario: "running-stream", metric: "maxWriteStatementsPerTransaction", baseline: 2, maximum: 5, expectedFailure: false },
  { phase: "R3", scenario: "running-stream", metric: "maxWriteTransactionsPer2s", baseline: 2, maximum: 1, expectedFailure: true },
  { phase: "R1", scenario: "clean-wake", metric: "requests", baseline: 1, maximum: 1, expectedFailure: false },
  { phase: "R1", scenario: "wake-replacements", metric: "requests", baseline: 0, maximum: 0, expectedFailure: false },
] as const;

// Startup, notification-driven presence, and teardown are bounded separately
// from periodic work. Periods are recorded ceilings, not imported timer values.
export const LOAD_BACKGROUND_BUDGETS = [
  { operation: "team-authority", initialCalls: 1, periodsMs: [60000], queries: 3, statements: 5, transactions: 1 },
  { operation: "team-presence", initialCalls: 2, periodsMs: [60000, 60000], queries: 5, statements: 7, transactions: 1 },
  { operation: "team-renew", initialCalls: 0, periodsMs: [60000], queries: 5, statements: 7, transactions: 1 },
  { operation: "team-close", initialCalls: 1, periodsMs: [], queries: 3, statements: 5, transactions: 1 },
  { operation: "device-snapshot", initialCalls: 1, periodsMs: [60000], queries: 4, statements: 6, transactions: 1 },
  { operation: "auth-read", initialCalls: 1, periodsMs: [60000], queries: 4, statements: 6, transactions: 1 },
  { operation: "auth-publish", initialCalls: 1, periodsMs: [60000], queries: 5, statements: 7, transactions: 1 },
] as const;
type BackgroundName = typeof LOAD_BACKGROUND_BUDGETS[number]["operation"];
type BackgroundOperation = { name: BackgroundName; cost: SqlCost; open: boolean };
export type BackgroundDefinition = { operation: string; initialCalls: number; periodsMs: readonly number[]; queries: number; statements: number; transactions: number };
export const idleScenario = (name: string) => name === "idle" || name === "r1-fallback-idle" || CENSUS_PROFILES.some(profile => profile.name === name);

export function backgroundLimitFor(scenario: string, limit: BackgroundDefinition): BackgroundDefinition {
  const profile = CENSUS_PROFILES.find(value => value.name === scenario);
  const operation = limit.operation.startsWith("team-") ? "workspaceEvents" : limit.operation === "device-snapshot" ? "deviceEvents" : "authEvents";
  const opens = profile ? profile.routes.find(row => row.operation === operation)?.requests ?? 0
    : limit.operation.startsWith("auth-") ? 0 : 1;
  // Reconnects are sequential: startup/teardown repeat, but their timer
  // windows do not overlap. A profile with no stream permits no stream SQL.
  return { ...limit, initialCalls: limit.initialCalls * opens, periodsMs: opens ? limit.periodsMs : [],
    queries: opens ? limit.queries : 0, statements: opens ? limit.statements : 0, transactions: opens ? limit.transactions : 0 };
}

export type SqlCost = { queries: number; statements: number; transactions: number; commits: number; rollbacks: number;
  failures: number; inFlight: number; injectedDelayMs: number; writeTransactions: number; writeStatements: number;
  rowMutations: number; maxWriteStatementsPerTransaction: number; censusQueries: number; writeTransactionTimes: number[];
  githubCalls: number; workspaceUpdateLocks: number };
export type LoadRequest = SqlCost & { method: string; route: string; status: number; simulatedAtMs: number; elapsedMs: number;
  open: boolean; streaming: boolean; observer?: RequestDatabaseCost };
export type LoadScenario = { name: string; requests: LoadRequest[]; background: SqlCost; backgroundOperations: BackgroundOperation[];
  elapsedMs: number; writesObserved: boolean; locksObserved: boolean };
const emptySql = (): SqlCost => ({ queries: 0, statements: 0, transactions: 0, commits: 0, rollbacks: 0, failures: 0, inFlight: 0, injectedDelayMs: 0,
  writeTransactions: 0, writeStatements: 0, rowMutations: 0, maxWriteStatementsPerTransaction: 0, censusQueries: 0, writeTransactionTimes: [],
  githubCalls: 0, workspaceUpdateLocks: 0 });
const additiveSql = ["queries", "statements", "transactions", "commits", "rollbacks", "failures", "inFlight", "injectedDelayMs",
  "writeTransactions", "writeStatements", "rowMutations", "censusQueries", "githubCalls", "workspaceUpdateLocks"] as const;

// Completion tags cannot distinguish SELECT from SELECT FOR UPDATE. Discard
// literals/comments first, then match the lock's own SELECT scope and OF list.
export function workspaceUpdateLocks(sql: unknown): number {
  if (typeof sql !== "string") throw new Error("Load lock observation needs SQL text");
  const tokens: Array<{ word: string; quoted: boolean; scope: number; statement: number }> = [];
  const parents = [-1];
  let at = 0, scope = 0, statement = 0;
  const incomplete = () => { throw new Error("Load lock observation found incomplete SQL"); };
  while (at < sql.length) {
    if (/\s/.test(sql[at]!)) { at++; continue; }
    if (sql.startsWith("--", at)) { const end = sql.indexOf("\n", at); at = end < 0 ? sql.length : end; continue; }
    if (sql.startsWith("/*", at)) {
      let comments = 1; at += 2;
      while (comments && at < sql.length) {
        if (sql.startsWith("/*", at)) { comments++; at += 2; }
        else if (sql.startsWith("*/", at)) { comments--; at += 2; } else at++;
      }
      if (comments) incomplete();
      continue;
    }
    const dollar = /^\$(?:[a-z_][a-z_0-9]*)?\$/i.exec(sql.slice(at))?.[0];
    if (dollar) {
      const end = sql.indexOf(dollar, at + dollar.length);
      if (end < 0) incomplete();
      at = end + dollar.length; continue;
    }
    const quote = sql[at];
    if (quote === "'" || quote === '"') {
      const escaped = quote === "'" && /(?:^|\W)e$/i.test(sql.slice(0, at));
      let word = "", ended = false; at++;
      while (at < sql.length) {
        const value = sql[at++]!;
        if (value === quote) {
          if (sql[at] === quote) { word += quote; at++; }
          else { ended = true; break; }
        } else if (escaped && value === "\\") at++;
        else word += value;
      }
      if (!ended) incomplete();
      if (quote === '"') tokens.push({ word, quoted: true, scope, statement });
      continue;
    }
    if (sql[at] === "(") { parents.push(scope); scope = parents.length - 1; at++; continue; }
    if (sql[at] === ")") { if (scope === 0) incomplete(); scope = parents[scope]!; at++; continue; }
    if (sql[at] === ";") { statement++; at++; continue; }
    const word = /^[a-z_][a-z_0-9$]*/i.exec(sql.slice(at))?.[0] ?? sql[at]!;
    tokens.push({ word: word.toLowerCase(), quoted: false, scope, statement }); at += word.length;
  }
  if (scope) incomplete();
  type Query = { statement: number; tokens: typeof tokens; children: Array<{ query: Query; at: number }> };
  const queries: Query[] = [], current = new Map<string, Query>();
  const enclosing = (statement: number, scope: number): Query | undefined => {
    for (let parent = scope; parent >= 0; parent = parents[parent]!) {
      const query = current.get(`${statement}:${parent}`);
      if (query) return query;
    }
    return undefined;
  };
  const endFrom = new Set(["where", "group", "having", "order", "limit", "offset", "for", "union", "intersect", "except"]);
  for (const token of tokens) {
    const key = `${token.statement}:${token.scope}`;
    if (token.word === "select" && !token.quoted) {
      const query: Query = { statement: token.statement, tokens: [], children: [] };
      const parent = enclosing(token.statement, parents[token.scope]!);
      if (parent) {
        const last = parent.tokens.at(-1), boundary = parent.tokens.findLast(value => !value.quoted && (value.word === "from" || endFrom.has(value.word)));
        if (last && !last.quoted && (["from", "join", "lateral"].includes(last.word) || last.word === "," && boundary?.word === "from"))
          parent.children.push({ query, at: parent.tokens.length });
      }
      queries.push(query); current.set(key, query);
    }
    enclosing(token.statement, token.scope)?.tokens.push(token);
  }
  const aliasesOf = (query: Query): Set<string> => {
    const words = query.tokens, aliases = new Set<string>();
    const keyword = (i: number, word: string) => words[i]?.word === word && !words[i]?.quoted;
    let inFrom = false;
    for (let i = 0; i < words.length; i++) {
      if (keyword(i, "from")) inFrom = true;
      if (!words[i]!.quoted && endFrom.has(words[i]!.word)) inFrom = false;
      if (!(keyword(i, "from") || keyword(i, "join") || inFrom && keyword(i, ","))) continue;
      let table = i + 1;
      if (keyword(table, "only")) table++;
      while (words[table + 1]?.word === ".") table += 2;
      if (words[table]?.word !== "cloud_v2_workspaces") continue;
      aliases.add("cloud_v2_workspaces");
      const next = words[table + 1];
      if (keyword(table + 1, "as")) { if (words[table + 2]) aliases.add(words[table + 2]!.word); }
      else if (next && (next.quoted || /^[a-z_]/.test(next.word) && !["where", "join", "inner", "left", "right", "full", "cross", "order", "limit", "offset", "for", "group", "having", "on", "union"].includes(next.word))) aliases.add(next.word);
    }
    for (const child of query.children) if (aliasesOf(child.query).size) {
      const alias = words[child.at + Number(keyword(child.at, "as"))];
      aliases.add(alias && (alias.quoted || !endFrom.has(alias.word)) ? alias.word : "<subquery>");
    }
    return aliases;
  };
  const locked = new Set<number>();
  for (const query of queries) {
    const words = query.tokens, aliases = aliasesOf(query);
    const keyword = (i: number, word: string) => words[i]?.word === word && !words[i]?.quoted;
    if (!aliases.size) continue;
    for (let i = 0; i < words.length; i++) {
      if (!keyword(i, "for")) continue;
      let lock = i + 1;
      if (keyword(lock, "no") && keyword(lock + 1, "key")) lock += 2;
      if (!keyword(lock, "update")) continue;
      if (!keyword(lock + 1, "of")) { locked.add(query.statement); continue; }
      for (let name = lock + 2; name < words.length; name += 2) {
        if (aliases.has(words[name]!.word)) locked.add(query.statement);
        if (words[name + 1]?.word !== ",") break;
      }
    }
  }
  return locked.size;
}
type Port = (this: unknown, ...args: unknown[]) => unknown;
type WriteTransaction = { writes: number; mutations: number; startedAt: number };
type CensusRow = { mutations: string; deferred_triggers: boolean };
const censusSql = `SELECT coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0)::text AS mutations,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgdeferrable AND NOT tgisinternal) AS deferred_triggers
  FROM pg_stat_xact_user_tables`;
function readCensus(result: pg.QueryResult<CensusRow>): number {
  if (result.rows[0]?.deferred_triggers) throw new Error("Load write census cannot observe deferred trigger writes");
  const mutations = Number(result.rows[0]?.mutations);
  if (!Number.isSafeInteger(mutations) || mutations < 0) throw new Error("Load write census unavailable");
  return mutations;
}

const templates = [
  "/v2/cloud/worker/hello", "/v2/cloud/worker/bootstrap-lease",
  "/auth/browser/session", "/v1/me", "/v1/auth/snapshot", "/v1/auth/events", "/v1/cloud-v2/workspaces",
  "/v1/cloud-v2/workspaces/:id", "/v1/cloud-v2/workspaces/:id/events", "/v1/cloud-v2/workspaces/:id/prompts",
  "/v1/cloud-v2/workspaces/:id/connect", "/v1/cloud-v2/workspaces/:id/history", "/v1/cloud-v2/workspaces/:id/activity",
  "/v1/cloud-v2/workspaces/:id/github", "/v1/cloud-v2/workspaces/:id/start",
  "/v1/cloud-v2/devices/:deviceId/connections", "/v1/cloud-v2/devices/:deviceId/events", "/v1/cloud-v2/devices/:deviceId/heartbeat",
  "/v2/cloud/worker/prompts/pull", "/v2/cloud/worker/prompts/ack", "/v2/cloud/worker/prompts/begin",
  "/v2/cloud/worker/turn-lease", "/v2/cloud/worker/execution-leases/renew", "/v2/cloud/worker/history", "/v2/cloud/worker/activity",
  "/v2/cloud/worker/history/digests",
  "/v2/cloud/worker/prompts/outcome", "/v2/cloud/worker/execution-leases/:id/retired",
  "/_load-budget/:id",
];
function routeTemplate(path: string): string {
  const template = templates.find(value => new RegExp(`^${value.replace(/:[A-Za-z]+/g, "[^/]+")}$`).test(path));
  if (!template) throw new Error("Load replay reached an unregistered route");
  return template;
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

export async function holdLoadStream(body: ReadableStream<Uint8Array>, abort: AbortController, serverClosed: Promise<void> = Promise.resolve()) {
  const reader = body.getReader(), ready = deferred<void>();
  const ownAbort = (error: unknown) => abort.signal.aborted && error instanceof Error && error.name === "AbortError";
  const cancel = async () => {
    abort.abort();
    try { await reader.cancel(); }
    catch (error) { if (!ownAbort(error)) throw error; }
  };
  let found = false;
  const done = (async () => {
    const decoder = new TextDecoder(); let pending = "";
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        pending = (pending + decoder.decode(chunk.value, { stream: true })).slice(-8192);
        if (pending.includes("event: revoked")) throw new Error("Load fixture: event stream revoked");
        if (!found && pending.includes("event: ready")) { found = true; ready.resolve(); }
      }
      if (!found) throw new Error("Load fixture: stream ended before ready");
      if (!abort.signal.aborted) throw new Error("Load fixture: event stream ended during replay");
    } catch (error) { ready.reject(error); if (!ownAbort(error)) throw error; }
  })();
  void done.catch(() => {});
  const timer = setTimeout(() => ready.reject(new Error("Load fixture: stream readiness timed out")), 10_000);
  try { await ready.promise; }
  catch (error) { await cancel().catch(() => {}); await done.catch(() => {}); throw error; }
  finally { clearTimeout(timer); }
  return { done, stop: async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const results = await Promise.allSettled([
        (async () => { await cancel(); await done; })(),
        Promise.race([serverClosed, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Load fixture: server stream cleanup timed out")), 10_000);
        })]),
      ]);
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    } finally { clearTimeout(timer); }
  } };
}

/** The lower pg port observes detached stream/background work too. Completion
 * tags count batches without parsing SQL, retaining parameters, or counting
 * pool.query and its checked-out client twice. */
export class LoadBudgetProbe {
  private readonly scope = new AsyncLocalStorage<LoadRequest | undefined>();
  private readonly backgroundScope = new AsyncLocalStorage<BackgroundOperation | undefined>();
  private active: LoadScenario | undefined;
  private simulatedAtMs = 0;
  private readonly restore: Array<() => void> = [];
  private readonly attach: (client: pg.PoolClient) => void;
  private statementDelayMs = 0;
  private writeCensusError: Error | undefined;
  private lockObservationError: Error | undefined;
  private routeObservationError: Error | undefined;

  constructor(private readonly pool: pg.Pool) {
    this.attach = client => this.wrapClient(client);
    pool.on("connect", this.attach);
    const original = pool.connect;
    const scopes = this.scope, backgrounds = this.backgroundScope;
    pool.connect = function (this: unknown, ...args: unknown[]) {
      const owner = scopes.getStore(), operation = backgrounds.getStore(), callback = args.at(-1);
      // pg-pool can invoke a checkout callback on a socket born in an older
      // request. Re-enter the submitting scope before pool.query calls query.
      if (typeof callback === "function") args[args.length - 1] = function (this: unknown, ...values: unknown[]) {
        return backgrounds.run(operation, () => scopes.run(owner, () => Reflect.apply(callback, this, values)));
      };
      return Reflect.apply(original, this, args);
    } as typeof pool.connect;
    this.restore.push(() => { pool.connect = original; });
  }

  setDelay(milliseconds: number): void {
    if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > 1_000) throw new Error("Invalid statement delay");
    this.statementDelayMs = milliseconds;
  }

  readonly observe = (cost: RequestDatabaseCost): void => {
    const request = this.scope.getStore();
    if (request?.open) request.observer = cost;
  };

  githubRequest<T>(send: () => Promise<T>): Promise<T> {
    const owner = this.scope.getStore(), operation = this.backgroundScope.getStore();
    const cost = owner?.open ? owner : operation?.open ? operation.cost : this.active?.background;
    if (cost) cost.githubCalls++;
    return send();
  }

  async backgroundOperation<T>(name: BackgroundName, work: () => Promise<T>, route?: string): Promise<T> {
    const scenario = this.active, request = this.scope.getStore();
    if (!scenario || !request?.streaming || route && request.route !== route || this.backgroundScope.getStore()?.open) return work();
    const beganBeforeHeaders = request.open;
    const operation: BackgroundOperation = { name, cost: emptySql(), open: true };
    scenario.backgroundOperations.push(operation);
    try { return await this.backgroundScope.run(operation, work); }
    finally {
      operation.open = false;
      if (beganBeforeHeaders && additiveSql.every(key => operation.cost[key] === 0))
        scenario.backgroundOperations.splice(scenario.backgroundOperations.indexOf(operation), 1);
      for (const key of additiveSql) scenario.background[key] += operation.cost[key];
      scenario.background.maxWriteStatementsPerTransaction = Math.max(scenario.background.maxWriteStatementsPerTransaction, operation.cost.maxWriteStatementsPerTransaction);
      scenario.background.writeTransactionTimes.push(...operation.cost.writeTransactionTimes);
    }
  }

  private wrapClient(client: pg.PoolClient): void {
    const original = client.query as Port;
    let transaction: WriteTransaction | undefined;
    let censusQueue = Promise.resolve<unknown>(undefined);
    const censusFailed = (error: unknown) => {
      if (error instanceof Error && error.message.startsWith("Load write census")) this.writeCensusError ??= error;
    };
    const lockFailed = (error: unknown) => { this.lockObservationError ??= error as Error; };
    const capture = () => {
      const owner = this.scope.getStore(), operation = this.backgroundScope.getStore();
      return { owner, cost: owner?.open ? owner : operation?.open ? operation.cost : this.active?.background, statementDelayMs: this.statementDelayMs,
        writes: this.active?.writesObserved, locks: this.active?.locksObserved };
    };
    const scopes = this.scope;
    client.query = function (this: unknown, ...args: unknown[]): unknown {
      const { owner, cost, statementDelayMs, writes, locks } = capture();
      if (!cost) return Reflect.apply(original, this, args);
      cost.queries++; cost.inFlight++;
      const parts = writes && typeof args[0] === "string" ? args[0].split(";").map(part => part.trim()) : [];
      const accountWrites = (commands: unknown[], mutations: number, current: WriteTransaction) => {
        if (commands.some(command => !["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE", "SET", "RESET", "LISTEN", "UNLISTEN"].includes(String(command))))
          throw new Error("Load write census found an unsupported command");
        const changed = mutations - current.mutations;
        if (changed < 0) throw new Error("Load write census unavailable");
        const direct = commands.filter(command => ["INSERT", "UPDATE", "DELETE", "MERGE"].includes(String(command))).length;
        const selected = commands.filter(command => command === "SELECT").length;
        if (changed && selected && (direct || selected > 1)) throw new Error("Load write census cannot attribute a mixed batch");
        const count = direct || (changed && selected === 1 ? 1 : 0);
        if (changed && !count) throw new Error("Load write census found an unsupported mutation");
        if (count && current.writes === 0) { cost.writeTransactions++; cost.writeTransactionTimes.push(current.startedAt); }
        current.writes += count; current.mutations = mutations;
        cost.writeStatements += count; cost.rowMutations += changed;
        cost.maxWriteStatementsPerTransaction = Math.max(cost.maxWriteStatementsPerTransaction, current.writes);
      };
      const settled = async (error: unknown, result?: unknown, batch?: { before: number; after: number; startedAt: number }) => {
        try {
          if (error) { cost.failures++; censusFailed(error); return; }
          const commands = (Array.isArray(result) ? result : [result]).map(value =>
            value && typeof value === "object" && "command" in value ? value.command : undefined);
          if (!commands.length || commands.some(command => typeof command !== "string" || !/^[A-Z ]+$/.test(command))) {
            cost.failures++; return;
          }
          cost.statements += commands.length;
          cost.transactions += commands.filter(command => command === "BEGIN").length;
          cost.commits += commands.filter(command => command === "COMMIT").length;
          cost.rollbacks += commands.filter(command => command === "ROLLBACK").length;
          if (locks) {
            try { cost.workspaceUpdateLocks += workspaceUpdateLocks(typeof args[0] === "string" ? args[0]
              : args[0] && typeof args[0] === "object" && "text" in args[0] ? args[0].text : undefined); }
            catch (error) { lockFailed(error); throw error; }
          }
          if (writes) {
            const starts = commands.includes("BEGIN"), ends = commands.includes("COMMIT") || commands.includes("ROLLBACK");
            if (starts && (transaction || ends && !batch)) throw new Error("Load write census needs separate transaction boundaries");
            if (starts && !batch && !(parts.length <= 3 && /^BEGIN(?: ISOLATION LEVEL (?:SERIALIZABLE|REPEATABLE READ|READ COMMITTED))?(?: READ ONLY)?$/i.test(parts[0] ?? "") &&
              (parts.length === 1 || parts[1] === "SET LOCAL ROLE zeros_app") && (parts.length < 3 || DATABASE_CONTEXT_STATEMENTS.has(parts[2]!))))
              throw new Error("Load write census found an unsupported transaction batch");
            if (ends && !batch && (parts.length !== 1 || !/^(COMMIT|ROLLBACK)$/i.test(parts[0] ?? "")))
              throw new Error("Load write census needs separate transaction boundaries");
            if (batch) {
              accountWrites(commands.slice(3, 4), batch.after, { writes: 0, mutations: batch.before, startedAt: batch.startedAt });
            } else if (starts) transaction = { writes: 0, mutations: 0, startedAt: performance.now() };
            if (ends) transaction = undefined;
            else if (transaction) {
              // Read this backend's uncommitted tuple counters below both query
              // observers. These diagnostic reads are reported separately.
              cost.censusQueries++;
              const mutations = readCensus(await Reflect.apply(original, client, [censusSql]) as pg.QueryResult<CensusRow>);
              if (starts) transaction.mutations = mutations;
              else accountWrites(commands, mutations, transaction);
            } else if (!commands.every(command => ["LISTEN", "UNLISTEN", "SET", "RESET"].includes(String(command)))) {
              throw new Error("Load write census needs an explicit transaction");
            }
          }
          // Delay delivery of each completed command, including BEGIN/SET/
          // COMMIT in one simple-protocol batch. Database clocks stay real.
          const waitMs = statementDelayMs * commands.length;
          cost.injectedDelayMs += waitMs;
          if (waitMs) await delay(waitMs);
        } catch (error) { cost.failures++; censusFailed(error); throw error; }
        finally { cost.inFlight--; }
      };
      const callback = args.at(-1);
      if (writes) {
        // A caller can queue its next command before our census is queued.
        // Keep each command and its census together on this checked-out client.
        const input = typeof callback === "function" ? args.slice(0, -1) : args;
        const operation = censusQueue.then(() => {
          try {
            // withSystemStatement permits no semicolons in its one statement.
            // Census inside that exact batch preserves its atomic round trip.
            const unbound = input.length === 1 || input.length === 2 && input[1] === undefined;
            const batch = unbound && parts.length === 5 && parts[0] === "BEGIN" && parts[1] === "SET LOCAL ROLE zeros_app" &&
              DATABASE_CONTEXT_STATEMENTS.has(parts[2]!) && parts[4] === "COMMIT";
            const startedAt = performance.now();
            if (batch) cost.censusQueries += 2;
            const sent = batch ? [[...parts.slice(0, 3), censusSql, parts[3], censusSql, parts[4]].join("\n; ")] : input;
            return Promise.resolve(Reflect.apply(original, this, sent)).then(async result => {
              let observed: { before: number; after: number; startedAt: number } | undefined;
              if (batch) {
                try {
                  if (!Array.isArray(result) || result.length !== 7) throw new Error("Load write census batch unavailable");
                  observed = { before: readCensus(result[3]), after: readCensus(result[5]), startedAt };
                  result = [result[0], result[1], result[2], result[4], result[6]];
                } catch (error) { await settled(error); throw error; }
              }
              await settled(undefined, result, observed);
              return result;
            }, async error => { await settled(error); throw error; });
          } catch (error) { void settled(error); throw error; }
        });
        censusQueue = operation.catch(() => {});
        if (typeof callback !== "function") return operation;
        void operation.then(result => scopes.run(owner, () => Reflect.apply(callback, this, [null, result])),
          error => scopes.run(owner, () => Reflect.apply(callback, this, [error])));
        return;
      }
      if (typeof callback === "function") {
        args[args.length - 1] = function (this: unknown, ...values: unknown[]) {
          void settled(values[0], values[1]).then(() => scopes.run(owner, () => Reflect.apply(callback, this, values)),
            error => scopes.run(owner, () => Reflect.apply(callback, this, [error])));
        };
        try { return Reflect.apply(original, this, args); }
        catch (error) { void settled(error); throw error; }
      }
      try {
        return Promise.resolve(Reflect.apply(original, this, args)).then(async result => {
          await settled(undefined, result); return result;
        }, async error => { await settled(error); throw error; });
      } catch (error) { void settled(error); throw error; }
    } as typeof client.query;
    this.restore.push(() => { client.query = original as typeof client.query; });
  }

  async request(request: Request, send: () => Response | Promise<Response>, validateResponse = true): Promise<Response> {
    if (!this.active) return send();
    let route: string;
    try { route = routeTemplate(new URL(request.url).pathname); }
    catch (error) { this.routeObservationError ??= error as Error; throw error; }
    const entry: LoadRequest = { ...emptySql(), method: request.method, route, status: 0, simulatedAtMs: this.simulatedAtMs,
      elapsedMs: 0, open: true, streaming: route.endsWith("/events") };
    this.active.requests.push(entry);
    const started = performance.now();
    return this.scope.run(entry, async () => {
      try {
        const response = await send();
        entry.status = response.status;
        if (!response.ok && validateResponse) {
          await response.body?.cancel();
          throw new Error(`Load replay failed: ${entry.method} ${route} (${response.status})`);
        }
        return response;
      } finally { entry.open = false; entry.elapsedMs = performance.now() - started; }
    });
  }

  async measure<T>(name: string, work: () => Promise<T>, options: { writes?: boolean; locks?: boolean } = {}): Promise<{ value: T; cost: LoadScenario }> {
    if (this.active) throw new Error("Load scenarios must not overlap");
    const cost: LoadScenario = { name, requests: [], background: emptySql(), backgroundOperations: [], elapsedMs: 0,
      writesObserved: options.writes === true, locksObserved: options.locks === true };
    this.active = cost; this.writeCensusError = undefined; this.lockObservationError = undefined; this.routeObservationError = undefined;
    const started = performance.now();
    try {
      const value = await work(); await this.drain(cost);
      if (this.writeCensusError) throw this.writeCensusError;
      if (this.lockObservationError) throw this.lockObservationError;
      if (this.routeObservationError) throw this.routeObservationError;
      if (cost.requests.some(request => request.status < 200 || request.status >= 300)) throw new Error("Load replay included an unsuccessful request");
      return { value, cost };
    }
    catch (error) { throw this.routeObservationError ?? this.writeCensusError ?? error; }
    finally { cost.elapsedMs = performance.now() - started; this.active = undefined; this.simulatedAtMs = 0; }
  }

  async at<T>(milliseconds: number, work: () => Promise<T>): Promise<T> {
    this.simulatedAtMs = milliseconds;
    return work();
  }

  private async drain(cost: LoadScenario): Promise<void> {
    await delay(0);
    for (let attempt = 0; attempt < 500; attempt++) {
      if (!cost.backgroundOperations.some(operation => operation.open) &&
          cost.background.inFlight + cost.requests.reduce((sum, request) => sum + request.inFlight, 0) === 0) return;
      await delay(10);
    }
    throw new Error("Load observation ended with SQL in flight");
  }

  close(): void {
    this.pool.off("connect", this.attach);
    for (const restore of this.restore.reverse()) restore();
  }
}

export function selectLoadRequests(cost: LoadScenario, predicate: (request: LoadRequest) => boolean): LoadScenario {
  return { ...cost, requests: cost.requests.filter(predicate), background: emptySql(), backgroundOperations: [] };
}

export function scenarioTotals(cost: LoadScenario): SqlCost & { requests: number; maxWriteTransactionsPer2s: number } {
  const total = { ...cost.background, writeTransactionTimes: [...cost.background.writeTransactionTimes], requests: cost.requests.length };
  for (const request of cost.requests) {
    for (const key of additiveSql) total[key] += request[key];
    total.maxWriteStatementsPerTransaction = Math.max(total.maxWriteStatementsPerTransaction, request.maxWriteStatementsPerTransaction);
    total.writeTransactionTimes.push(...request.writeTransactionTimes);
  }
  const times = total.writeTransactionTimes.sort((a, b) => a - b);
  let maxWriteTransactionsPer2s = 0, first = 0;
  for (let last = 0; last < times.length; last++) {
    while (times[last]! - times[first]! >= 2000) first++;
    maxWriteTransactionsPer2s = Math.max(maxWriteTransactionsPer2s, last - first + 1);
  }
  return { ...total, maxWriteTransactionsPer2s };
}

export function budgetTable(scenarios: ReadonlyMap<string, LoadScenario>) {
  return LOAD_BUDGETS.map(budget => {
    const cost = scenarios.get(budget.scenario);
    if (!cost) throw new Error(`Missing load scenario: ${budget.scenario}`);
    if (budget.scenario === "running-stream" && !cost.writesObserved) throw new Error("Missing write census");
    if (budget.metric === "workspaceUpdateLocks" && !cost.locksObserved) throw new Error("Missing lock observation");
    const total = scenarioTotals(cost);
    if (total.failures || total.inFlight) throw new Error(`Incomplete SQL observation: ${budget.scenario}`);
    const observed = (idleScenario(budget.scenario) ? scenarioTotals(selectLoadRequests(cost, () => true)) : total)[budget.metric];
    const targetObserved = idleScenario(budget.scenario) && budget.metric !== "statements" ? observed : total[budget.metric];
    return { ...budget, observed, ratchet: observed <= budget.baseline ? "PASS" : "FAIL",
      targetObserved, result: targetObserved <= budget.maximum ? "PASS" : "FAIL" };
  });
}

export function backgroundBudgetTable(scenarios: ReadonlyMap<string, LoadScenario>, limits: readonly BackgroundDefinition[] = LOAD_BACKGROUND_BUDGETS) {
  const rows: Array<{ scenario: string; operation: string; metric: string; observed: number; baseline: number; ratchet: "PASS" | "FAIL" }> = [];
  const add = (scenario: string, operation: string, metric: string, observed: number, baseline: number) =>
    rows.push({ scenario, operation, metric, observed, baseline, ratchet: observed <= baseline ? "PASS" : "FAIL" });
  for (const [name, cost] of scenarios) {
    if (!idleScenario(name)) continue;
    if (!Number.isFinite(cost.elapsedMs) || cost.elapsedMs < 0 || cost.backgroundOperations.some(operation => operation.open))
      throw new Error(`Incomplete background observation: ${name}`);
    for (const definition of limits) {
      const limit = backgroundLimitFor(name, definition);
      const operations = cost.backgroundOperations.filter(operation => operation.name === limit.operation);
      const ticks = limit.periodsMs.reduce((sum, period) => sum + Math.floor(cost.elapsedMs / period), 0);
      add(name, limit.operation, "calls", operations.length, limit.initialCalls + ticks);
      for (const metric of ["queries", "statements", "transactions"] as const)
        add(name, limit.operation, `${metric}PerCall`, Math.max(0, ...operations.map(operation => operation.cost[metric])), limit[metric]);
    }
    for (const metric of ["queries", "statements", "transactions", "githubCalls", "failures", "inFlight"] as const) {
      const known = cost.backgroundOperations.filter(operation => limits.some(limit => limit.operation === operation.name))
        .reduce((sum, operation) => sum + operation.cost[metric], 0);
      if (known > cost.background[metric]) throw new Error(`Overcounted background observation: ${name}`);
      add(name, "unattributed", metric, cost.background[metric] - known, 0);
    }
  }
  return rows;
}

export function routeTable(cost: LoadScenario) {
  const groups = new Map<string, { method: string; route: string; status: number; requests: number; queries: number; statements: number;
    transactions: number; maxStatementsPerRequest: number; maxTransactionsPerRequest: number; githubCalls: number; workspaceUpdateLocks: number;
    writeTransactions: number; writeStatements: number; rowMutations: number; maxWriteStatementsPerTransaction: number; censusQueries: number }>();
  for (const request of cost.requests) {
    const key = `${request.method} ${request.route} ${request.status}`;
    const row = groups.get(key) ?? { method: request.method, route: request.route, status: request.status, requests: 0, queries: 0,
      statements: 0, transactions: 0, maxStatementsPerRequest: 0, maxTransactionsPerRequest: 0, githubCalls: 0, workspaceUpdateLocks: 0,
      writeTransactions: 0, writeStatements: 0, rowMutations: 0, maxWriteStatementsPerTransaction: 0, censusQueries: 0 };
    row.requests++; row.queries += request.queries; row.statements += request.statements; row.transactions += request.transactions;
    row.maxStatementsPerRequest = Math.max(row.maxStatementsPerRequest, request.statements);
    row.maxTransactionsPerRequest = Math.max(row.maxTransactionsPerRequest, request.transactions);
    row.githubCalls += request.githubCalls; row.workspaceUpdateLocks += request.workspaceUpdateLocks;
    row.writeTransactions += request.writeTransactions; row.writeStatements += request.writeStatements;
    row.rowMutations += request.rowMutations; row.censusQueries += request.censusQueries;
    row.maxWriteStatementsPerTransaction = Math.max(row.maxWriteStatementsPerTransaction, request.maxWriteStatementsPerTransaction);
    groups.set(key, row);
  }
  return [...groups.values()].sort((left, right) => `${left.method} ${left.route}`.localeCompare(`${right.method} ${right.route}`)).map(row => {
    const { writeTransactions, writeStatements, rowMutations, maxWriteStatementsPerTransaction, censusQueries, ...ordinary } = row;
    return { ...ordinary, ...(cost.writesObserved ? { writeTransactions, writeStatements, rowMutations, maxWriteStatementsPerTransaction, censusQueries } : {}) };
  });
}

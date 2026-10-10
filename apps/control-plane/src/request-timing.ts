import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { isPromise } from "node:util/types";
import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

export const DEFAULT_SLOW_REQUEST_LOG_MS = 1000;

// Standalone mirror of protocol/cloud-events. The control plane deploys
// independently; only tests import the shared wire module for parity checks.
const originUuid = z.string().regex(/^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/);
const originIdentity = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const requestOriginSchema = z.object({
  version: z.literal(1), organizationId: originUuid, workspaceId: originUuid,
  generation: z.number().int().positive().safe(), engineInstanceId: originUuid,
  mode: z.enum(["legacy", "boot-owner-v1"]), bootId: originUuid.nullable(), writerEpoch: originUuid.nullable(),
  clockId: originUuid, spanId: originUuid, flightId: originUuid.nullable(), producer: z.enum(["foreground", "background", "unknown"]),
  operation: z.enum(["commands.mutate", "commands.snapshot", "commands.read", "commands.conversation", "commands.claim", "commands.stop",
    "commands.settle", "commands.confirm-goal", "commands.mirror", "credentials.admit", "credentials.validate",
    "credentials.refresh-codex", "actors.confirm", "actors.renew", "boot.credentials", "boot.refresh", "boot.activate",
    "events.append", "events.replay", "records.sync", "controls.exchange"]),
  intent: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("command"), commandId: originUuid, conversationId: originIdentity,
      turnId: originIdentity, executionId: originIdentity.nullable() }).strict(),
    z.object({ kind: z.literal("claim"), claimId: originUuid.nullable(), conversationId: originIdentity,
      executionId: originIdentity }).strict(),
    z.object({ kind: z.literal("none") }).strict(),
  ]),
}).strict().refine(value => value.mode === "legacy" ? value.bootId === null && value.writerEpoch === null :
  value.bootId !== null && value.writerEpoch !== null);
export type VerifiedEngineRequestOrigin = Omit<z.infer<typeof requestOriginSchema>, "version" | "clockId" | "spanId" | "flightId" | "producer">;
type RequestOrigin = Readonly<z.infer<typeof requestOriginSchema>>;
let requestCostClockDomainId: string | undefined;
function clockUs(): number | null {
  try {
    const time = process.hrtime.bigint();
    if (typeof time !== "bigint") return null;
    const value = Number(time / 1000n);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch { return null; }
}

type RequestTimingState = { transactions: number; heldMs: number; waitMs: number; closed: boolean; cost?: DatabaseCostState };

/** Application-issued queries only. Encoded producer payload bytes are not
 * disk/WAL bytes or billing. null means missing coverage, never zero cost. */
export type RequestDatabaseCost = Readonly<{
  version: 1; scope: "application-query-port"; method: string; route: string; status: number | "error";
  clockDomainId: string; clockSource: "node-process-hrtime"; startedAtUs: number | null; completedAtUs: number | null;
  clockCoverage: "complete" | "unavailable"; origin: RequestOrigin | null; originCoverage: "verified" | "unverified" | "conflict";
  causalCoverage: "unavailable";
  queriesStarted: number; queriesCompleted: number; queriesFailed: number; queriesInFlight: number;
  uncheckedClientCheckouts: number; checkoutsInFlight: number;
  transactions: number; commits: number; rollbacks: number;
  sqlStatements: number | null; sqlWriteStatements: number | null; observedAffectedRows: number;
  affectedRows: number | null; encodedPersistedBytes: number | null; committedEncodedPersistedBytes: number | null;
  complete: boolean;
}>;
export type DatabasePersistenceCost = Readonly<{ writeStatements?: number; affectedRows: number; encodedPersistedBytes: number }>;
type TransactionCost = { phase: "open" | "committed" | "rolled-back" | "unknown"; bytes: number; unknownBytes: number; owned: boolean };
type ResultCost = { state: DatabaseCostState; tx: TransactionCost; writes: number | null; rows: number | null; bytes: number | null; minimumRows: number;
  annotation?: DatabasePersistenceCost };
type DatabaseCostState = {
  startedAtUs: number | null; origin: RequestOrigin | null; originRaw: string | null;
  originCoverage: "verified" | "unverified" | "conflict"; originRejected: boolean;
  queriesStarted: number; queriesCompleted: number; queriesFailed: number; queriesInFlight: number;
  uncheckedClientCheckouts: number; checkoutsInFlight: number;
  transactions: number; commits: number; rollbacks: number; statements: number; writes: number; observedRows: number;
  rows: number; bytes: number; committedBytes: number; unknownWrites: number; unknownRows: number;
  unknownBytes: number; unknownCommittedBytes: number; unavailable: boolean; closed: boolean;
  results: WeakMap<object, ResultCost>;
};
export type RequestCostObserverStatus = Readonly<{ enabled: boolean; pending: number; dropped: number; errors: number }>;
export type RequestTimingMiddleware = MiddlewareHandler & {
  costObserverStatus(): RequestCostObserverStatus;
};

function newDatabaseCost(): DatabaseCostState {
  return { startedAtUs: clockUs(), origin: null, originRaw: null, originCoverage: "unverified", originRejected: false,
    queriesStarted: 0, queriesCompleted: 0, queriesFailed: 0, queriesInFlight: 0, uncheckedClientCheckouts: 0, checkoutsInFlight: 0, transactions: 0,
    commits: 0, rollbacks: 0, statements: 0, writes: 0, observedRows: 0, rows: 0, bytes: 0, committedBytes: 0,
    unknownWrites: 0, unknownRows: 0, unknownBytes: 0, unknownCommittedBytes: 0, unavailable: false,
    closed: false, results: new WeakMap() };
}
const counter = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
function add(state: DatabaseCostState, left: number, right: number): number {
  const value = left + right;
  if (Number.isSafeInteger(value) && value >= 0) return value;
  state.unavailable = true;
  return Number.MAX_SAFE_INTEGER;
}
// Data descriptors only: neither QueryConfig getters, thenables, result rows
// nor arbitrary object coercion participates in observation.
function data(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  try { return Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return undefined; }
}

/** A bounded conservative lexer, not an SQL parser. Completion tags establish
 * statement counts; primitive SQL helps detect writable CTEs. Function calls,
 * opaque configs and unsupported syntax require a producer annotation. SQL is
 * used transiently here and never retained by the observer. */
function queryWrites(value: unknown): Array<number | null> | null {
  if (typeof value !== "string" || value.length > 65_536) return null;
  const statements: string[][] = [[]], statementTexts: string[] = [];
  let i = 0, tokens = 0, statementStart = 0;
  const push = (word: string) => { statements[statements.length - 1]!.push(word); return ++tokens <= 8192; };
  while (i < value.length) {
    const char = value[i]!;
    if (/\s/.test(char)) { i++; continue; }
    if (value.startsWith("--", i)) { const end = value.indexOf("\n", i + 2); i = end < 0 ? value.length : end + 1; continue; }
    if (value.startsWith("/*", i)) {
      let depth = 1; i += 2;
      while (i < value.length && depth) {
        if (value.startsWith("/*", i)) { depth++; i += 2; }
        else if (value.startsWith("*/", i)) { depth--; i += 2; } else i++;
      }
      if (depth) return null;
      continue;
    }
    if (char === "'" || char === '"') {
      const quote = char; i++; let ended = false;
      while (i < value.length) {
        // Backslash syntax depends on session settings; refuse that coverage.
        if (value[i] === "\\") return null;
        if (value[i++] !== quote) continue;
        if (value[i] === quote) { i++; continue; }
        ended = true; break;
      }
      if (!ended || !push(quote === "'" ? "LITERAL" : "IDENTIFIER")) return null;
      continue;
    }
    if (char === "$") {
      const delimiter = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(value.slice(i))?.[0];
      if (delimiter) {
        const end = value.indexOf(delimiter, i + delimiter.length);
        if (end < 0 || !push("LITERAL")) return null;
        i = end + delimiter.length; continue;
      }
    }
    if (/[A-Za-z_]/.test(char)) {
      const start = i++;
      while (i < value.length && /[A-Za-z0-9_$]/.test(value[i]!)) i++;
      if (!push(value.slice(start, i).toUpperCase())) return null;
      continue;
    }
    if (char === ";") {
      if (statements[statements.length - 1]!.length) { statementTexts.push(value.slice(statementStart, i).trim()); statements.push([]); }
      statementStart = i + 1;
      if (statements.length > 1024) return null;
    } else if (!push(char)) return null;
    i++;
  }
  if (statements[statements.length - 1]!.length) statementTexts.push(value.slice(statementStart).trim());
  return statements.filter(words => words.length).map((words, statementIndex) => {
    const first = words[0];
    if (["BEGIN", "COMMIT", "ROLLBACK", "SET"].includes(first!)) return 0;
    if (!["SELECT", "WITH", "INSERT", "UPDATE", "DELETE", "MERGE"].includes(first!)) return null;
    const write = words.some((word, index) => ["INSERT", "UPDATE", "DELETE", "MERGE"].includes(word) &&
      !(word === "UPDATE" && (words[index - 1] === "FOR" || words.slice(index - 3, index).join(" ") === "FOR NO KEY")));
    if (write) return 1;
    // Only the literal helper setup call is known to change request GUCs,
    // rather than persistence. Other functions may write via their bodies.
    const setup = statementTexts[statementIndex] === "SELECT set_config('app.system', 'on', true)" ||
      statementTexts[statementIndex] === "SELECT set_config('app.user_id', $1, true)";
    if (setup) return 0;
    if (words.some((word, index) => words[index + 1] === "(" && !["IN", "AS", "EXISTS", "OVER", "SELECT", "VALUES"].includes(word))) return null;
    return 0;
  });
}

function replaceResultCost(observed: ResultCost, writes: number | null, rows: number | null, bytes: number | null): void {
  const { state, tx } = observed;
  state.unknownWrites += Number(writes === null) - Number(observed.writes === null);
  state.unknownRows += Number(rows === null) - Number(observed.rows === null);
  state.unknownBytes += Number(bytes === null) - Number(observed.bytes === null);
  state.writes = add(state, state.writes - (observed.writes ?? 0), writes ?? 0);
  state.rows = add(state, state.rows - (observed.rows ?? 0), rows ?? 0);
  state.bytes = add(state, state.bytes - (observed.bytes ?? 0), bytes ?? 0);
  tx.bytes = add(state, tx.bytes - (observed.bytes ?? 0), bytes ?? 0);
  tx.unknownBytes += Number(bytes === null) - Number(observed.bytes === null);
  if (tx.phase === "committed") {
    state.committedBytes = add(state, state.committedBytes - (observed.bytes ?? 0), bytes ?? 0);
    state.unknownCommittedBytes += Number(bytes === null) - Number(observed.bytes === null);
  }
  observed.writes = writes; observed.rows = rows; observed.bytes = bytes;
}

/** Producer-owned counts, bound to the exact observed pg result. Include CTE
 * pruning/upserts/trigger effects in the verified rows/encoding method. This
 * does not inspect SQL arguments or serialize stored private values. */
export function recordDatabasePersistenceCost(result: unknown, annotation: DatabasePersistenceCost): void {
  const current = currentDatabaseCost();
  if (result === null || typeof result !== "object") { if (current && !current.closed) current.unavailable = true; return; }
  // A reused socket may invoke its original callback outside the submitting
  // request's async scope. Exact result identity owns its annotations; never
  // charge whichever unrelated request happens to be active at that moment.
  const observed = observedResults.get(result);
  const state = observed?.state ?? current;
  if (!state || state.closed) return;
  if (!observed) { state.unavailable = true; return; }
  const rows = data(annotation, "affectedRows"), bytes = data(annotation, "encodedPersistedBytes");
  const suppliedWrites = data(annotation, "writeStatements");
  const writes = suppliedWrites === undefined ? observed.writes : suppliedWrites;
  if (!counter(rows) || !counter(bytes) || rows < observed.minimumRows || writes === 0 && (rows !== 0 || bytes !== 0) ||
      writes !== null && (!counter(writes) || writes > 1) ||
      observed.writes !== null && writes !== null && writes < observed.writes) { state.unavailable = true; return; }
  const previous = observed.annotation;
  if (previous) {
    if (previous.affectedRows !== rows || previous.encodedPersistedBytes !== bytes || previous.writeStatements !== (writes ?? undefined)) state.unavailable = true;
    return;
  }
  observed.annotation = { affectedRows: rows, encodedPersistedBytes: bytes, ...(writes === null ? {} : { writeStatements: writes }) };
  replaceResultCost(observed, writes, rows, bytes);
}

function completedQuery(state: DatabaseCostState, tx: TransactionCost, value: unknown, classes: Array<number | null> | null): void {
  const length = Array.isArray(value) ? data(value, "length") : 1;
  if (!counter(length) || length < 1 || length > 1024) { state.unavailable = true; return; }
  for (let index = 0; index < length; index++) {
    const result = Array.isArray(value) ? data(value, String(index)) : value;
    const command = data(result, "command"), rows = data(result, "rowCount");
    if (typeof command !== "string" || !/^[A-Z ]{1,32}$/.test(command) || result === null || typeof result !== "object") {
      state.unavailable = true; continue;
    }
    state.statements = add(state, state.statements, 1);
    const writes = classes?.length === length ? classes[index]! : null;
    if (["SAVEPOINT", "RELEASE"].includes(command) || !tx.owned && ["BEGIN", "COMMIT", "ROLLBACK"].includes(command)) state.unavailable = true;
    if (command === "BEGIN") { state.transactions = add(state, state.transactions, 1); tx.phase = "open"; }
    else if (command === "COMMIT") {
      state.commits = add(state, state.commits, 1);
      state.committedBytes = add(state, state.committedBytes, tx.bytes);
      state.unknownCommittedBytes = add(state, state.unknownCommittedBytes, tx.unknownBytes);
      tx.phase = "committed";
    } else if (command === "ROLLBACK") { state.rollbacks = add(state, state.rollbacks, 1); tx.phase = "rolled-back"; }
    if (["INSERT", "UPDATE", "DELETE", "MERGE"].includes(command)) {
      if (counter(rows)) state.observedRows = add(state, state.observedRows, rows);
      else state.unavailable = true;
    }
    if (state.results.has(result)) { state.unavailable = true; continue; }
    const previous = observedResults.get(result);
    if (previous && previous.state !== state && !previous.state.closed) { state.unavailable = true; previous.state.unavailable = true; continue; }
    const observation: ResultCost = { state, tx, writes: 0, rows: 0, bytes: 0,
      minimumRows: ["INSERT", "UPDATE", "DELETE", "MERGE"].includes(command) && counter(rows) ? rows : 0 };
    state.results.set(result, observation);
    observedResults.set(result, observation);
    replaceResultCost(observation, writes, writes === 0 ? 0 : null, writes === 0 ? 0 : null);
  }
}

function observablePromise(value: unknown): value is Promise<unknown> {
  return isPromise(value) && Object.getPrototypeOf(value) === Promise.prototype && !Object.hasOwn(value, "constructor");
}

type ObservedMethod = (this: unknown, ...args: unknown[]) => unknown;
function replacePort(target: PoolClient | Pool, key: "query" | "connect", initial: DatabaseCostState,
  wrap: (original: ObservedMethod) => ObservedMethod, optional = false, onUnavailable = () => {
    initial.unavailable = true;
    const current = currentDatabaseCost();
    if (current && !current.closed) current.unavailable = true;
  }): (() => void) | undefined {
  let own: PropertyDescriptor | undefined;
  try {
    own = Object.getOwnPropertyDescriptor(target, key);
    let descriptor = own, owner: object | null = target;
    for (let depth = 0; !descriptor && owner && depth < 16; depth++) {
      owner = Object.getPrototypeOf(owner) as object | null;
      if (owner) descriptor = Object.getOwnPropertyDescriptor(owner, key);
    }
    if (!descriptor && !owner && optional) return undefined;
    const original: unknown = descriptor?.value;
    if (typeof original !== "function" || own && !own.configurable && !own.writable) { onUnavailable(); return undefined; }
    Object.defineProperty(target, key, own ? { ...own, value: wrap(original as ObservedMethod) } :
      { configurable: true, enumerable: false, writable: true, value: wrap(original as ObservedMethod) });
  } catch { onUnavailable(); return undefined; }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    try {
      if (own) Object.defineProperty(target, key, own); else Reflect.deleteProperty(target, key);
    } catch { onUnavailable(); }
  };
}

// One pool.query invocation owns at most its one internal checkout. Its
// allowance is consumed at connect ingress, so additional checkouts and
// concurrent application work cannot inherit a blanket coverage exemption.
const poolQueryOrigin = new AsyncLocalStorage<{ pool: Pool; consumed: boolean } | undefined>();
function installQueryObservation(target: PoolClient | Pool, scope: () => { state: DatabaseCostState; tx: TransactionCost } | undefined,
  initial: DatabaseCostState, originPool?: Pool): (() => void) | undefined {
  return replacePort(target, "query", initial, original => {
    const wrapper = function (this: unknown, ...args: unknown[]): unknown {
      const observed = scope();
      if (!observed || observed.state.closed) return Reflect.apply(original, this, args);
      const { state, tx } = observed;
      state.queriesStarted = add(state, state.queriesStarted, 1);
      state.queriesInFlight = add(state, state.queriesInFlight, 1);
      let classes: Array<number | null> | null = null;
      try { classes = queryWrites(args[0]); } catch { state.unavailable = true; }
      let settled = false;
      const settle = (failed: boolean, result?: unknown) => {
        if (settled || state.closed) return;
        settled = true;
        state.queriesInFlight--;
        try {
          if (failed) { state.queriesFailed = add(state, state.queriesFailed, 1); state.unavailable = true; }
          else { state.queriesCompleted = add(state, state.queriesCompleted, 1); completedQuery(state, tx, result, classes); }
        } catch { state.unavailable = true; }
      };
      const callback = args[args.length - 1];
      if (typeof callback === "function") args[args.length - 1] = function (this: unknown, ...values: unknown[]) {
        settle(values[0] != null, values[1]);
        return callbackCosts.run(state, () => originPool ? poolQueryOrigin.run(undefined, () => Reflect.apply(callback, this, values)) :
          Reflect.apply(callback, this, values));
      };
      let returned: unknown;
      try {
        returned = originPool ? poolQueryOrigin.run({ pool: originPool, consumed: false }, () => Reflect.apply(original, this, args)) :
          Reflect.apply(original, this, args);
      } catch (error) { settle(true); throw error; }
      if (typeof callback !== "function") {
        try {
          if (observablePromise(returned)) {
            // No then/constructor getter or custom Promise species is read.
            void Promise.prototype.then.call(returned, (result: unknown) => settle(false, result), () => settle(true));
          } else state.unavailable = true;
        } catch { state.unavailable = true; }
      }
      return returned;
    };
    return wrapper;
  });
}

const uncheckedClients = new WeakMap<object, WeakMap<DatabaseCostState, number>>();
function observePoolCheckouts(pool: Pool, initial: DatabaseCostState) {
  let complete = true;
  const unavailable = () => {
    complete = false; initial.unavailable = true;
    const current = currentDatabaseCost();
    if (current && !current.closed) current.unavailable = true;
  };
  const restore = replacePort(pool, "connect", initial, original => function (this: unknown, ...args: unknown[]): unknown {
    const state = currentDatabaseCost();
    if (!state || state.closed) return Reflect.apply(original, this, args);
    const origin = poolQueryOrigin.getStore();
    if (origin?.pool === pool && !origin.consumed) { origin.consumed = true; return Reflect.apply(original, this, args); }
    state.uncheckedClientCheckouts = add(state, state.uncheckedClientCheckouts, 1);
    state.checkoutsInFlight = add(state, state.checkoutsInFlight, 1);
    let settled = false;
    const settle = (failed: boolean, client?: unknown) => {
      if (settled || state.closed) return;
      settled = true; state.checkoutsInFlight--;
      if (failed || client === null || typeof client !== "object") { state.unavailable = true; return; }
      let owners = uncheckedClients.get(client);
      if (!owners) { owners = new WeakMap(); uncheckedClients.set(client, owners); }
      owners.set(state, add(state, owners.get(state) ?? 0, 1));
    };
    const callback = args.at(-1);
    if (typeof callback === "function") args[args.length - 1] = function (this: unknown, ...values: unknown[]) {
      settle(values[0] != null, values[1]);
      return callbackCosts.run(state, () => Reflect.apply(callback, this, values));
    };
    let returned: unknown;
    try { returned = Reflect.apply(original, this, args); } catch (error) { settle(true); throw error; }
    if (typeof callback !== "function") {
      try {
        if (observablePromise(returned)) void Promise.prototype.then.call(returned, (client: unknown) => settle(false, client), () => settle(true));
        else state.unavailable = true;
      } catch { state.unavailable = true; }
    }
    return returned;
  }, true, unavailable);
  return { restore, complete: () => complete };
}

/** Query methods remain untouched outside the lifetime of observed requests.
 * Concurrent requests sharing a pool use the current async scope and restore
 * the original descriptor only after the final observed request returns. */
const observedPools = new WeakMap<Pool, { users: number; checkoutCoverage(): boolean; restore(): void }>();
function observeRequestPool(pool: Pool): (() => void) | undefined {
  const state = currentDatabaseCost();
  if (!state || state.closed) return undefined;
  let observed = observedPools.get(pool);
  if (!observed) {
    const restore = installQueryObservation(pool, () => {
      const cost = currentDatabaseCost();
      if (!cost || cost.closed) return undefined;
      // pool.query uses autocommit; explicit BEGIN/COMMIT tags are reported
      // separately. It never supplies a stable multi-query transaction owner.
      return { state: cost, tx: { phase: "committed", bytes: 0, unknownBytes: 0, owned: false } };
    }, state, pool);
    if (!restore) return undefined;
    const checkouts = observePoolCheckouts(pool, state);
    observed = { users: 0, checkoutCoverage: checkouts.complete, restore() { checkouts.restore?.(); restore(); } };
    observedPools.set(pool, observed);
  }
  observed.users++;
  if (!observed.checkoutCoverage()) state.unavailable = true;
  const entry = observed;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--entry.users === 0) { entry.restore(); observedPools.delete(pool); }
  };
}

/** Temporarily observe a checked-out client's actual query port. Disabled
 * requests return before even looking up query, preserving its identity.
 * The returned cleanup must run before the client goes back to the pool. */
export function observeDatabaseTransaction(client: PoolClient): (() => void) | undefined {
  const state = currentDatabaseCost();
  if (!state || state.closed) return undefined;
  const owners = uncheckedClients.get(client), checkouts = owners?.get(state) ?? 0;
  if (checkouts > 0) { owners!.set(state, checkouts - 1); state.uncheckedClientCheckouts--; }
  const tx: TransactionCost = { phase: "unknown", bytes: 0, unknownBytes: 0, owned: true };
  const restore = installQueryObservation(client, () => ({ state, tx }), state);
  if (!restore) return undefined;
  return () => {
    restore();
    if (!state.closed && tx.phase !== "committed" && tx.phase !== "rolled-back") state.unavailable = true;
  };
}

function costSummary(state: DatabaseCostState, method: string, route: string, status: number | "error"): RequestDatabaseCost {
  const unavailable = state.unavailable || state.queriesInFlight > 0 || state.uncheckedClientCheckouts > 0 || state.checkoutsInFlight > 0;
  const writes = unavailable || state.unknownWrites > 0 ? null : state.writes;
  const rows = unavailable || state.unknownRows > 0 ? null : state.rows;
  const bytes = unavailable || state.unknownBytes > 0 ? null : state.bytes;
  const committed = unavailable || state.unknownCommittedBytes > 0 ? null : state.committedBytes;
  const sampled = clockUs();
  const clockComplete = state.startedAtUs !== null && sampled !== null && sampled >= state.startedAtUs;
  return Object.freeze({ version: 1, scope: "application-query-port", method, route, status,
    clockDomainId: requestCostClockDomainId ??= randomUUID(), clockSource: "node-process-hrtime",
    startedAtUs: clockComplete ? state.startedAtUs : null, completedAtUs: clockComplete ? sampled : null,
    clockCoverage: clockComplete ? "complete" : "unavailable", origin: state.origin, originCoverage: state.originCoverage,
    // Authenticated producer provenance still does not establish a per-turn
    // wait edge, especially for shared/pre-window background requests.
    causalCoverage: "unavailable",
    queriesStarted: state.queriesStarted, queriesCompleted: state.queriesCompleted, queriesFailed: state.queriesFailed,
    queriesInFlight: state.queriesInFlight, transactions: state.transactions, commits: state.commits, rollbacks: state.rollbacks,
    uncheckedClientCheckouts: state.uncheckedClientCheckouts, checkoutsInFlight: state.checkoutsInFlight,
    sqlStatements: unavailable ? null : state.statements, sqlWriteStatements: writes, observedAffectedRows: state.observedRows,
    affectedRows: rows, encodedPersistedBytes: bytes, committedEncodedPersistedBytes: committed,
    complete: !unavailable && writes !== null && rows !== null && bytes !== null && committed !== null });
}

const active = new AsyncLocalStorage<RequestTimingState>();
// pg may deliver callbacks from an existing socket resource. Cost attribution
// follows the submitting observation without altering legacy timing's scope.
const callbackCosts = new AsyncLocalStorage<DatabaseCostState | undefined>();
function currentDatabaseCost() { return callbackCosts.getStore() ?? active.getStore()?.cost; }
const observedResults = new WeakMap<object, ResultCost>();

/** Call only after the service independently authenticates the current engine
 * and validates its actual operation/body intent. The header is observation
 * input; it never authorizes a request or changes its result. */
export function recordVerifiedEngineRequestOrigin(rawHeader: string | undefined, expected: VerifiedEngineRequestOrigin): boolean {
  const state = currentDatabaseCost();
  if (!state || state.closed) return false;
  const reject = () => {
    if (state.originCoverage === "verified") state.originCoverage = "conflict";
    state.origin = null; state.originRaw = null; state.originRejected = true;
    return false;
  };
  try {
    if (!rawHeader || Buffer.byteLength(rawHeader) > 2048) return reject();
    const parsed = requestOriginSchema.safeParse(JSON.parse(rawHeader));
    if (!parsed.success || JSON.stringify(parsed.data) !== rawHeader) return reject();
    const value = parsed.data;
    if (value.organizationId !== expected.organizationId || value.workspaceId !== expected.workspaceId ||
        value.generation !== expected.generation || value.engineInstanceId !== expected.engineInstanceId ||
        value.mode !== expected.mode || value.bootId !== expected.bootId || value.writerEpoch !== expected.writerEpoch ||
        value.operation !== expected.operation || value.intent.kind !== expected.intent.kind) return reject();
    const intent = value.intent, actual = expected.intent;
    if (intent.kind === "command" && (actual.kind !== "command" || intent.commandId !== actual.commandId ||
        intent.conversationId !== actual.conversationId || intent.turnId !== actual.turnId || intent.executionId !== actual.executionId) ||
        intent.kind === "claim" && (intent.claimId === null || actual.kind !== "claim" || intent.claimId !== actual.claimId ||
          intent.conversationId !== actual.conversationId || intent.executionId !== actual.executionId)) return reject();
    if (state.originRejected || state.originRaw !== null && state.originRaw !== rawHeader) {
      state.originCoverage = "conflict";
      return reject();
    }
    state.origin = Object.freeze({ ...value, intent: Object.freeze(value.intent) });
    state.originRaw = rawHeader; state.originCoverage = "verified";
    return true;
  } catch { return reject(); }
}

/** Attribute one shared-helper transaction to the request being served: its
 * pool wait, and the remaining time it held the connection. Work outside a
 * request (background loops) and work that outlives the logged request
 * (detached stream callbacks, timers) is not counted. */
export function recordTransactionTiming(waitMs: number, totalMs: number): void {
  const timing = active.getStore();
  if (!timing || timing.closed) return;
  timing.transactions += 1;
  timing.waitMs += waitMs;
  timing.heldMs += Math.max(0, totalMs - waitMs);
}

/** Attribute a pool wait that ended without a connection, such as an acquire
 * timeout under pool saturation. */
export function recordPoolWait(waitMs: number): void {
  const timing = active.getStore();
  if (!timing || timing.closed) return;
  timing.waitMs += waitMs;
}

/** Log requests slower than `slowMs` once, by the template of the route that
 * handled them rather than the raw path, so identifiers and query strings
 * never enter operational logs. `txMs` and `waitMs` are sums over the
 * request's helper transactions and can exceed wall time when they overlap.
 * Streaming responses are timed until their handler returns. */
export function requestTiming(options: {
  slowMs: number;
  log?: (line: string) => void;
  costObserver?: (cost: RequestDatabaseCost) => void | Promise<void>;
  databasePool?: Pool;
}): RequestTimingMiddleware {
  const log = options.log ?? ((line: string) => console.warn(line));
  const observer = options.costObserver;
  let pending = 0, dropped = 0, errors = 0;
  const emit = (summary: RequestDatabaseCost) => {
    if (!observer) return;
    if (pending >= 16) { dropped = Math.min(Number.MAX_SAFE_INTEGER, dropped + 1); return; }
    pending++;
    const release = (failed: boolean) => { pending--; if (failed) errors = Math.min(Number.MAX_SAFE_INTEGER, errors + 1); };
    try {
      const returned = observer(summary);
      if (observablePromise(returned)) void Promise.prototype.then.call(returned, () => release(false), () => release(true));
      else release(returned !== undefined);
    } catch { release(true); }
  };
  const middleware: MiddlewareHandler = async (c, next) => {
    const timing: RequestTimingState = { transactions: 0, heldMs: 0, waitMs: 0, closed: false,
      ...(observer ? { cost: newDatabaseCost() } : {}) };
    const started = performance.now();
    let failed = false;
    try {
      if (observer && options.databasePool) {
        await callbackCosts.run(timing.cost, () => active.run(timing, async () => {
          const restorePool = observeRequestPool(options.databasePool!);
          try { await next(); } finally { restorePool?.(); }
        }));
      } else if (observer || callbackCosts.getStore()) await callbackCosts.run(timing.cost, () => active.run(timing, next));
      else await active.run(timing, next);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      timing.closed = true;
      if (timing.cost) {
        timing.cost.closed = true;
        emit(costSummary(timing.cost, /^[A-Z]{3,7}$/.test(c.req.method) ? c.req.method : "OTHER",
          routePath(c) || "unmatched", !failed && c.finalized ? c.res.status : "error"));
      }
      const ms = performance.now() - started;
      if (ms >= options.slowMs) {
        const method = /^[A-Z]{3,7}$/.test(c.req.method) ? c.req.method : "OTHER";
        const status = !failed && c.finalized ? String(c.res.status) : "error";
        log(
          `[http] slow ${method} ${routePath(c) || "unmatched"} ${status} ${Math.round(ms)}ms ` +
            `tx=${timing.transactions} txMs=${Math.round(timing.heldMs)} waitMs=${Math.round(timing.waitMs)}`,
        );
      }
    }
  };
  return Object.assign(middleware, { costObserverStatus: () => Object.freeze({ enabled: Boolean(observer), pending, dropped, errors }) });
}

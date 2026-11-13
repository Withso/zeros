import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type pg from "pg";
import type { RequestDatabaseCost } from "../request-timing.js";

export const IDLE_WINDOW_MS = 300_000;
export const LOAD_BUDGETS = [
  { scenario: "idle", metric: "requests", maximum: 30 },
  { scenario: "idle", metric: "statements", maximum: 200 },
  { scenario: "turn-lease", metric: "transactions", maximum: 6 },
  { scenario: "turn-path", metric: "transactions", maximum: 20 },
  { scenario: "renewal", metric: "transactions", maximum: 2 },
  { scenario: "workspace-list", metric: "transactions", maximum: 3 },
] as const;

export type SqlCost = { queries: number; statements: number; transactions: number; commits: number; rollbacks: number;
  failures: number; inFlight: number; injectedDelayMs: number };
export type LoadRequest = SqlCost & { method: string; route: string; status: number; simulatedAtMs: number; elapsedMs: number;
  open: boolean; streaming: boolean; observer?: RequestDatabaseCost };
export type LoadScenario = { name: string; requests: LoadRequest[]; background: SqlCost; elapsedMs: number };
const emptySql = (): SqlCost => ({ queries: 0, statements: 0, transactions: 0, commits: 0, rollbacks: 0, failures: 0, inFlight: 0, injectedDelayMs: 0 });
type Port = (this: unknown, ...args: unknown[]) => unknown;

const templates = [
  "/auth/browser/session", "/v1/me", "/v1/cloud-v2/workspaces",
  "/v1/cloud-v2/workspaces/:id", "/v1/cloud-v2/workspaces/:id/events", "/v1/cloud-v2/workspaces/:id/prompts",
  "/v1/cloud-v2/devices/:deviceId/connections", "/v1/cloud-v2/devices/:deviceId/events", "/v1/cloud-v2/devices/:deviceId/heartbeat",
  "/v2/cloud/worker/prompts/pull", "/v2/cloud/worker/prompts/ack", "/v2/cloud/worker/prompts/begin",
  "/v2/cloud/worker/turn-lease", "/v2/cloud/worker/execution-leases/renew", "/v2/cloud/worker/history", "/v2/cloud/worker/activity",
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

export async function holdLoadStream(body: ReadableStream<Uint8Array>, abort: AbortController) {
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
  return { done, stop: async () => { await cancel(); await done; } };
}

/** The lower pg port observes detached stream/background work too. Completion
 * tags count batches without parsing SQL, retaining parameters, or counting
 * pool.query and its checked-out client twice. */
export class LoadBudgetProbe {
  private readonly scope = new AsyncLocalStorage<LoadRequest | undefined>();
  private active: LoadScenario | undefined;
  private simulatedAtMs = 0;
  private readonly restore: Array<() => void> = [];
  private readonly attach: (client: pg.PoolClient) => void;
  private statementDelayMs = 0;

  constructor(private readonly pool: pg.Pool) {
    this.attach = client => this.wrapClient(client);
    pool.on("connect", this.attach);
    const original = pool.connect;
    const scopes = this.scope;
    pool.connect = function (this: unknown, ...args: unknown[]) {
      const owner = scopes.getStore(), callback = args.at(-1);
      // pg-pool can invoke a checkout callback on a socket born in an older
      // request. Re-enter the submitting scope before pool.query calls query.
      if (typeof callback === "function") args[args.length - 1] = function (this: unknown, ...values: unknown[]) {
        return scopes.run(owner, () => Reflect.apply(callback, this, values));
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

  private wrapClient(client: pg.PoolClient): void {
    const original = client.query as Port;
    const capture = () => {
      const owner = this.scope.getStore();
      return { owner, cost: owner?.open ? owner : this.active?.background, statementDelayMs: this.statementDelayMs };
    };
    const scopes = this.scope;
    client.query = function (this: unknown, ...args: unknown[]): unknown {
      const { owner, cost, statementDelayMs } = capture();
      if (!cost) return Reflect.apply(original, this, args);
      cost.queries++; cost.inFlight++;
      const settled = async (error: unknown, result?: unknown) => {
        try {
          if (error) { cost.failures++; return; }
          const commands = (Array.isArray(result) ? result : [result]).map(value =>
            value && typeof value === "object" && "command" in value ? value.command : undefined);
          if (!commands.length || commands.some(command => typeof command !== "string" || !/^[A-Z ]+$/.test(command))) {
            cost.failures++; return;
          }
          cost.statements += commands.length;
          cost.transactions += commands.filter(command => command === "BEGIN").length;
          cost.commits += commands.filter(command => command === "COMMIT").length;
          cost.rollbacks += commands.filter(command => command === "ROLLBACK").length;
          // Delay delivery of each completed command, including BEGIN/SET/
          // COMMIT in one simple-protocol batch. Database clocks stay real.
          const waitMs = statementDelayMs * commands.length;
          cost.injectedDelayMs += waitMs;
          if (waitMs) await delay(waitMs);
        } finally { cost.inFlight--; }
      };
      const callback = args.at(-1);
      if (typeof callback === "function") {
        args[args.length - 1] = function (this: unknown, ...values: unknown[]) {
          void settled(values[0], values[1]).then(() => scopes.run(owner, () => Reflect.apply(callback, this, values)));
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
    const route = routeTemplate(new URL(request.url).pathname);
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

  async measure<T>(name: string, work: () => Promise<T>): Promise<{ value: T; cost: LoadScenario }> {
    if (this.active) throw new Error("Load scenarios must not overlap");
    const cost: LoadScenario = { name, requests: [], background: emptySql(), elapsedMs: 0 };
    this.active = cost;
    const started = performance.now();
    try {
      const value = await work(); await this.drain(cost);
      if (cost.requests.some(request => request.status < 200 || request.status >= 300)) throw new Error("Load replay included an unsuccessful request");
      return { value, cost };
    }
    finally { cost.elapsedMs = performance.now() - started; this.active = undefined; this.simulatedAtMs = 0; }
  }

  async at<T>(milliseconds: number, work: () => Promise<T>): Promise<T> {
    this.simulatedAtMs = milliseconds;
    return work();
  }

  private async drain(cost: LoadScenario): Promise<void> {
    await delay(0);
    for (let attempt = 0; attempt < 500; attempt++) {
      if (cost.background.inFlight + cost.requests.reduce((sum, request) => sum + request.inFlight, 0) === 0) return;
      await delay(10);
    }
    throw new Error("Load observation ended with SQL in flight");
  }

  close(): void {
    this.pool.off("connect", this.attach);
    for (const restore of this.restore.reverse()) restore();
  }
}

export function scenarioTotals(cost: LoadScenario): SqlCost & { requests: number } {
  const total = { ...cost.background, requests: cost.requests.length };
  for (const request of cost.requests) for (const key of Object.keys(emptySql()) as Array<keyof SqlCost>) total[key] += request[key];
  return total;
}

export function budgetTable(scenarios: ReadonlyMap<string, LoadScenario>) {
  return LOAD_BUDGETS.map(budget => {
    const cost = scenarios.get(budget.scenario);
    if (!cost) throw new Error(`Missing load scenario: ${budget.scenario}`);
    const total = scenarioTotals(cost);
    if (total.failures || total.inFlight) throw new Error(`Incomplete SQL observation: ${budget.scenario}`);
    const observed = total[budget.metric];
    return { ...budget, observed, result: observed <= budget.maximum ? "PASS" : "FAIL" };
  });
}

export function routeTable(cost: LoadScenario) {
  const groups = new Map<string, { method: string; route: string; status: number; requests: number; queries: number; statements: number;
    transactions: number; maxStatementsPerRequest: number; maxTransactionsPerRequest: number }>();
  for (const request of cost.requests) {
    const key = `${request.method} ${request.route} ${request.status}`;
    const row = groups.get(key) ?? { method: request.method, route: request.route, status: request.status, requests: 0, queries: 0,
      statements: 0, transactions: 0, maxStatementsPerRequest: 0, maxTransactionsPerRequest: 0 };
    row.requests++; row.queries += request.queries; row.statements += request.statements; row.transactions += request.transactions;
    row.maxStatementsPerRequest = Math.max(row.maxStatementsPerRequest, request.statements);
    row.maxTransactionsPerRequest = Math.max(row.maxTransactionsPerRequest, request.transactions);
    groups.set(key, row);
  }
  return [...groups.values()].sort((left, right) => `${left.method} ${left.route}`.localeCompare(`${right.method} ${right.route}`));
}

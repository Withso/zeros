// Client-side database cost accounting for the control-plane load simulator.
//
// Every pool handed to real control-plane services is wrapped so each driver
// call is attributed to the simulated operation that issued it. Attribution
// uses AsyncLocalStorage, which follows awaits and timers created inside the
// operation, so background workers started inside `meter.run(name, ...)`
// stay attributed to that name for their whole life.

import { AsyncLocalStorage } from "node:async_hooks";
import type pg from "pg";

export type OperationCost = {
  /** Completed operation invocations recorded with `meter.measure`. */
  calls: number;
  /** One driver `query()` call is one network round trip. */
  roundTrips: number;
  /** Simple-protocol batches return one result per statement. */
  statements: number;
  /** Explicit BEGIN blocks plus implicit single-call autocommit transactions. */
  transactions: number;
  commits: number;
  rollbacks: number;
  /** Pool checkouts (`pool.connect`). */
  checkouts: number;
  /** Sum of driver round-trip wall time, loopback included. */
  clientDbMs: number;
  errors: number;
};

export const emptyCost = (): OperationCost => ({
  calls: 0, roundTrips: 0, statements: 0, transactions: 0, commits: 0,
  rollbacks: 0, checkouts: 0, clientDbMs: 0, errors: 0,
});

export const UNATTRIBUTED = "unattributed";

function queryText(args: readonly unknown[]): string {
  const first = args[0];
  if (typeof first === "string") return first;
  if (first && typeof first === "object" && "text" in first && typeof first.text === "string") return first.text;
  return "";
}

function leadingKeyword(sql: string): string {
  return /^\s*([A-Za-z]+)/.exec(sql)?.[1]?.toUpperCase() ?? "";
}

export class DatabaseCostMeter {
  private readonly scope = new AsyncLocalStorage<string>();
  private readonly costs = new Map<string, OperationCost>();
  private readonly latencies = new Map<string, number[]>();

  /** Run `fn` with every query it issues attributed to `name`. */
  run<T>(name: string, fn: () => T): T {
    return this.scope.run(name, fn);
  }

  /** Attribute, count one call and record its wall latency. */
  async measure<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await this.run(name, fn);
    } finally {
      this.cost(name).calls += 1;
      const samples = this.latencies.get(name) ?? [];
      if (samples.length < 100_000) samples.push(performance.now() - started);
      this.latencies.set(name, samples);
    }
  }

  snapshot(): Map<string, OperationCost> {
    return new Map([...this.costs].map(([name, cost]) => [name, { ...cost }]));
  }

  latencySamples(name: string): readonly number[] {
    return this.latencies.get(name) ?? [];
  }

  reset(): void {
    this.costs.clear();
    this.latencies.clear();
  }

  total(): OperationCost {
    const total = emptyCost();
    for (const cost of this.costs.values()) addCost(total, cost);
    return total;
  }

  private cost(name: string): OperationCost {
    let cost = this.costs.get(name);
    if (!cost) {
      cost = emptyCost();
      this.costs.set(name, cost);
    }
    return cost;
  }

  private current(): OperationCost {
    return this.cost(this.scope.getStore() ?? UNATTRIBUTED);
  }

  private observe(
    run: () => unknown,
    args: readonly unknown[],
    session: { inTransaction: boolean } | null,
  ): unknown {
    // Callback-style calls are not used by the control plane; leave them untouched.
    if (typeof args[args.length - 1] === "function") return run();
    const cost = this.current();
    const sql = queryText(args);
    const keyword = leadingKeyword(sql);
    cost.roundTrips += 1;
    const begins = keyword === "BEGIN" || keyword === "START";
    // PostgreSQL runs a call outside an explicit block as its own transaction.
    if (begins || !session?.inTransaction) cost.transactions += 1;
    if (session && begins) session.inTransaction = true;
    if (keyword === "COMMIT" || keyword === "END") cost.commits += 1;
    if (keyword === "ROLLBACK") cost.rollbacks += 1;
    if (session && (keyword === "COMMIT" || keyword === "END" || keyword === "ROLLBACK")) session.inTransaction = false;
    const started = performance.now();
    const settle = (result: unknown, failed: boolean) => {
      cost.clientDbMs += performance.now() - started;
      if (failed) {
        cost.errors += 1;
        cost.statements += 1;
      } else {
        cost.statements += Array.isArray(result) ? result.length : 1;
      }
    };
    const returned = run() as Promise<unknown>;
    returned.then(result => settle(result, false), () => settle(undefined, true));
    return returned;
  }

  /** A transparent proxy: `instanceof`, events and pool counters still work. */
  instrument(pool: pg.Pool): pg.Pool {
    const clients = new WeakMap<pg.PoolClient, pg.PoolClient>();
    const wrapClient = (client: pg.PoolClient): pg.PoolClient => {
      const existing = clients.get(client);
      if (existing) return existing;
      const session = { inTransaction: false };
      const proxy = new Proxy(client, {
        get: (target, key) => {
          if (key === "query") {
            return (...args: unknown[]) =>
              this.observe(() => Reflect.apply(target.query, target, args), args, session);
          }
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      clients.set(client, proxy);
      return proxy;
    };
    return new Proxy(pool, {
      get: (target, key) => {
        if (key === "connect") {
          return (...args: unknown[]) => {
            if (typeof args[0] === "function") return Reflect.apply(target.connect, target, args);
            this.current().checkouts += 1;
            return (target.connect() as Promise<pg.PoolClient>).then(wrapClient);
          };
        }
        if (key === "query") {
          return (...args: unknown[]) =>
            this.observe(() => Reflect.apply(target.query, target, args), args, null);
        }
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
}

export function addCost(into: OperationCost, from: OperationCost): void {
  for (const key of Object.keys(into) as (keyof OperationCost)[]) into[key] += from[key];
}

export function percentile(samples: readonly number[], p: number): number {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

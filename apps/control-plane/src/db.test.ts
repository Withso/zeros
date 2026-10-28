import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const pools = vi.hoisted(() => ({ options: [] as Record<string, unknown>[] }));
vi.mock("pg", () => ({
  default: {
    Pool: class extends EventEmitter {
      constructor(options: Record<string, unknown>) {
        super();
        pools.options.push(options);
      }
    },
  },
}));

import { createPool, createMigrationPool, withSystemTx, withUserTx } from "./db.js";

afterEach(() => vi.restoreAllMocks());

describe("database connection resilience", () => {
  it.each(["user", "system"] as const)("OF19 normalizes raw %s pool acquire failure before any callback", async kind => {
    const work = vi.fn();
    for (const error of [new Error("timeout exceeded when trying to connect"), new Error("Connection terminated due to connection timeout")]) {
      const pool = { connect: vi.fn().mockRejectedValue(error) } as unknown as ReturnType<typeof createPool>;
      await expect(kind === "user" ? withUserTx(pool, "user-1", work) : withSystemTx(pool, work))
        .rejects.toMatchObject({ code: "database_acquire_timeout" });
      expect(pool.connect).toHaveBeenCalledOnce();
    }
    for (const code of ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN"]) {
      const pool = { connect: vi.fn().mockRejectedValue(Object.assign(new Error("private-acquire-detail"), { code })) } as unknown as ReturnType<typeof createPool>;
      await expect(kind === "user" ? withUserTx(pool, "user-1", work) : withSystemTx(pool, work))
        .rejects.toMatchObject({ code: "database_acquire_unavailable", message: "Database connection is temporarily unavailable" });
      expect(pool.connect).toHaveBeenCalledOnce();
    }
    expect(work).not.toHaveBeenCalled();
  });

  it("OF19 does not normalize authentication or unknown pool failures", async () => {
    for (const error of [Object.assign(new Error("private-auth-detail"), { code: "28P01" }), new Error("private-unknown-detail")]) {
      const pool = { connect: vi.fn().mockRejectedValue(error) } as unknown as ReturnType<typeof createPool>;
      const work = vi.fn();
      await expect(withSystemTx(pool, work)).rejects.toBe(error);
      expect(work).not.toHaveBeenCalled();
    }
  });

  it("reserves separate bounded pools without giving workers the interactive deadline", async () => {
    createPool("postgres://operator@database.test/zeros", { workload: "api" });
    expect(pools.options.at(-1)).toMatchObject({ max: 6, connectionTimeoutMillis: 1_000, statement_timeout: 5_000 });
    createPool("postgres://operator@database.test/zeros", { workload: "worker" });
    expect(pools.options.at(-1)).toMatchObject({ max: 2, connectionTimeoutMillis: 10_000, statement_timeout: 30_000 });
    createPool("postgres://operator@database.test/zeros", { workload: "retirement-lock" });
    expect(pools.options.at(-1)).toMatchObject({ max: 1, connectionTimeoutMillis: 10_000, statement_timeout: 30_000 });
    createPool("postgres://operator@database.test/zeros", { workload: "advisory-lock" });
    expect(pools.options.at(-1)).toMatchObject({ max: 2, connectionTimeoutMillis: 10_000, statement_timeout: 30_000 });
    createPool("postgres://operator@database.test/zeros", { workload: "listener" });
    expect(pools.options.at(-1)).toMatchObject({ max: 2 });
    createMigrationPool("postgres://operator@database.test/zeros");
    expect(pools.options.at(-1)).toMatchObject({ max: 1, statement_timeout: 30_000 });
  });
  it("never enters a callback when batched role setup fails", async () => {
    const denied = Object.assign(new Error("role denied"), { code: "42501" });
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.includes("SET LOCAL ROLE")) throw denied;
      return { rows: [] };
    }), release: vi.fn() };
    const pool = { connect: async () => client } as unknown as ReturnType<typeof createPool>;
    const work = vi.fn();
    await expect(withSystemTx(pool, work)).rejects.toBe(denied);
    expect(work).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it.each(["error", "end"])(
    "fences an owned transaction on connection %s",
    async (event) => {
      const client = Object.assign(new EventEmitter(), {
        query: vi.fn(async () => ({ rows: [] })),
        release: vi.fn(),
      });
      const pool = {
        connect: vi.fn(async () => client),
      } as unknown as ReturnType<typeof createPool>;
      let emittedError: unknown;
      await expect(
        withSystemTx(pool, async () => {
          try {
            client.emit(event, new Error("private connection details"));
          } catch (error) {
            emittedError = error;
          }
          return "must-not-commit";
        }),
      ).rejects.toMatchObject({ code: "database_connection_lost" });
      expect(emittedError).toBeUndefined();
      expect(client.query).not.toHaveBeenCalledWith("COMMIT");
      expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    },
  );
  it("handles idle connection failures without crashing or disclosing connection details", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const pool = createPool("postgres://private:password@database.test/zeros");
    const error = Object.assign(new Error("private connection string"), {
      code: "57P01",
    });
    expect(() => pool.emit("error", error)).not.toThrow();
    expect(JSON.stringify(log.mock.calls)).not.toContain("private");
    expect(log).toHaveBeenCalled();
  });

  it("bounds connection lifetime and abandoned transactions", () => {
    createPool("postgres://operator@database.test/zeros");
    const options = pools.options.at(-1)!;
    expect(options.maxLifetimeSeconds).toBeGreaterThan(0);
    expect(options.maxLifetimeSeconds).toBeLessThan(86_400);
    expect(options.idle_in_transaction_session_timeout).toBeGreaterThan(0);
  });

  it("opts only the dedicated listener into TCP keepalive without adding SQL polling", () => {
    createPool("postgres://operator@database.test/zeros", { keepAlive: true });
    const listener = pools.options.at(-1)!;
    expect(listener).toMatchObject({ keepAlive: true, keepAliveInitialDelayMillis: 30_000 });
    createPool("postgres://operator@database.test/zeros");
    expect(pools.options.at(-1)!.keepAlive).not.toBe(true);
  });

  it.each(["user", "system"])(
    "destroys a %s connection when rollback fails",
    async (kind) => {
      const failure = new Error("connection lost");
      const query = vi.fn(async (sql: string) => {
        if (sql === "ROLLBACK") throw failure;
        return { rows: [] };
      });
      const client = { query, release: vi.fn() };
      const pool = {
        connect: vi.fn(async () => client),
      } as unknown as ReturnType<typeof createPool>;
      const fn = async () => {
        throw failure;
      };
      await expect(
        kind === "user"
          ? withUserTx(pool, "user-1", fn)
          : withSystemTx(pool, fn),
      ).rejects.toBe(failure);
      expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    },
  );

  it("does not retry a write after an ambiguous commit failure", async () => {
    const failure = new Error("connection lost during commit");
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === "COMMIT") throw failure;
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
    } as unknown as ReturnType<typeof createPool>;
    const write = vi.fn(async () => "written");
    await expect(withSystemTx(pool, write)).rejects.toBe(failure);
    expect(write).toHaveBeenCalledOnce();
  });
});

it('selects migration owner explicitly while application pools discard ambient startup authority',async()=>{
  const {createMigrationPool}=await import('./db.js');
  const url='postgres://operator@database.test/zeros';
  const previous=process.env.PGOPTIONS;process.env.PGOPTIONS='-c role=unexpected';
  try{
    createPool(url);expect(pools.options.at(-1)).toMatchObject({options:'-c role=none',connectionString:'postgres://operator@database.test:5432/zeros'});
    createMigrationPool(url,{role:'postgres'});expect(pools.options.at(-1)).toMatchObject({options:'-c role=postgres'});
    expect(()=>createMigrationPool(url,{role:'postgres -c role=unexpected'})).toThrow(/migration owner/);
  }finally{if(previous===undefined)delete process.env.PGOPTIONS;else process.env.PGOPTIONS=previous;}
});

import { readFileSync } from "node:fs";
import pg from "pg";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { JobRunner } from "./job-runner.js";
import { resetMigratedTestDatabase } from "./test-database.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const d = databaseUrl ? describe : describe.skip;
const source = readFileSync(new URL("./job-queue.integration.test.ts", import.meta.url), "utf8");
const start = source.indexOf('  it("bounds concurrency and claims again as slots free", async () => {');
const bodyStart = source.indexOf("{", start) + 1;
const bodyEnd = source.indexOf('\n  });\n\n  it("wakes on NOTIFY', bodyStart);
if (start < 0 || bodyEnd < bodyStart) throw new Error("concurrency callback not found");
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<void>;
const callback = new AsyncFunction("pool", "runner", "vi", "expect", "KIND", ts.transpileModule(source.slice(bodyStart, bodyEnd), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText);

d("queue concurrency fixture cleanup", () => {
  it("discards the checked-out holder when connection loss makes rollback fail", async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
    const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    const runners: JobRunner[] = [];
    let holder: pg.PoolClient | undefined;
    let releaseCount = 0;
    let releasedWith: unknown;
    let rollbackFailure: unknown;
    let connectionFailure: unknown;
    let ending: Promise<void> | undefined;
    const queries: string[] = [];
    try {
      await resetMigratedTestDatabase(pool);
      pool.on("release", (error, client) => {
        if (client !== holder) return;
        releaseCount += 1;
        releasedWith = error;
      });
      pool.once("acquire", (client: pg.PoolClient) => {
        holder = client;
        client.on("error", (error: Error) => { connectionFailure = error; });
        const query = client.query.bind(client) as (text: string, values?: unknown[]) => Promise<pg.QueryResult>;
        client.query = ((text: string, values?: unknown[]) => {
          queries.push(text);
          if (text === "COMMIT") return (async () => {
            const ended = new Promise<void>(resolve => client.once("end", resolve));
            await admin.query("SELECT pg_terminate_backend($1)", [(client as pg.PoolClient & { processID: number }).processID]);
            await ended;
            return query(text, values);
          })();
          if (text === "ROLLBACK") return query(text, values).catch(error => {
            rollbackFailure = error;
            throw error;
          });
          return query(text, values);
        }) as pg.PoolClient["query"];
      });
      const runner = (options: Omit<ConstructorParameters<typeof JobRunner>[0], "pool">) => {
        const instance = new JobRunner({ pool, pollIntervalMs: 60_000, ...options });
        runners.push(instance);
        return instance;
      };
      const failure = await callback(pool, runner, vi, expect, "test_kind").then(() => undefined, error => error);
      expect(connectionFailure).toBeInstanceOf(Error);
      expect(rollbackFailure).toBeInstanceOf(Error);
      expect(failure).toBe(rollbackFailure);
      expect((failure as Error).message).toContain("not queryable");
      expect(queries.slice(-2)).toEqual(["COMMIT", "ROLLBACK"]);
      await Promise.all(runners.map(instance => instance.stop()));
      ending = pool.end();
      expect(releaseCount).toBe(1);
      expect(releasedWith).toBe(true);
      await ending;
      expect(pool.totalCount).toBe(0);
    } finally {
      if (holder && releaseCount === 0) holder.release(true);
      await Promise.all(runners.map(instance => instance.stop()));
      await Promise.all([ending ?? pool.end(), admin.end()]);
    }
  });
});

// Use Bun's built-in SQLite in the Bun engine; better-sqlite3's native operations require Node.

import BetterSqlite3 from "better-sqlite3";
import { createRequire } from "node:module";
import * as path from "node:path";

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

export interface OpenSqliteOptions {
  readonly?: boolean;
  fileMustExist?: boolean;
}

type AnyFn = (...a: never[]) => unknown;
interface BunStatement {
  run(...a: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...a: unknown[]): unknown;
  all(...a: unknown[]): unknown[];
  finalize?(): void;
}
interface BunDatabase {
  prepare(sql: string): BunStatement;
  exec(sql: string): void;
  transaction<F extends AnyFn>(fn: F): F;
  close(): void;
}

/** Bun expects sigils on named bindings; engine callers use better-sqlite3's bare keys. */
function mapBindArgs(args: unknown[]): unknown[] {
  if (
    args.length === 1 &&
    args[0] !== null &&
    typeof args[0] === "object" &&
    !Array.isArray(args[0])
  ) {
    const src = args[0] as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src))
      out[/^[@$:]/.test(k) ? k : `@${k}`] = src[k];
    return [out];
  }
  return args;
}

function wrapBunStatement(stmt: BunStatement): BunStatement {
  return {
    run: (...a: unknown[]) => stmt.run(...mapBindArgs(a)),
    get: (...a: unknown[]) => stmt.get(...mapBindArgs(a)),
    all: (...a: unknown[]) => stmt.all(...mapBindArgs(a)),
  };
}

/** Bound native statements under polling; finalize on eviction or close instead of waiting for GC. SQLite reprepares on schema changes. */
const MAX_CACHED_STATEMENTS = 256;

function wrapBunDb(db: BunDatabase): BetterSqlite3.Database {
  const stmtCache = new Map<string, BunStatement>();
  const finalize = (stmt: BunStatement | undefined): void => {
    try {
      stmt?.finalize?.();
    } catch {
      /* already finalized / driver without finalize */
    }
  };
  const cachedPrepare = (sql: string): BunStatement => {
    const hit = stmtCache.get(sql);
    if (hit) {
      stmtCache.delete(sql);
      stmtCache.set(sql, hit);
      return hit;
    }
    const stmt = db.prepare(sql);
    stmtCache.set(sql, stmt);
    if (stmtCache.size > MAX_CACHED_STATEMENTS) {
      const oldest = stmtCache.keys().next().value;
      if (oldest !== undefined) {
        finalize(stmtCache.get(oldest));
        stmtCache.delete(oldest);
      }
    }
    return stmt;
  };
  const wrapped = {
    prepare: (sql: string) => wrapBunStatement(cachedPrepare(sql)),
    exec: (sql: string) => db.exec(sql),
    pragma: (s: string) => db.exec(`PRAGMA ${s}`),
    transaction: <F extends AnyFn>(fn: F): F => db.transaction(fn),
    close: () => {
      for (const stmt of stmtCache.values()) finalize(stmt);
      stmtCache.clear();
      db.close();
    },
  };
  return wrapped as unknown as BetterSqlite3.Database;
}

export function openSqlite(
  file: string,
  opts: OpenSqliteOptions = {},
): BetterSqlite3.Database {
  if (isBun) {
    // Compute the Bun module name so Node and tsup do not resolve it; a synthetic absolute parent also works in CommonJS, where import.meta.url is unavailable.
    const req = createRequire(
      path.join(process.cwd(), "__zeros_bun_sqlite_loader__.cjs"),
    );
    const { Database } = req(["bun", "sqlite"].join(":")) as {
      Database: new (path: string, o?: Record<string, boolean>) => BunDatabase;
    };
    const db = new Database(
      file,
      opts.readonly ? { readonly: true } : { create: true },
    );
    return wrapBunDb(db);
  }
  try {
    return new BetterSqlite3(file, {
      readonly: opts.readonly ?? false,
      fileMustExist: opts.fileMustExist ?? false,
    });
  } catch (err) {
    // Replace opaque native ABI mismatches with a rebuild instruction.
    const msg = err instanceof Error ? err.message : String(err);
    if (/NODE_MODULE_VERSION|compiled against a different Node/i.test(msg)) {
      throw new Error(
        `Zeros database engine failed to load — the better-sqlite3 native ` +
          `module was built for a different runtime. Run \`pnpm electron:rebuild\` ` +
          `to rebuild it for Electron, then restart Zeros. (${msg})`,
      );
    }
    throw err;
  }
}

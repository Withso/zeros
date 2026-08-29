// ──────────────────────────────────────────────────────────
// SQLite driver adapter — bun:sqlite under bun, better-sqlite3 under Node
// ──────────────────────────────────────────────────────────
//
// The engine runs under BUN in dev (`bun apps/desktop/src/cli.ts`) and in the bun-compiled
// production binary — but `better-sqlite3` is a Node native addon that bun does
// NOT support (it loads but every op throws "not yet supported in Bun"). So the
// engine's SQLite was silently dead under bun: the unified Zeros DB couldn't be
// created at all, and state.db only survived because workspaces also re-seed from
// disk. This adapter picks the right driver at runtime:
//
//   • bun  → bun:sqlite (built-in; verified: FTS5, json_extract, multi-statement
//            exec, named + positional params, transactions, {changes,...}). A thin
//            wrapper bridges the two API differences:
//              1. no `.pragma()`           → shimmed to exec("PRAGMA …")
//              2. named params need the `@` → `@`-sigil keys; the engine passes
//                 bare keys (better-sqlite3 style), so we prefix them.
//   • Node → better-sqlite3 (vitest, standalone, any non-bun host) — returned
//            as-is (its API is the contract everything else is written against).
//
// Returns a handle typed as better-sqlite3's Database so every caller
// (index.ts, chats.ts, messages.ts, projects.ts, git/state.ts, …) is unchanged.
// ──────────────────────────────────────────────────────────

import BetterSqlite3 from "better-sqlite3";
import { createRequire } from "node:module";
import * as path from "node:path";

/** bun sets a `Bun` global; Node/Electron-main never do. */
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

/** bun:sqlite binds named params by SIGIL-prefixed key (`@name`); the engine
 *  passes bare keys (`name`, better-sqlite3's convention). When a statement is
 *  called with a single plain-object arg, prefix its bare keys with `@`.
 *  Positional args (strings, numbers, arrays, multiple args) pass through. */
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

/** Statements a bun DB handle keeps prepared, keyed by SQL. Every engine call
 *  site does `db.prepare(sql).run(...)` per invocation (better-sqlite3 style);
 *  without a cache each of those allocates a fresh native sqlite3_stmt whose
 *  release then waits on GC — under the engine's steady poll traffic that
 *  accumulates as untracked `external` process memory. Bounded LRU; evicted
 *  and closed statements are finalized eagerly so native memory is released
 *  deterministically. SQLite re-prepares cached statements itself when the
 *  schema changes underneath them, so caching across migrations is safe. */
const MAX_CACHED_STATEMENTS = 256;

/** Wrap a bun:sqlite Database so it quacks like a better-sqlite3 Database for the
 *  subset the engine uses (prepare/exec/pragma/transaction/close). */
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
      // Re-insert to keep Map iteration order = LRU order.
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

/** Open a SQLite database with the runtime-appropriate driver. */
export function openSqlite(
  file: string,
  opts: OpenSqliteOptions = {},
): BetterSqlite3.Database {
  if (isBun) {
    // createRequire works in bun's ESM; the module id is computed so neither tsup
    // nor a Node import graph tries to resolve "bun:sqlite". Give it a stable
    // absolute synthetic parent instead of import.meta.url: this source is also
    // bundled into the CommonJS dev engine and Electron main, where import.meta
    // is empty and makes both builds warn on every start.
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
    // The better-sqlite3 native binding is ABI-locked to the runtime that
    // loads it. This is the Node-only DB path (bun goes through wrapBunDb
    // above), so any Node host opening the DB — vitest/standalone Node, or an
    // Electron process whose ABI differs from the installed binding — needs a
    // binding built for that exact runtime. A plain `pnpm install` builds it
    // for the system Node, so a mismatch throws a cryptic
    // "NODE_MODULE_VERSION X … requires Y" on the FIRST DB open, which the
    // user sees as "Couldn't create workspace". Rethrow with the actual fix.
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

// ──────────────────────────────────────────────────────────
// SQLite driver adapter — bun:sqlite under bun, better-sqlite3 under Node
// ──────────────────────────────────────────────────────────
//
// The engine runs under BUN in dev (`bun src/cli.ts`) and in the bun-compiled
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

/** Wrap a bun:sqlite Database so it quacks like a better-sqlite3 Database for the
 *  subset the engine uses (prepare/exec/pragma/transaction/close). */
function wrapBunDb(db: BunDatabase): BetterSqlite3.Database {
  const wrapped = {
    prepare: (sql: string) => wrapBunStatement(db.prepare(sql)),
    exec: (sql: string) => db.exec(sql),
    pragma: (s: string) => db.exec(`PRAGMA ${s}`),
    transaction: <F extends AnyFn>(fn: F): F => db.transaction(fn),
    close: () => db.close(),
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
    // nor a Node import graph tries to resolve "bun:sqlite". Only runs under bun.
    const req = createRequire(import.meta.url);
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

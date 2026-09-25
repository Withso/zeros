// Release-cut migration runner for one PlanetScale Postgres branch.
//
// Hosted control planes boot with DATABASE_MIGRATIONS_ON_BOOT=false, so a
// release that adds migrations must apply them with the strict runner before
// the new build is promoted (docs/deployment-environments.md). This tool does
// that from an operator workspace with only a PlanetScale service token:
//
//   plan (default)  mint a short-lived owner role, print the pending
//                   migrations, delete the role. Read-only.
//   --execute       take an on-demand backup and wait until it succeeds,
//                   then mint the role and run the strict runner, which
//                   verifies every recorded checksum before applying the
//                   pending migrations; re-plan to confirm none remain, and
//                   delete the role.
//
// The role's password and connection string never leave this process; the
// role also expires on its own if deletion fails. `--execute` must repeat the
// database name in `--confirm`, so a copied command cannot migrate the wrong
// channel. Promote the matching build immediately afterwards: the previous
// build refuses to start against a ledger that records a migration it does
// not know.

import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

import { createMigrationPool } from "./db.js";
import { planMigrations, runMigrations } from "./migrate.js";

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ROLE_TTL_SECONDS = 3600;
const BACKUP_RETENTION_DAYS = 14;
const BACKUP_TIMEOUT_MS = 30 * 60_000;
const BACKUP_POLL_MS = 10_000;

export type PlanetScaleResponse = { status: number; body: unknown };
export type PlanetScaleRequest = (method: "GET" | "POST" | "DELETE", path: string, body?: unknown) => Promise<PlanetScaleResponse>;

export type ReleaseMigrationInput = {
  database: string;
  branch: string;
  execute: boolean;
  confirm?: string;
};

export type ReleaseMigrationDeps = {
  planetScale: PlanetScaleRequest;
  createPool: (databaseUrl: string) => pg.Pool;
  migrator?: {
    plan: typeof planMigrations;
    run: (pool: pg.Pool) => Promise<string[]>;
  };
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
};

export type ReleaseMigrationResult = {
  mode: "plan" | "execute";
  database: string;
  branch: { name: string; production: boolean };
  backup: { id: string; name: string; state: string } | null;
  pendingMigrations: string[];
  controlledApprovals: string[];
  applied: string[];
  /** pending: a plan found unapplied migrations. recorded: a plan found every
   *  migration recorded (checksums are verified by --execute). verified: the
   *  strict runner checked every checksum and nothing remains pending. */
  ledger: "pending" | "recorded" | "verified";
  role: { name: string; deleted: boolean; expiresAt: string | null };
};

type Role = { id: string; name: string; username: string; password: string; access_host_url: string; expires_at?: string | null };

export class ReleaseMigrationError extends Error {}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const stamp = (date: Date) => date.toISOString().slice(0, 19).replace(/[-:T]/g, "");

export function planetScaleClient(options: {
  organization: string;
  tokenId: string;
  token: string;
  fetch?: typeof fetch;
}): PlanetScaleRequest {
  if (!NAME_PATTERN.test(options.organization)) throw new ReleaseMigrationError("PLANETSCALE_ORG is invalid");
  const request = options.fetch ?? fetch;
  const base = `https://api.planetscale.com/v1/organizations/${options.organization}`;
  return async (method, requestPath, body) => {
    const response = await request(base + requestPath, {
      method,
      headers: { authorization: `${options.tokenId}:${options.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    const raw = await response.text();
    let parsed: unknown = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed };
  };
}

/** The owner role's connection string, pinned to the direct port with full
 *  certificate verification, as the migration pool requires. */
export function roleConnectionString(role: Role): string {
  const url = new URL(`postgresql://${role.access_host_url}:5432/postgres`);
  url.username = role.username;
  url.password = role.password;
  url.searchParams.set("sslmode", "verify-full");
  return url.toString();
}

export async function releaseMigration(
  input: ReleaseMigrationInput,
  deps: ReleaseMigrationDeps,
): Promise<ReleaseMigrationResult> {
  if (!NAME_PATTERN.test(input.database) || !NAME_PATTERN.test(input.branch)) {
    throw new ReleaseMigrationError("Database and branch names must be lowercase PlanetScale names");
  }
  if (input.execute && input.confirm !== input.database) {
    throw new ReleaseMigrationError("--execute requires --confirm with the same database name");
  }
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const migrator = deps.migrator ?? { plan: planMigrations, run: (pool: pg.Pool) => runMigrations(pool) };
  const branchPath = `/databases/${input.database}/branches/${input.branch}`;

  const branchResponse = await deps.planetScale("GET", branchPath);
  const branch = record(branchResponse.body);
  if (branchResponse.status !== 200 || branch.name !== input.branch) {
    throw new ReleaseMigrationError(`Cannot read ${input.database}/${input.branch} (HTTP ${branchResponse.status})`);
  }

  let backup: ReleaseMigrationResult["backup"] = null;
  if (input.execute) {
    const requestedName = `release-migration-${stamp(now())}`;
    const created = await deps.planetScale("POST", `${branchPath}/backups`, {
      name: requestedName,
      retention_unit: "day",
      retention_value: BACKUP_RETENTION_DAYS,
    });
    let state = record(created.body);
    const id = text(state.id);
    const backupName = text(state.name) ?? requestedName;
    if (created.status >= 300 || !id) throw new ReleaseMigrationError(`Backup was not created (HTTP ${created.status})`);
    const deadline = now().getTime() + BACKUP_TIMEOUT_MS;
    while (state.state !== "success") {
      if (state.state === "failed" || state.state === "canceled") throw new ReleaseMigrationError(`Backup ${id} ${String(state.state)}`);
      if (now().getTime() > deadline) throw new ReleaseMigrationError(`Backup ${id} did not finish in time`);
      await sleep(BACKUP_POLL_MS);
      const polled = await deps.planetScale("GET", `${branchPath}/backups/${id}`);
      if (polled.status === 200) state = record(polled.body);
    }
    backup = { id, name: backupName, state: "success" };
  }

  const roleName = `zeros-release-migrator-${stamp(now())}`;
  const created = await deps.planetScale("POST", `${branchPath}/roles`, {
    name: roleName,
    inherited_roles: ["postgres"],
    ttl: ROLE_TTL_SECONDS,
  });
  const body = record(created.body);
  const role: Role | null =
    created.status < 300 && text(body.id) && text(body.username) && text(body.password) && text(body.access_host_url)
      ? {
          id: body.id as string,
          name: text(body.name) ?? roleName,
          username: body.username as string,
          password: body.password as string,
          access_host_url: body.access_host_url as string,
          expires_at: text(body.expires_at),
        }
      : null;
  if (!role) throw new ReleaseMigrationError(`Migration role was not created (HTTP ${created.status})`);

  let pendingMigrations: string[] = [];
  let controlledApprovals: string[] = [];
  let applied: string[] = [];
  let ledger: ReleaseMigrationResult["ledger"] = "pending";
  let roleDeleted = false;
  try {
    const pool = deps.createPool(roleConnectionString(role));
    try {
      const plan = await migrator.plan(pool);
      pendingMigrations = plan.pendingMigrations;
      controlledApprovals = plan.controlledApprovals;
      if (input.execute) {
        // Always run: the strict runner verifies every recorded checksum
        // even when nothing is pending.
        applied = await migrator.run(pool);
        const after = await migrator.plan(pool);
        if (after.pendingMigrations.length > 0) {
          throw new ReleaseMigrationError(`Still pending after apply: ${after.pendingMigrations.join(", ")}`);
        }
        ledger = "verified";
      } else if (pendingMigrations.length === 0) {
        ledger = "recorded";
      }
    } finally {
      await pool.end();
    }
  } catch (error) {
    // Never surface a driver message: it can quote the connection string.
    if (error instanceof ReleaseMigrationError) throw error;
    const reason = error instanceof Error && !error.message.includes(role.password) && !error.message.includes(role.username)
      ? error.message
      : "database error";
    throw new ReleaseMigrationError(`Migration step failed: ${reason}`);
  } finally {
    const removed = await deps.planetScale("DELETE", `${branchPath}/roles/${role.id}`).catch(() => ({ status: 0, body: null }));
    role.password = "";
    roleDeleted = removed.status >= 200 && removed.status < 300;
  }

  return {
    mode: input.execute ? "execute" : "plan",
    database: input.database,
    branch: { name: input.branch, production: branch.production === true },
    backup,
    pendingMigrations,
    controlledApprovals,
    applied,
    ledger,
    role: { name: role.name, deleted: roleDeleted, expiresAt: role.expires_at ?? null },
  };
}

export function parseReleaseMigrationArgs(args: string[]): ReleaseMigrationInput {
  const input: ReleaseMigrationInput = { database: "", branch: "main", execute: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const value = args[i + 1];
    if (arg === "--execute") input.execute = true;
    else if ((arg === "--database" || arg === "--branch" || arg === "--confirm") && value && !value.startsWith("--")) {
      if (arg === "--database") input.database = value;
      else if (arg === "--branch") input.branch = value;
      else input.confirm = value;
      i += 1;
    } else throw new ReleaseMigrationError(`Unsupported argument ${arg}`);
  }
  if (!input.database) throw new ReleaseMigrationError("--database is required");
  return input;
}

async function main() {
  const input = parseReleaseMigrationArgs(process.argv.slice(2));
  const organization = process.env.PLANETSCALE_ORG;
  const tokenId = process.env.PLANETSCALE_SERVICE_TOKEN_ID;
  const token = process.env.PLANETSCALE_SERVICE_TOKEN;
  if (!organization || !tokenId || !token) {
    throw new ReleaseMigrationError("PLANETSCALE_ORG, PLANETSCALE_SERVICE_TOKEN_ID and PLANETSCALE_SERVICE_TOKEN are required");
  }
  const result = await releaseMigration(input, {
    planetScale: planetScaleClient({ organization, tokenId, token }),
    createPool: (url) => createMigrationPool(url, { role: "postgres", maxConnections: 1, applicationName: "zeros-release-migrator" }),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void main().catch((error: unknown) => {
    console.error(`[release-migration] ${error instanceof ReleaseMigrationError ? error.message : "failed; inspect the target before retrying"}`);
    process.exitCode = 1;
  });
}

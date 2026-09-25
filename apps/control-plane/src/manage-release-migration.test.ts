import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { describe, expect, it } from "vitest";

import {
  parseReleaseMigrationArgs,
  releaseMigration,
  ReleaseMigrationError,
  roleConnectionString,
  type PlanetScaleRequest,
  type ReleaseMigrationDeps,
} from "./manage-release-migration.js";

const PASSWORD = "fixture-role-password-value";
const BRANCH = "/databases/zeros-control-plane-beta/branches/main";

function harness(options: {
  pending?: string[];
  backupStates?: string[];
  pendingAfter?: string[];
  runError?: Error;
  deleteStatus?: number;
  roleStatus?: number;
} = {}) {
  const calls: string[] = [];
  const backupStates = [...(options.backupStates ?? ["pending", "success"])];
  const planetScale: PlanetScaleRequest = async (method, path, body) => {
    calls.push(`${method} ${path}`);
    if (method === "GET" && path === BRANCH) return { status: 200, body: { name: "main", production: true } };
    if (method === "POST" && path === `${BRANCH}/backups`) {
      return { status: 201, body: { id: "bk1", name: (body as { name: string }).name, state: backupStates.shift() } };
    }
    if (method === "GET" && path === `${BRANCH}/backups/bk1`) return { status: 200, body: { id: "bk1", state: backupStates.shift() } };
    if (method === "POST" && path === `${BRANCH}/roles`) {
      return options.roleStatus
        ? { status: options.roleStatus, body: null }
        : {
            status: 201,
            body: {
              id: "role1",
              name: (body as { name: string }).name,
              username: "migrator.fixture",
              password: PASSWORD,
              access_host_url: "aws-us-west-2-1.pg.psdb.cloud",
              expires_at: "2026-09-25T12:00:00.000Z",
            },
          };
    }
    if (method === "DELETE" && path === `${BRANCH}/roles/role1`) return { status: options.deleteStatus ?? 204, body: null };
    throw new Error(`unexpected ${method} ${path}`);
  };
  let poolUrl = "";
  const deps: ReleaseMigrationDeps = {
    planetScale,
    createPool: (url) => {
      poolUrl = url;
      calls.push("pool");
      return { end: async () => void calls.push("pool.end") } as unknown as pg.Pool;
    },
    migrator: {
      plan: async () => {
        calls.push("plan");
        const first = !calls.includes("run");
        return { pendingMigrations: first ? options.pending ?? [] : options.pendingAfter ?? [], controlledApprovals: [] };
      },
      run: async () => {
        calls.push("run");
        if (options.runError) throw options.runError;
        return options.pending ?? [];
      },
    },
    now: () => new Date("2026-09-25T10:00:00Z"),
    sleep: async () => undefined,
  };
  return { calls, deps, poolUrl: () => poolUrl };
}

describe("release migration runner", () => {
  it("plans read-only with a short-lived role and always deletes the role", async () => {
    const { calls, deps, poolUrl } = harness();
    const result = await releaseMigration({ database: "zeros-control-plane-beta", branch: "main", execute: false }, deps);

    expect(calls).toEqual([`GET ${BRANCH}`, `POST ${BRANCH}/roles`, "pool", "plan", "pool.end", `DELETE ${BRANCH}/roles/role1`]);
    expect(result).toMatchObject({ mode: "plan", backup: null, pendingMigrations: [], ledger: "recorded", applied: [] });
    expect(result.role).toEqual({ name: "zeros-release-migrator-20260925100000", deleted: true, expiresAt: "2026-09-25T12:00:00.000Z" });
    expect(new URL(poolUrl()).searchParams.get("sslmode")).toBe("verify-full");
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
  });

  it("reports pending migrations in a plan without applying them", async () => {
    const { calls, deps } = harness({ pending: ["0101_next.sql"] });
    const result = await releaseMigration({ database: "zeros-control-plane-beta", branch: "main", execute: false }, deps);

    expect(calls).not.toContain("run");
    expect(calls.some((call) => call.includes("/backups"))).toBe(false);
    expect(result).toMatchObject({ pendingMigrations: ["0101_next.sql"], ledger: "pending" });
  });

  it("refuses to execute unless --confirm repeats the database", async () => {
    const { calls, deps } = harness();
    await expect(releaseMigration({ database: "zeros-control-plane-beta", branch: "main", execute: true, confirm: "zeros-control-plane-production" }, deps))
      .rejects.toThrow(ReleaseMigrationError);
    expect(calls).toEqual([]);
  });

  it("backs up and waits for success before minting the role, then applies and re-plans", async () => {
    const { calls, deps } = harness({ pending: ["0101_next.sql"], backupStates: ["pending", "running", "success"] });
    const result = await releaseMigration(
      { database: "zeros-control-plane-beta", branch: "main", execute: true, confirm: "zeros-control-plane-beta" },
      deps,
    );

    expect(calls).toEqual([
      `GET ${BRANCH}`,
      `POST ${BRANCH}/backups`,
      `GET ${BRANCH}/backups/bk1`,
      `GET ${BRANCH}/backups/bk1`,
      `POST ${BRANCH}/roles`,
      "pool",
      "plan",
      "run",
      "plan",
      "pool.end",
      `DELETE ${BRANCH}/roles/role1`,
    ]);
    expect(result).toMatchObject({
      mode: "execute",
      backup: { id: "bk1", name: "release-migration-20260925100000", state: "success" },
      applied: ["0101_next.sql"],
      ledger: "verified",
    });
  });

  it("runs the strict runner even when nothing is pending, so every checksum is verified", async () => {
    const { calls, deps } = harness();
    const result = await releaseMigration(
      { database: "zeros-control-plane-beta", branch: "main", execute: true, confirm: "zeros-control-plane-beta" },
      deps,
    );
    expect(calls.filter((call) => call === "run")).toHaveLength(1);
    expect(result).toMatchObject({ applied: [], ledger: "verified" });
  });

  it("fails when migrations remain pending after the runner", async () => {
    const { calls, deps } = harness({ pending: ["0101_next.sql"], pendingAfter: ["0101_next.sql"] });
    await expect(releaseMigration(
      { database: "zeros-control-plane-beta", branch: "main", execute: true, confirm: "zeros-control-plane-beta" },
      deps,
    )).rejects.toThrow("Still pending after apply: 0101_next.sql");
    expect(calls.at(-1)).toBe(`DELETE ${BRANCH}/roles/role1`);
  });

  it("never mints a role when the backup fails", async () => {
    const { calls, deps } = harness({ backupStates: ["pending", "failed"] });
    await expect(releaseMigration(
      { database: "zeros-control-plane-beta", branch: "main", execute: true, confirm: "zeros-control-plane-beta" },
      deps,
    )).rejects.toThrow("Backup bk1 failed");
    expect(calls.some((call) => call.endsWith("/roles"))).toBe(false);
  });

  it("deletes the role and hides driver details when a migration fails", async () => {
    const { calls, deps } = harness({ pending: ["0101_next.sql"], runError: new Error(`password authentication failed for migrator.fixture (${PASSWORD})`) });
    const failure = await releaseMigration(
      { database: "zeros-control-plane-beta", branch: "main", execute: true, confirm: "zeros-control-plane-beta" },
      deps,
    ).catch((error: unknown) => error as Error);

    expect(failure).toBeInstanceOf(ReleaseMigrationError);
    expect(failure.message).toBe("Migration step failed: database error");
    expect(calls.slice(-2)).toEqual(["pool.end", `DELETE ${BRANCH}/roles/role1`]);
  });

  it("reports a role that could not be deleted with its expiry", async () => {
    const { deps } = harness({ deleteStatus: 500 });
    const result = await releaseMigration({ database: "zeros-control-plane-beta", branch: "main", execute: false }, deps);
    expect(result.role).toMatchObject({ deleted: false, expiresAt: "2026-09-25T12:00:00.000Z" });
  });

  it("stops when PlanetScale refuses the role", async () => {
    const { calls, deps } = harness({ roleStatus: 403 });
    await expect(releaseMigration({ database: "zeros-control-plane-beta", branch: "main", execute: false }, deps))
      .rejects.toThrow("Migration role was not created (HTTP 403)");
    expect(calls).not.toContain("pool");
  });

  it("builds a direct, fully verified connection string for the role", () => {
    const url = new URL(roleConnectionString({ id: "r", name: "n", username: "u.x", password: "p@ss/word", access_host_url: "db.example" }));
    expect(url.port).toBe("5432");
    expect(url.pathname).toBe("/postgres");
    expect(url.searchParams.get("sslmode")).toBe("verify-full");
    expect(decodeURIComponent(url.password)).toBe("p@ss/word");
  });

  it("parses only the supported arguments", () => {
    expect(parseReleaseMigrationArgs(["--database", "zeros-control-plane-beta"])).toEqual({ database: "zeros-control-plane-beta", branch: "main", execute: false });
    expect(parseReleaseMigrationArgs(["--database", "db", "--branch", "main", "--execute", "--confirm", "db"]))
      .toEqual({ database: "db", branch: "main", execute: true, confirm: "db" });
    expect(() => parseReleaseMigrationArgs([])).toThrow("--database is required");
    expect(() => parseReleaseMigrationArgs(["--database", "db", "--force"])).toThrow("Unsupported argument --force");
    expect(() => parseReleaseMigrationArgs(["--database", "--execute"])).toThrow("Unsupported argument --database");
  });

  it("refuses to run without PlanetScale credentials", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./manage-release-migration.ts", import.meta.url)), "--database", "zeros-control-plane-beta"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { PATH: process.env.PATH },
      timeout: 20_000,
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[release-migration] PLANETSCALE_ORG, PLANETSCALE_SERVICE_TOKEN_ID and PLANETSCALE_SERVICE_TOKEN are required");
  });
});

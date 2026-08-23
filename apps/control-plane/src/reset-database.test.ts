import { describe, expect, it, vi } from "vitest";
import type pg from "pg";

import {
  resetApprovalText,
  resetTargetFingerprint,
  resetPublicSchema,
  validateResetRequest,
} from "./reset-database.js";

const DATABASE_URL =
  "postgres://reset_user:secret-password@127.0.0.1:5432/zeros_alpha?sslmode=require";

describe("clean database reset safety", () => {
  it("derives a stable non-secret fingerprint instead of displaying the URL", () => {
    const fingerprint = resetTargetFingerprint(DATABASE_URL, "alpha");
    expect(fingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(fingerprint).toBe(resetTargetFingerprint(DATABASE_URL, "alpha"));
    expect(fingerprint).not.toContain("secret-password");
    expect(resetTargetFingerprint(DATABASE_URL, "beta")).not.toBe(
      fingerprint,
    );
  });

  it("allows a dry-run plan without destructive approval", () => {
    expect(
      validateResetRequest({
        databaseUrl: DATABASE_URL,
        channel: "alpha",
        railwayEnvironmentName: "alpha",
        execute: false,
      }),
    ).toMatchObject({ channel: "alpha", execute: false });
  });

  it("refuses production and cross-channel Railway targets", () => {
    expect(() =>
      validateResetRequest({
        databaseUrl: DATABASE_URL,
        channel: "production",
        railwayEnvironmentName: "production",
        execute: false,
      }),
    ).toThrow(/fresh database/);

    expect(() =>
      validateResetRequest({
        databaseUrl: DATABASE_URL,
        channel: "alpha",
        railwayEnvironmentName: "beta",
        execute: false,
      }),
    ).toThrow(/does not match/);
  });

  it("requires backup confirmation and exact target-bound approval to execute", () => {
    const fingerprint = resetTargetFingerprint(DATABASE_URL, "alpha");
    const base = {
      databaseUrl: DATABASE_URL,
      channel: "alpha",
      railwayEnvironmentName: "alpha",
      execute: true,
    } as const;

    expect(() => validateResetRequest(base)).toThrow(
      /CONTROL_PLANE_RESET_BACKUP_CONFIRMED/,
    );
    expect(() =>
      validateResetRequest({
        ...base,
        backupConfirmed: "true",
        approval: "reset:alpha:wrong-target",
      }),
    ).toThrow(/CONTROL_PLANE_RESET_APPROVAL/);

    expect(
      validateResetRequest({
        ...base,
        backupConfirmed: "true",
        approval: resetApprovalText("alpha", fingerprint),
      }),
    ).toEqual({ channel: "alpha", execute: true, fingerprint });
  });
});

describe("resetPublicSchema", () => {
  it("drops and recreates public transactionally before replaying migrations", async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql.replace(/\s+/g, " ").trim());
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
    } as unknown as pg.Pool;
    const migrate = vi.fn(async () => ["0001_init.sql"]);

    await expect(resetPublicSchema(pool, migrate)).resolves.toEqual([
      "0001_init.sql",
    ]);
    expect(queries).toEqual([
      "BEGIN",
      "SET LOCAL lock_timeout = '10s'",
      "SET LOCAL statement_timeout = '60s'",
      "DROP SCHEMA public CASCADE",
      "CREATE SCHEMA public",
      "COMMIT",
    ]);
    expect(client.release).toHaveBeenCalledOnce();
    expect(migrate).toHaveBeenCalledWith(pool);
  });

  it("rolls back, releases the client, and never migrates after a reset failure", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === "DROP SCHEMA public CASCADE") {
          throw new Error("database refused reset");
        }
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
    } as unknown as pg.Pool;
    const migrate = vi.fn(async () => [] as string[]);

    await expect(resetPublicSchema(pool, migrate)).rejects.toThrow(
      /Database reset failed/,
    );
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
    expect(migrate).not.toHaveBeenCalled();
  });
});

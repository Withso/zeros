import { readFileSync, readdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertAllControlledMigrationsApproved,
  assertMigrationApproved,
  migrationChecksum,
  runMigrations,
  verifyMigrations,
} from "./migrate.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    readdir: vi.fn(original.readdir),
    readFile: vi.fn(original.readFile),
  };
});

const directory = new URL("../migrations/", import.meta.url);
const files = readdirSync(directory)
  .filter((file) => /^\d{4}_.+\.sql$/.test(file))
  .sort();
const ledger = files.map((name) => ({
  name,
  checksum: migrationChecksum(readFileSync(new URL(name, directory), "utf8")),
  phase: "legacy",
}));

function database(
  rows: Array<{ name: string; checksum: string; phase: string }>,
  initialPhaseColumn = true,
) {
  let phaseColumn = initialPhaseColumn;
  const query = vi.fn(
    async (text: string, _parameters?: readonly unknown[]) => {
      if (text === "SHOW statement_timeout")
        return { rows: [{ statement_timeout: "30s" }] };
      if (/SELECT\s+name,\s*checksum/.test(text)) return { rows };
      if (/ADD COLUMN phase text/.test(text)) phaseColumn = true;
      if (/AS phase_supported/.test(text))
        return { rows: [{ phase_supported: phaseColumn }] };
      return { rows: [] };
    },
  );
  const client = { query, release: vi.fn() };
  const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;
  return { pool, query };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.useRealTimers();
});

describe("expand/contract schema compatibility", () => {
  it("lets an older API boot against only newer expand rows and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { pool, query } = database([
      ...ledger,
      {
        name: "9999_future_expand.sql",
        checksum: `sha256:${"a".repeat(64)}`,
        phase: "expand",
      },
    ]);
    await expect(verifyMigrations(pool)).resolves.toEqual({
      ran: [],
      status: { state: "current" },
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(
      query.mock.calls.every(
        ([text]) => !/^(INSERT|UPDATE|ALTER|CREATE)/.test(text),
      ),
    ).toBe(true);
  });

  it.each(["contract", "legacy", "unexpected"])(
    "rejects an unknown newer %s row",
    async (phase) => {
      const { pool } = database([
        ...ledger,
        {
          name: "9999_future.sql",
          checksum: `sha256:${"b".repeat(64)}`,
          phase,
        },
      ]);
      await expect(verifyMigrations(pool)).rejects.toThrow(
        /unknown.*migration|migration.*unknown/i,
      );
    },
  );

  it("does not treat an unknown historical expand row as forward compatibility", async () => {
    const { pool } = database([
      ...ledger,
      {
        name: "0001_unknown_expand.sql",
        checksum: `sha256:${"c".repeat(64)}`,
        phase: "expand",
      },
    ]);
    await expect(verifyMigrations(pool)).rejects.toThrow(
      /unknown.*migration|migration.*unknown/i,
    );
  });

  it("retains known-file checksum and pending-file enforcement with newer expand rows", async () => {
    const newer = {
      name: "9999_future_expand.sql",
      checksum: `sha256:${"d".repeat(64)}`,
      phase: "expand",
    };
    await expect(
      verifyMigrations(
        database([
          { ...ledger[0]!, checksum: "changed" },
          ...ledger.slice(1),
          newer,
        ]).pool,
      ),
    ).rejects.toThrow(/checksum/);
    await expect(
      verifyMigrations(database([...ledger.slice(0, -1), newer]).pool),
    ).rejects.toThrow(/pending/);
  });

  it("keeps the explicit migrator strict against unknown expand rows", async () => {
    const { pool } = database([
      ...ledger,
      {
        name: "9999_future_expand.sql",
        checksum: `sha256:${"e".repeat(64)}`,
        phase: "expand",
      },
    ]);
    await expect(runMigrations(pool)).rejects.toThrow(
      /unknown.*migration|migration.*unknown/i,
    );
  });

  it("records declared expand phases while preserving legacy insert compatibility", async () => {
    const file = "0122_migration_phases.sql",
      sql =
        "-- zeros-migration: expand\nALTER TABLE schema_migrations ADD COLUMN phase text NOT NULL DEFAULT 'legacy';";
    vi.mocked(fs.readdir).mockResolvedValue([...files, file] as never);
    vi.mocked(fs.readFile).mockImplementation(((path: unknown) =>
      String(path).endsWith(file)
        ? Promise.resolve(sql)
        : Promise.resolve(
            readFileSync(path as string, "utf8"),
          )) as typeof fs.readFile);
    const { pool, query } = database([], false);
    await runMigrations(pool);
    const inserts = query.mock.calls.filter(([text]) =>
      text.startsWith("INSERT INTO schema_migrations"),
    );
    expect(
      inserts.find(
        ([, parameters]) => parameters?.[0] === "0001_init.sql",
      )?.[1],
    ).toHaveLength(2);
    expect(
      inserts.find(
        ([, parameters]) => parameters?.[0] === "0122_migration_phases.sql",
      )?.[1],
    ).toEqual([file, migrationChecksum(sql), "expand"]);
  });

  it("migrates a declared expansion on the Step A ledger without a phase column", async () => {
    const file = "0122_additive.sql",
      sql = "-- zeros-migration: expand\nSELECT 1;";
    vi.mocked(fs.readdir).mockResolvedValue([...files, file] as never);
    vi.mocked(fs.readFile).mockImplementation(((path: unknown) =>
      String(path).endsWith(file)
        ? Promise.resolve(sql)
        : Promise.resolve(
            readFileSync(path as string, "utf8"),
          )) as typeof fs.readFile);
    const { pool, query } = database(ledger, false);
    await expect(runMigrations(pool)).resolves.toEqual([file]);
    expect(
      query.mock.calls.find(([text]) =>
        text.startsWith("INSERT INTO schema_migrations"),
      )?.[1],
    ).toEqual([file, migrationChecksum(sql)]);
  });

  it("refuses a contract migration before its declared UTC date even outside production", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-30T23:59:59Z"));
    const sql =
      "-- zeros-migration: contract\n-- zeros-contract-after: 2026-10-31\nALTER TABLE example DROP COLUMN retired;";
    expect(() =>
      assertMigrationApproved("0123_contract.sql", sql, {
        NODE_ENV: "development",
      }),
    ).toThrow(/contract.*2026-10-31/i);
    vi.setSystemTime(new Date("2026-10-31T00:00:00Z"));
    expect(() =>
      assertMigrationApproved("0123_contract.sql", sql, {
        NODE_ENV: "production",
      }),
    ).not.toThrow();
  });

  it("preflights a future contract before applying any pending migration", async () => {
    const expandFile = "9998_pending_expand.sql",
      contractFile = "9999_pending_contract.sql";
    const expandSql =
      "-- zeros-migration: expand\nALTER TABLE example ADD COLUMN extra text;";
    const contractSql =
      "-- zeros-migration: contract\n-- zeros-contract-after: 2099-01-01\nALTER TABLE example DROP COLUMN retired;";
    const originalRead = fs.readFile;
    vi.mocked(fs.readdir).mockResolvedValue([
      ...files,
      expandFile,
      contractFile,
    ] as never);
    vi.mocked(fs.readFile).mockImplementation(((
      file: unknown,
      options: unknown,
    ) => {
      const name = String(file);
      if (name.endsWith(expandFile)) return Promise.resolve(expandSql);
      if (name.endsWith(contractFile)) return Promise.resolve(contractSql);
      return readFileSync(file as string, options as "utf8");
    }) as typeof originalRead);
    const { pool, query } = database(ledger);
    await expect(
      assertAllControlledMigrationsApproved({ NODE_ENV: "development" }),
    ).rejects.toThrow(/contract.*2099-01-01/i);
    await expect(
      runMigrations(pool, { env: { NODE_ENV: "production" } }),
    ).rejects.toThrow(/contract.*2099-01-01/i);
    expect(
      query.mock.calls.some(
        ([text]) =>
          text === expandSql ||
          text === contractSql ||
          text.startsWith("INSERT INTO schema_migrations"),
      ),
    ).toBe(false);
  });

  it("records a contract phase when its not-before date has passed", async () => {
    const contractFile = "9999_ready_contract.sql",
      contractSql =
        "-- zeros-migration: contract\n-- zeros-contract-after: 2000-01-01\nALTER TABLE example DROP COLUMN retired;";
    vi.mocked(fs.readdir).mockResolvedValue([...files, contractFile] as never);
    vi.mocked(fs.readFile).mockImplementation(((file: unknown) =>
      String(file).endsWith(contractFile)
        ? Promise.resolve(contractSql)
        : Promise.resolve(
            readFileSync(file as string, "utf8"),
          )) as typeof fs.readFile);
    const { pool, query } = database(ledger);
    await expect(
      runMigrations(pool, { env: { NODE_ENV: "production" } }),
    ).resolves.toEqual([contractFile]);
    expect(
      query.mock.calls.find(([text]) =>
        text.startsWith("INSERT INTO schema_migrations"),
      )?.[1],
    ).toEqual([contractFile, migrationChecksum(contractSql), "contract"]);
  });
});

import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import pg from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  migrationChecksum,
  planMigrations,
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
  .filter(
    (file) => /^\d{4}_.+\.sql$/.test(file) && Number(file.slice(0, 4)) <= 121,
  )
  .sort();
const sources = new Map(
  files.map((file) => [file, readFileSync(new URL(file, directory), "utf8")]),
);
const phasedFile = "0122_migration_phases.sql";
const phasedSql =
  "-- zeros-migration: expand\nSET LOCAL lock_timeout = '5s';\nALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS phase text NOT NULL DEFAULT 'legacy';";
function packaged(extra = new Map<string, string>()) {
  vi.mocked(fs.readdir).mockResolvedValue([...files, ...extra.keys()] as never);
  vi.mocked(fs.readFile).mockImplementation(((file: unknown) => {
    const name = String(file).split("/").at(-1)!;
    return Promise.resolve(extra.get(name) ?? sources.get(name));
  }) as typeof fs.readFile);
}

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("phase bridge on a real PostgreSQL ledger", () => {
  const name = `p1_phases_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Pool, pool: pg.Pool;
  beforeAll(async () => {
    admin = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 1,
    });
    await admin.query(
      "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zeros_app') THEN CREATE ROLE zeros_app NOLOGIN NOBYPASSRLS; END IF; END $$",
    );
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.pathname = `/${name}`;
    pool = new pg.Pool({ connectionString: url.href, max: 1 });
  });
  beforeEach(async () => {
    packaged();
    await pool.query(
      "DROP TABLE IF EXISTS public.schema_migrations; CREATE TABLE public.schema_migrations (name text PRIMARY KEY, checksum text, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    await pool.query(
      "GRANT USAGE ON SCHEMA public TO zeros_app; GRANT SELECT ON public.schema_migrations TO zeros_app",
    );
    for (const [file, sql] of sources)
      await pool.query(
        "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
        [file, migrationChecksum(sql)],
      );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });
  afterAll(async () => {
    await pool?.end();
    try {
      await admin?.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally {
      await admin?.end();
    }
  });

  it("boots and migrates the unchanged 0121 ledger without requiring or creating phase", async () => {
    expect(await verifyMigrations(pool)).toEqual({
      ran: [],
      status: { state: "current" },
    });
    expect(await runMigrations(pool)).toEqual([]);
    expect(
      (
        await pool.query(
          "SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.schema_migrations'::regclass AND attname = 'phase' AND NOT attisdropped) AS present",
        )
      ).rows[0].present,
    ).toBe(false);
  });
  it("records 0122's phase after adding the column, then permits only expand rollback boot", async () => {
    packaged(new Map([[phasedFile, phasedSql]]));
    expect(await runMigrations(pool)).toEqual([phasedFile]);
    expect(await runMigrations(pool)).toEqual([]);
    expect(
      (
        await pool.query(
          "SELECT phase FROM schema_migrations WHERE name = $1",
          [phasedFile],
        )
      ).rows[0].phase,
    ).toBe("expand");
    expect(
      Number(
        (
          await pool.query(
            "SELECT count(*) AS total FROM schema_migrations WHERE phase = 'legacy'",
          )
        ).rows[0].total,
      ),
    ).toBe(121);
    packaged();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await verifyMigrations(pool)).toEqual({
      ran: [],
      status: { state: "current" },
    });
    expect(warn).toHaveBeenCalledOnce();
    await expect(runMigrations(pool)).rejects.toThrow(/unknown migration/);
    await pool.query(
      "UPDATE schema_migrations SET phase = 'contract' WHERE name = $1",
      [phasedFile],
    );
    await expect(verifyMigrations(pool)).rejects.toThrow(/unknown migration/);
  });
  it("refuses an early contract before its SQL or a ledger row is committed", async () => {
    const contractFile = "0123_future_contract.sql";
    packaged(
      new Map([
        [
          contractFile,
          "-- zeros-migration: contract\n-- zeros-contract-after: 2099-01-01\nDROP TABLE schema_migrations;",
        ],
      ]),
    );
    expect((await planMigrations(pool)).controlledApprovals).toEqual([
      contractFile,
    ]);
    await expect(
      runMigrations(pool, {
        env: {
          NODE_ENV: "production",
          CONTROL_PLANE_MIGRATION_APPROVALS: contractFile,
        },
      }),
    ).rejects.toThrow(/2099-01-01/);
    expect(
      Number(
        (await pool.query("SELECT count(*) AS total FROM schema_migrations"))
          .rows[0].total,
      ),
    ).toBe(121);
  });
});

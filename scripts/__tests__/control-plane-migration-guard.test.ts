import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const GUARD = path.join(
  REPOSITORY_ROOT,
  "scripts/check-control-plane-migrations.mjs",
);

const temporaryRepositories: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function createLegacyLayoutRepository(): string {
  const cwd = mkdtempSync(path.join(tmpdir(), "zeros-migration-guard-"));
  temporaryRepositories.push(cwd);

  mkdirSync(path.join(cwd, "backend/migrations"), { recursive: true });
  writeFileSync(
    path.join(cwd, "backend/migrations/0001_init.sql"),
    "CREATE TABLE example (id integer);\n",
  );
  git(cwd, "init", "--quiet");
  git(cwd, "config", "user.name", "Migration Guard Test");
  git(cwd, "config", "user.email", "migration-guard@invalid.example");
  git(cwd, "add", ".");
  git(cwd, "commit", "--quiet", "-m", "legacy migration layout");
  git(cwd, "update-ref", "refs/remotes/origin/main", "HEAD");

  mkdirSync(path.join(cwd, "apps/control-plane/migrations"), {
    recursive: true,
  });
  writeFileSync(
    path.join(cwd, "apps/control-plane/migrations/0001_init.sql"),
    "CREATE TABLE example (id bigint);\n",
  );

  return cwd;
}

function createCurrentLayoutRepository(sql: string): string {
  const cwd = mkdtempSync(path.join(tmpdir(), "zeros-migration-guard-"));
  temporaryRepositories.push(cwd);

  mkdirSync(path.join(cwd, "apps/control-plane/migrations"), {
    recursive: true,
  });
  writeFileSync(
    path.join(cwd, "apps/control-plane/migrations/0001_init.sql"),
    sql,
  );
  git(cwd, "init", "--quiet");

  return cwd;
}

afterEach(() => {
  for (const cwd of temporaryRepositories.splice(0)) {
    rmSync(cwd, { recursive: true, force: true });
  }
});

describe("control-plane migration guard", () => {
  it("rejects an edited migration when origin/main still uses the legacy backend path", () => {
    const cwd = createLegacyLayoutRepository();
    const result = spawnSync(process.execPath, [GUARD], {
      cwd,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("migration 0001_init.sql was EDITED");
  });

  it("rejects top-level transaction control inside a migration", () => {
    const cwd = createCurrentLayoutRepository(
      "BEGIN;\nCREATE TABLE example (id integer);\nCOMMIT;\n",
    );
    const result = spawnSync(process.execPath, [GUARD], {
      cwd,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "0001_init.sql contains top-level transaction control BEGIN",
    );
  });

  it("allows transaction words inside comments, strings, and PL/pgSQL bodies", () => {
    const cwd = createCurrentLayoutRepository(`
-- BEGIN and COMMIT here are documentation, not statements.
CREATE TABLE example (value text DEFAULT 'ROLLBACK;');
DO $body$
BEGIN
  INSERT INTO example (value) VALUES ('COMMIT;');
END
$body$;
`);
    const result = spawnSync(process.execPath, [GUARD], {
      cwd,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
  });

  it.each([
    "SELECT '\\'; COMMIT;\n",
    'CREATE TABLE "quoted\\" (id integer); COMMIT;\n',
  ])("does not let a backslash hide transaction control in %s", (sql) => {
    const cwd = createCurrentLayoutRepository(sql);
    const result = spawnSync(process.execPath, [GUARD], {
      cwd,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "0001_init.sql contains top-level transaction control COMMIT",
    );
  });

  it("allows transaction words escaped inside an E-prefixed string", () => {
    const cwd = createCurrentLayoutRepository(
      String.raw`SELECT E'escaped\' COMMIT'; SELECT 1;`,
    );
    const result = spawnSync(process.execPath, [GUARD], {
      cwd,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
  });
});

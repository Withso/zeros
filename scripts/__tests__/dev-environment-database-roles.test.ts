import { describe, expect, it } from "vitest";
import { ensureDevelopmentRoles } from "../dev-environment/postgres.mjs";

const workspace = { state: { database: { migrationPassword: "migration-fixture-value", runtimePassword: "runtime-fixture-value" } } };

function admin({ existing = [] as string[], unsafe = 0 } = {}) {
  const statements: string[] = [];
  return {
    statements,
    async query(sql: string, params: unknown[] = []) {
      if (sql.startsWith("SELECT format(")) return { rows: [{ sql: `CREATE ROLE ${params[0]} ${params[2]} PASSWORD 'withheld'` }] };
      statements.push(sql);
      if (sql.startsWith("SELECT rolname FROM pg_roles WHERE rolname = ANY($1) AND")) return { rowCount: unsafe, rows: [] };
      if (sql.startsWith("SELECT rolname FROM pg_roles")) return { rows: existing.map(rolname => ({ rolname })) };
      return { rows: [], rowCount: 0 };
    },
  };
}

describe("electron:cloud database roles", () => {
  // Hosted schema owners bypass RLS (Alpha's is `postgres`), and SECURITY
  // DEFINER helpers such as app_user_org_ids() rely on it: under FORCE RLS a
  // non-bypassing owner re-enters the policy until the stack overflows.
  it("gives the schema owner hosted's RLS bypass and keeps request roles bound by RLS", async () => {
    const fresh = admin();
    await ensureDevelopmentRoles(fresh, workspace);
    expect(fresh.statements).toContain("CREATE ROLE zeros_dev_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS PASSWORD 'withheld'");
    expect(fresh.statements).toContain("CREATE ROLE zeros_dev_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD 'withheld'");
    expect(fresh.statements).toContain("CREATE ROLE zeros_app NOLOGIN NOSUPERUSER NOBYPASSRLS");
  });

  it("upgrades an existing checkout's owner in place without touching its data", async () => {
    const existing = admin({ existing: ["zeros_app", "zeros_dev_migrator", "zeros_dev_runtime"] });
    await ensureDevelopmentRoles(existing, workspace);
    expect(existing.statements).toContain("ALTER ROLE zeros_dev_migrator BYPASSRLS");
    expect(existing.statements.some(sql => /^CREATE ROLE|DROP|ALTER ROLE zeros_dev_runtime|ALTER ROLE zeros_app/.test(sql))).toBe(false);
  });

  it("refuses superuser, role or database creation, and any request role that bypasses RLS", async () => {
    await expect(ensureDevelopmentRoles(admin({ unsafe: 1 }), workspace)).rejects.toThrow("Dev database role authority has changed");
  });
});

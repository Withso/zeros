import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { lintMigrationPhase } from "../check-migration-phases";

const file = "0250_cloud_workspace_recovery.sql";
const sql = readFileSync(`apps/control-plane/migrations/${file}`, "utf8");

it("permits the exact reviewed recovery expansion", () => {
  expect(createHash("sha256").update(sql).digest("hex"))
    .toBe("bccb3a402c3ed3c6dbbe3340840c90eefcdcd321d831edb4ca95d99fa6ddc2f3");
  expect(lintMigrationPhase(file, sql)).toEqual([]);
});

it.each(["guard_cloud_v2_recovery_workspace", "notify_cloud_v2_recovery"])("rejects an unreviewed privilege change for %s", name => {
  const statement = `REVOKE ALL ON FUNCTION ${name}() FROM PUBLIC;`;
  expect(sql).toContain(statement);
  expect(lintMigrationPhase(file, sql.replace(statement, statement.replace("PUBLIC", "zeros_app"))).length).toBeGreaterThan(0);
});

it("requires both annotations and refuses another filename or destructive append", () => {
  const annotations = [...sql.matchAll(/^-- zeros-expand-exception:[^\n]+\n/gm)];
  expect(annotations).toHaveLength(2);
  for (const [annotation] of annotations)
    expect(lintMigrationPhase(file, sql.replace(annotation, "")).length).toBeGreaterThan(0);
  expect(lintMigrationPhase("0250_unreviewed.sql", sql).length).toBeGreaterThan(0);
  expect(lintMigrationPhase(file, `${sql}\nDELETE FROM cloud_v2_workspaces;`).length).toBeGreaterThan(0);
});

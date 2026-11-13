import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { lintMigrationPhase } from "../check-migration-phases";

const file = "0249_cloud_push_signals.sql";
const sql = readFileSync(`apps/control-plane/migrations/${file}`, "utf8");

it("permits exactly the reviewed catalog and device-liveness expansion", () => {
  expect(createHash("sha256").update(sql).digest("hex"))
    .toBe("1aaa99a6e9e7dd831467eb79331e9acfb2b4bdcc7e05b2a2b5f8879a217308fc");
  expect(lintMigrationPhase(file, sql)).toEqual([]);
});

it.each([
  ["authority channel", "pg_notify('zeros_security_event'", "pg_notify('zeros_cloud_v2_catalog'"],
  ["invoker privileges", "SECURITY INVOKER", "SECURITY DEFINER"],
  ["function execution", "REVOKE ALL ON FUNCTION notify_cloud_v2_catalog_row() FROM PUBLIC", "GRANT ALL ON FUNCTION notify_cloud_v2_catalog_row() TO PUBLIC"],
])("refuses an unreviewed change to %s", (_name, before, after) => {
  expect(sql).toContain(before);
  expect(lintMigrationPhase(file, sql.replace(before, after)).length).toBeGreaterThan(0);
});

it("requires the exception annotations and rejects an unreviewed filename or destructive append", () => {
  const annotations = [...sql.matchAll(/^-- zeros-expand-exception:[^\n]+\n/gm)];
  expect(annotations).toHaveLength(2);
  for (const [annotation] of annotations)
    expect(lintMigrationPhase(file, sql.replace(annotation, "")).length).toBeGreaterThan(0);
  expect(lintMigrationPhase("0249_unreviewed.sql", sql).length).toBeGreaterThan(0);
  expect(lintMigrationPhase(file, `${sql}\nDELETE FROM cloud_v2_workspaces;`).length).toBeGreaterThan(0);
});

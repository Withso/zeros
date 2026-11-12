import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { lintMigrationPhase } from "../check-migration-phases";

const file = "0243_cloud_execution_person_authority.sql";
const sql = readFileSync(`apps/control-plane/migrations/${file}`, "utf8");

it("permits the reviewed personal authority migration", () => {
  expect(createHash("sha256").update(sql).digest("hex"))
    .toBe("a8edae631c64664b7406dc72d8405f3e7553c2cc2b6f2ee9bff7ceb4a6b16042");
  expect(lintMigrationPhase(file, sql)).toEqual([]);
});

it.each([
  ["capture privilege", "REVOKE ALL ON FUNCTION capture_cloud_execution_legacy_basis() FROM PUBLIC;",
    "REVOKE ALL ON FUNCTION capture_cloud_execution_legacy_basis() FROM PUBLIC, zeros_app;"],
  ["personal cutoff", "(NEW.user_id IS NULL OR user_id=NEW.user_id)", "true"],
  ["cutoff privilege", "REVOKE ALL ON FUNCTION fence_cloud_execution_person_resources() FROM PUBLIC;",
    "REVOKE ALL ON FUNCTION fence_cloud_execution_person_resources() FROM PUBLIC, zeros_app;"],
  ["sync privilege", "REVOKE ALL ON FUNCTION fence_cloud_execution_sync() FROM PUBLIC;",
    "REVOKE ALL ON FUNCTION fence_cloud_execution_sync() FROM PUBLIC, zeros_app;"],
  ["legacy behavior", "AND (w.execution_mode<>'active' OR NEW.user_id IS NULL)", ""],
  ["source verification", "ELSIF TG_TABLE_NAME='cloud_github_source_verifications' THEN",
    "ELSIF false THEN"],
])("rejects an unreviewed change to %s", (_name, before, after) => {
  expect(sql).toContain(before);
  expect(lintMigrationPhase(file, sql.replace(before, after)).length).toBeGreaterThan(0);
});

it("requires a separate annotation for every exception", () => {
  const annotations = [...sql.matchAll(/^-- zeros-expand-exception:[^\n]+\n/gm)];
  expect(annotations).toHaveLength(6);
  for (const [annotation] of annotations) {
    expect(lintMigrationPhase(file, sql.replace(annotation, "")).length).toBeGreaterThan(0);
  }
});

it("does not exempt another migration or a destructive append", () => {
  expect(lintMigrationPhase("0243_unreviewed.sql", sql).length).toBeGreaterThan(0);
  expect(lintMigrationPhase(file, `${sql}\nDELETE FROM cloud_v2_workspaces;`).length).toBeGreaterThan(0);
});

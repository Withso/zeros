import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { lintMigrationPhase } from "../check-migration-phases";

const file = "0247_cloud_membership_access.sql";
const sql = readFileSync(`apps/control-plane/migrations/${file}`, "utf8");

it("permits the reviewed membership migration without widening its exceptions", () => {
  expect(createHash("sha256").update(sql).digest("hex"))
    .toBe("5824af1a53d3f7ac349a46d184853c4edfdc321eddab3942b57e4c268f02eb0b");
  expect(lintMigrationPhase(file, sql)).toEqual([]);
});

it.each([
  ["source nullability", "ALTER COLUMN source_fingerprint", "ALTER COLUMN authority"],
  ["capture privileges", "SECURITY INVOKER", "SECURITY DEFINER"],
  ["source cutoff", "DROP TRIGGER execution_source_fence", "DROP TRIGGER execution_member_fence"],
  ["selection cutoff", "DROP TRIGGER execution_github_selection_fence", "DROP TRIGGER execution_session_fence"],
  ["credential cutoff", "DROP TRIGGER execution_github_credential_fence", "DROP TRIGGER execution_account_fence"],
])("rejects an unreviewed change to %s", (_name, before, after) => {
  expect(sql).toContain(before);
  expect(lintMigrationPhase(file, sql.replace(before, after)).length).toBeGreaterThan(0);
});

it("requires each annotation and refuses another filename or a destructive append", () => {
  const annotations = [...sql.matchAll(/^-- zeros-expand-exception:[^\n]+\n/gm)];
  expect(annotations).toHaveLength(5);
  for (const [annotation] of annotations)
    expect(lintMigrationPhase(file, sql.replace(annotation, "")).length).toBeGreaterThan(0);
  expect(lintMigrationPhase("0247_unreviewed.sql", sql).length).toBeGreaterThan(0);
  expect(lintMigrationPhase(file, `${sql}\nDELETE FROM cloud_v2_execution_contexts;`).length).toBeGreaterThan(0);
});

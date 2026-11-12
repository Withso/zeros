import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { lintMigrationPhase } from "../check-migration-phases";

const file = "0246_cloud_team_ownership.sql";
const sql = readFileSync(`apps/control-plane/migrations/${file}`, "utf8");

it("permits only the reviewed Creator ownership expand", () => {
  expect(createHash("sha256").update(sql).digest("hex"))
    .toBe("04cb44280b841f0119b8f31a2ae05fdd8ff92787da272ca56190146911bd6af2");
  expect(lintMigrationPhase(file, sql)).toEqual([]);
});

it.each([
  ["nullable Creator", "ALTER TABLE cloud_v2_workspaces ALTER COLUMN creator_user_id DROP NOT NULL;",
    "ALTER TABLE cloud_v2_workspaces ALTER COLUMN created_by_user_id DROP NOT NULL;"],
  ["guard privilege", "REVOKE ALL ON FUNCTION guard_cloud_creator_ownership() FROM PUBLIC;",
    "REVOKE ALL ON FUNCTION guard_cloud_creator_ownership() FROM PUBLIC, zeros_app;"],
  ["loss scope", "IF NOT coalesce(public.app_is_system(),false) THEN RETURN 0; END IF;", ""],
  ["loss privilege", "REVOKE ALL ON FUNCTION clear_cloud_creator_ownership(uuid,uuid,text,uuid) FROM PUBLIC;",
    "REVOKE ALL ON FUNCTION clear_cloud_creator_ownership(uuid,uuid,text,uuid) FROM PUBLIC, zeros_app;"],
  ["event privilege", "REVOKE ALL ON FUNCTION fence_cloud_creator_loss() FROM PUBLIC;",
    "REVOKE ALL ON FUNCTION fence_cloud_creator_loss() FROM PUBLIC, zeros_app;"],
])("rejects unreviewed changes to %s", (_name, before, after) => {
  expect(sql).toContain(before);
  expect(lintMigrationPhase(file, sql.replace(before, after)).length).toBeGreaterThan(0);
});

it("requires the privilege and nullability annotations and rejects another filename or destructive append", () => {
  const annotations = [...sql.matchAll(/^-- zeros-expand-exception:[^\n]+\n/gm)];
  expect(annotations).toHaveLength(5);
  // A new function is expand-safe; the file digest also pins its annotation.
  for (const [annotation] of annotations.filter(([text]) => !text.includes("cloud-creator-loss")))
    expect(lintMigrationPhase(file, sql.replace(annotation, "")).length).toBeGreaterThan(0);
  expect(lintMigrationPhase("0246_unreviewed.sql", sql).length).toBeGreaterThan(0);
  expect(lintMigrationPhase(file, `${sql}\nDELETE FROM cloud_v2_workspaces;`).length).toBeGreaterThan(0);
});

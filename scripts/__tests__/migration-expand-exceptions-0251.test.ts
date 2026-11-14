import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { lintMigrationPhase } from "../check-migration-phases";

const file = "0251_cloud_history_digests.sql";
const sql = readFileSync(`apps/control-plane/migrations/${file}`, "utf8");

it("permits exactly the reviewed history-digest expansion", () => {
  expect(createHash("sha256").update(sql).digest("hex"))
    .toBe("7a0d3013cbf2432e35255da4c9fda73774680096a63caf917d829f59226be638");
  expect(lintMigrationPhase(file, sql)).toEqual([]);
});

it.each([
  "invalidate_cloud_chat_history_digest",
  "invalidate_cloud_message_history_digest",
  "invalidate_changed_cloud_message_history_digest",
])("refuses unreviewed execution privileges for %s", name => {
  const statement = `REVOKE ALL ON FUNCTION ${name}() FROM PUBLIC;`;
  expect(sql).toContain(statement);
  expect(lintMigrationPhase(file, sql.replace(statement, `REVOKE ALL ON FUNCTION ${name}() FROM zeros_app;`)).length)
    .toBeGreaterThan(0);
});

it("requires all annotations and rejects a new filename or destructive append", () => {
  const annotations = [...sql.matchAll(/^-- zeros-expand-exception:[^\n]+\n/gm)];
  expect(annotations).toHaveLength(3);
  for (const [annotation] of annotations)
    expect(lintMigrationPhase(file, sql.replace(annotation, "")).length).toBeGreaterThan(0);
  expect(lintMigrationPhase("0251_unreviewed.sql", sql).length).toBeGreaterThan(0);
  expect(lintMigrationPhase(file, `${sql}\nDELETE FROM cloud_v2_messages;`).length).toBeGreaterThan(0);
});

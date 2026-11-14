import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { lintMigrationPhase } from "../check-migration-phases";

const file = "0252_cloud_chat_cache.sql";
const sql = readFileSync(`apps/control-plane/migrations/${file}`, "utf8");
const functions = [
  "advance_cloud_history_cache(uuid,text,boolean,bigint)",
  "track_cloud_message_cache()",
  "track_cloud_message_count()",
  "track_cloud_chat_cache()",
  "track_cloud_prompt_cache()",
];

it("permits only the reviewed chat cache migration", () => {
  expect(createHash("sha256").update(sql).digest("hex"))
    .toBe("ed80ca60662294a8fcd398740ca842aca7bb4fa80ebb069871b73d2e2a29d92f");
  expect(lintMigrationPhase(file, sql)).toEqual([]);
});

it("requires the explicit table privilege tightening", () => {
  const statement = "REVOKE ALL ON cloud_v2_history_cache, cloud_v2_history_changes, cloud_v2_prompt_cache FROM PUBLIC, zeros_app;";
  expect(sql).toContain(statement);
  expect(lintMigrationPhase(file, sql.replace(statement, statement.replace("PUBLIC, zeros_app", "PUBLIC"))).length).toBeGreaterThan(0);
});

it.each(functions)("rejects unreviewed privileges for %s", signature => {
  const statement = `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`;
  expect(sql).toContain(statement);
  expect(lintMigrationPhase(file, sql.replace(statement,
    `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, zeros_app;`)).length).toBeGreaterThan(0);
});

it("requires a separate annotation for each reviewed exception", () => {
  const annotations = [...sql.matchAll(/^-- zeros-expand-exception:[^\n]+\n/gm)];
  expect(annotations).toHaveLength(7);
  for (const [annotation] of annotations) {
    expect(lintMigrationPhase(file, sql.replace(annotation, "")).length).toBeGreaterThan(0);
  }
});

it("does not exempt changes to the fixed transition-table queries", () => {
  expect(lintMigrationPhase(file, sql.replace("FOR changed IN EXECUTE changes_sql LOOP",
    "FOR changed IN EXECUTE 'DELETE FROM cloud_v2_messages' LOOP")).length).toBeGreaterThan(0);
});

it("does not exempt another file or a destructive append", () => {
  expect(lintMigrationPhase("0252_unreviewed.sql", sql).length).toBeGreaterThan(0);
  expect(lintMigrationPhase(file, `${sql}\nDELETE FROM cloud_v2_messages;`).length).toBeGreaterThan(0);
});

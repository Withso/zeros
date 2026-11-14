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
    .toBe("500188601a6a4c784c5a5f318f618e49b027f5c08569bde283b79bbec8c4f8f4");
  expect(lintMigrationPhase(file, sql)).toEqual([]);
});

it.each(functions)("rejects unreviewed privileges for %s", signature => {
  const statement = `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`;
  expect(sql).toContain(statement);
  expect(lintMigrationPhase(file, sql.replace(statement,
    `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, zeros_app;`)).length).toBeGreaterThan(0);
});

it("requires a separate annotation for each reviewed exception", () => {
  const annotations = [...sql.matchAll(/^-- zeros-expand-exception:[^\n]+\n/gm)];
  expect(annotations).toHaveLength(5);
  for (const [annotation] of annotations) {
    expect(lintMigrationPhase(file, sql.replace(annotation, "")).length).toBeGreaterThan(0);
  }
});

it("does not exempt another file or a destructive append", () => {
  expect(lintMigrationPhase("0252_unreviewed.sql", sql).length).toBeGreaterThan(0);
  expect(lintMigrationPhase(file, `${sql}\nDELETE FROM cloud_v2_messages;`).length).toBeGreaterThan(0);
});

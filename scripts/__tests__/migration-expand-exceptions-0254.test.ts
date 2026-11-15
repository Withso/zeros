import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { lintMigrationPhase } from "../check-migration-phases";

const file = "0254_cloud_turn_survives_sender.sql";
const sql = readFileSync(`apps/control-plane/migrations/${file}`, "utf8");

it("permits exactly the reviewed sender-continuation fence", () => {
  expect(createHash("sha256").update(sql).digest("hex"))
    .toBe("d0d7ee6c85d253e22fa7e87f5f3889ba0c668a769cd841698012c351476bc572");
  expect(lintMigrationPhase(file, sql)).toEqual([]);
});

it("refuses an edited fence, a missing annotation, a new filename or a destructive append", () => {
  expect(lintMigrationPhase(file, sql.replace("cause='access_revoked' AND kind='turn'", "kind='turn'")).length).toBeGreaterThan(0);
  const [annotation] = sql.match(/^-- zeros-expand-exception:[^\n]+\n/m)!;
  expect(lintMigrationPhase(file, sql.replace(annotation, "")).length).toBeGreaterThan(0);
  expect(lintMigrationPhase("0254_unreviewed.sql", sql).length).toBeGreaterThan(0);
  expect(lintMigrationPhase(file, `${sql}\nDELETE FROM cloud_v2_execution_contexts;`).length).toBeGreaterThan(0);
});

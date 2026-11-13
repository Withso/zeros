import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { lintMigrationPhase } from "../check-migration-phases";

const file = "0249_organization_seat_state.sql";
const sql = readFileSync(`apps/control-plane/migrations/${file}`, "utf8");

it("permits only the reviewed stored-seat expansion", () => {
  expect(createHash("sha256").update(sql).digest("hex"))
    .toBe("9bb81b3b8c8846ebadc5af9f44fec99a7b58e7514641cfc30595a089c935bb5b");
  expect(lintMigrationPhase(file, sql)).toEqual([]);
});

it.each([
  ["projection privileges", "FROM PUBLIC, zeros_app;", "FROM PUBLIC;"],
  ["interval helper privileges", "REVOKE ALL ON FUNCTION organization_member_seat_periods_for(uuid[]) FROM PUBLIC;", "REVOKE ALL ON FUNCTION organization_member_seat_periods_for(uuid[]) FROM zeros_app;"],
  ["refresh authority", "SECURITY DEFINER", "SECURITY INVOKER"],
  ["caller context", "PERFORM set_config('app.system',coalesce(previous_system,''),true);", "PERFORM set_config('app.system','on',true);"],
  ["staff trigger order", "ALTER TRIGGER staff_pro_benefit_sync ON users", "ALTER TRIGGER staff_pro_benefit_sync ON organization_members"],
  ["legacy policy limits", "IF member_limit=10 AND free_limit=5 THEN", "IF true THEN"],
])("rejects an unreviewed change to %s", (_name, before, after) => {
  expect(sql).toContain(before);
  expect(lintMigrationPhase(file, sql.replace(before, after)).length).toBeGreaterThan(0);
});

it("requires every annotation and refuses a new filename or destructive append", () => {
  const annotations = [...sql.matchAll(/^-- zeros-expand-exception:[^\n]+\n/gm)];
  expect(annotations).toHaveLength(9);
  for (const [annotation] of annotations)
    expect(lintMigrationPhase(file, sql.replace(annotation, "")).length).toBeGreaterThan(0);
  expect(lintMigrationPhase("0249_unreviewed.sql", sql).length).toBeGreaterThan(0);
  expect(lintMigrationPhase(file, `${sql}\nDELETE FROM organization_members;`).length).toBeGreaterThan(0);
});

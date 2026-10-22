import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { lintMigrationPhase } from "../check-migration-phases";

const file = "0201_cloud_v2_app_sessions.sql";
const sql = readFileSync(`apps/control-plane/migrations/${file}`, "utf8");

it("permits only the exact session-scoped sign-out replacement", () => {
  expect(lintMigrationPhase(file, sql)).toEqual([]);
});

it.each([
  sql.replace("AND t.provider_session_id = NEW.provider_session_id", ""),
  sql.replace("t.user_id = NEW.user_id", "true"),
  sql.replace("worker_token_hash = NULL", "worker_token_hash = worker_token_hash"),
  sql.replace("access_epoch = access_epoch + 1", "access_epoch = access_epoch"),
  sql.replace(/-- zeros-expand-exception:[^\n]+\n/, ""),
  `${sql}\nDELETE FROM cloud_v2_workspaces;`,
])("refuses unreviewed broadening or weakened account revocation", changed => {
  expect(lintMigrationPhase(file, changed).length).toBeGreaterThan(0);
});

it("does not permit the replacement under another migration name", () => {
  expect(lintMigrationPhase("0202_unreviewed.sql", sql).length).toBeGreaterThan(0);
});

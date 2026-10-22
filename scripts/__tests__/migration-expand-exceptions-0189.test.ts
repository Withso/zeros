import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { lintMigrationPhase } from "../check-migration-phases";

const file = "0189_cloud_v2_session_signout.sql";
const sql = readFileSync(`apps/control-plane/migrations/${file}`, "utf8");

it("permits the exact session-signout replacement while preserving account and organization revocation", () => {
  expect(lintMigrationPhase(file, sql)).toEqual([]);
});

it.each([
  sql.replace("NEW.kind = 'session.revoked'", "NEW.kind = 'account.revoked'"),
  sql.replace("worker_token_hash = NULL", "worker_token_hash = worker_token_hash"),
  sql.replace("AND user_id = NEW.user_id", ""),
  sql.replace(/-- zeros-expand-exception:[^\n]+\n/, ""),
  `${sql}\nDELETE FROM cloud_v2_workspaces;`,
])("refuses a broader change to the security-event trigger", changed => {
  expect(lintMigrationPhase(file, changed).length).toBeGreaterThan(0);
});

it("does not permit the same replacement in an unrelated migration", () => {
  expect(lintMigrationPhase("0188_cloud_v2_hybrid_transport.sql", sql).length).toBeGreaterThan(0);
});

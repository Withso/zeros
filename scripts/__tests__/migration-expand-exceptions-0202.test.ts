import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { lintMigrationPhase } from "../check-migration-phases";

const file = "0202_cloud_v2_prompt_outbox.sql";
const sql = readFileSync(`apps/control-plane/migrations/${file}`, "utf8");

it("permits only the reviewed future erasure of the new prompt tables", () => {
  expect(lintMigrationPhase(file, sql)).toEqual([]);
});

it.each([
  sql.replace("WHERE workspace_id = NEW.id;", ";"),
  sql.replace("AND chat_id = OLD.chat_id", ""),
  sql.replace("NEW.access_epoch <> OLD.access_epoch", "true"),
  sql.replace("DELETE FROM public.cloud_v2_prompt_chats", "DELETE FROM public.cloud_v2_workspaces"),
  sql.replace(/-- zeros-expand-exception:[^\n]+\n/, ""),
  `${sql}\nDELETE FROM cloud_v2_workspaces;`,
])("refuses broader deletion, revocation or an unreviewed statement", changed => {
  expect(changed).not.toBe(sql);
  expect(lintMigrationPhase(file, changed).length).toBeGreaterThan(0);
});

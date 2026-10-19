import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lintMigrationPhase } from "../check-migration-phases";

const file="0171_cloud_final_save_recovery.sql";
const sql=readFileSync(`apps/control-plane/migrations/${file}`,"utf8");
describe("final-save recovery expansion exceptions",()=>{
  it("distinguishes a nullable companion's CHECK predicate from a required new column",()=>{
    expect(lintMigrationPhase("0172_nullable_check.sql",`-- zeros-migration: expand
ALTER TABLE fixture ADD COLUMN version integer CHECK (version IS NULL OR predecessor IS NOT NULL);
ALTER TABLE fixture ADD CONSTRAINT attempt CHECK (predecessor IS NOT NULL);`)).toEqual([]);
    expect(lintMigrationPhase("0172_required_column.sql",`-- zeros-migration: expand
ALTER TABLE fixture ADD COLUMN version integer NOT NULL CHECK (predecessor IS NOT NULL);`).length).toBeGreaterThan(0);
  });
  it("allows only the closed state widening, private functions and authorized new-metadata cleanup",()=>{
    expect(lintMigrationPhase(file,sql)).toEqual([]);
  });
  it.each([
    sql.replace("DELETE FROM cloud_workspace_final_save_recoveries WHERE workspace_id=OLD.workspace_id AND org_id=OLD.org_id",
      "DELETE FROM cloud_workspace_final_save_recoveries"),
    sql.replaceAll("IF cloud_workspace_data_purge_authorized(OLD.workspace_id,OLD.org_id) THEN","IF true THEN"),
    sql.replace("SELECT app_is_system() AND EXISTS (\n    SELECT 1 FROM workspace_deletion_jobs job", "SELECT true OR EXISTS (\n    SELECT 1 FROM workspace_deletion_jobs job"),
    sql.replaceAll("DELETE FROM cloud_workspace_final_save_recoveries","DELETE FROM workspace_checkpoints"),
    sql.replace(/-- zeros-expand-exception:[^\n]+\n/g,""),
    `${sql}\nDELETE FROM cloud_workspace_final_save_recoveries;`,
    `${sql}\nREVOKE SELECT ON cloud_workspaces FROM zeros_app;`,
  ])("refuses a broadened exception or migration-time erasure",changed=>{
    expect(lintMigrationPhase(file,changed).length).toBeGreaterThan(0);
  });
  it("cannot borrow the reviewed statements for another migration",()=>{
    expect(lintMigrationPhase("0172_unrelated.sql",sql).length).toBeGreaterThan(0);
  });
});

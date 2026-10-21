import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lintMigrationPhase } from "../check-migration-phases";

const file = "0179_cloud_initial_delete_capture.sql";
const sql = readFileSync(`apps/control-plane/migrations/${file}`, "utf8");
const original = readFileSync("apps/control-plane/migrations/0171_cloud_final_save_recovery.sql", "utf8");
function body(source: string) {
  const start = source.indexOf("FUNCTION cloud_final_save_source_immutable(");
  return source.slice(start, source.indexOf("END $$;", start) + "END $$;".length);
}

describe("initial Delete capture migration", () => {
  it("admits only the exact first-source immutability extension", () => {
    expect(lintMigrationPhase(file, sql)).toEqual([]);
    expect(body(sql).replace(/ AND NOT EXISTS \(\n      SELECT 1 FROM cloud_workspace_initial_delete_captures receipt[\s\S]*?receipt.bound_recovery=to_jsonb\(NEW\)\)/, ""))
      .toBe(body(original).replace("\n    OR (OLD.original_request_id", " THEN\n    RAISE EXCEPTION 'immutable final save source' USING ERRCODE='23514';\n  END IF;\n  IF (OLD.original_request_id"));
  });

  it("leaves proof, dispatch, erasure and existing loss receipts untouched", () => {
    expect(sql).not.toMatch(/CREATE(?: OR REPLACE)? FUNCTION (?:cloud_final_save_proven|cloud_final_save_dispatchable|cloud_final_save_deletion_claimable|cloud_workspace_data_purge_authorized|cloud_final_save_owner_discarded)\(/);
    expect(sql).not.toMatch(/UPDATE (?:workspace_checkpoint_requests|cloud_workspace_lifecycle_intents)|'not_required'|'discarded'/);
  });

  it.each([
    sql.replace("receipt.admission_txid=txid_current()", "true"),
    sql.replace("receipt.original_recovery=to_jsonb(OLD)", "true"),
    sql.replace("receipt.bound_recovery=to_jsonb(NEW)", "true"),
    sql.replace("FROM PUBLIC,zeros_app;", "FROM PUBLIC;"),
    sql.replace(/-- zeros-expand-exception:[^\n]+\n/g, ""),
    `${sql}\nDELETE FROM cloud_workspace_final_save_recoveries;`,
  ])("rejects an unreviewed migration expansion", changed => {
    expect(lintMigrationPhase(file, changed).length).toBeGreaterThan(0);
  });
});

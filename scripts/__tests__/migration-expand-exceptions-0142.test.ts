import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lintMigrationPhase } from "../check-migration-phases";

const file = "0142_cloud_workspace_data_purge.sql";
const sql = readFileSync(`apps/control-plane/migrations/${file}`, "utf8");

describe("reviewed data-purge expand exceptions", () => {
  it("accepts only the exact boot guard and audit-preserving FK replacement", () => {
    expect(lintMigrationPhase(file, sql)).toEqual([]);
    expect(sql.match(/zeros-expand-exception:/g)).toHaveLength(2);
    const original = readFileSync("apps/control-plane/migrations/0140_cloud_agent_boot_credentials.sql", "utf8");
    const bindingChecks = original.split("  ELSIF NOT EXISTS (")[1]!.split("END $$;")[0];
    expect(sql).toContain(`  ELSIF NOT EXISTS (${bindingChecks}END $$;`);
    expect(sql).toContain("NEW.agent_command_mode=OLD.agent_command_mode");
  });

  it.each([
    ["an unannotated replacement", sql.replace(/-- zeros-expand-exception: deleted-boot-pointer[^\n]+\n/, "")],
    ["a weaker boot guard", sql.replace("AND writer.state IN ('active','retired')", "AND true")],
    ["another dropped constraint", sql.replace("DROP CONSTRAINT cloud_workspace_allocation_tr_transition_id_workspace_id_o_fkey;",
      "DROP CONSTRAINT cloud_workspace_allocation_tr_workspace_id_source_generati_fkey;")],
    ["another destructive statement", `${sql}\nDELETE FROM audit_log;`],
    ["another rule", sql.replace("zeros-expand-exception: deleted-boot-pointer", "zeros-expand-exception: allocation-authority")],
  ])("refuses %s", (_label, changed) => {
    expect(lintMigrationPhase(file, changed).length).toBeGreaterThan(0);
  });

  it("does not permit another migration to reuse an exception", () => {
    expect(lintMigrationPhase("0144_unreviewed.sql", sql).length).toBeGreaterThan(0);
  });
});

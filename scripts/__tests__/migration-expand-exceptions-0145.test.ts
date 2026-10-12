import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lintMigrationPhase } from "../check-migration-phases";

const file = "0145_cloud_computer_named_snapshots.sql";
const sql = readFileSync(`apps/control-plane/migrations/${file}`, "utf8");
describe("Computer named-pin expand compatibility", () => {
  it("permits only the exact widened runtime-pin guard", () => {
    expect(lintMigrationPhase(file, sql)).toEqual([]);
    expect(sql.match(/zeros-expand-exception:/g)).toHaveLength(1);
    for (const original of ["NEW.runtime_id,NEW.runtime_manifest_sha256,NEW.runtime_base_image_id,NEW.runtime_base_compatibility_id",
      "base.provider=NEW.provider AND base.source_commit=NEW.source_commit", "bundle.manifest_sha256=NEW.runtime_manifest_sha256",
      "base.architecture=NEW.architecture AND base.storage_mib=NEW.storage_mib"])
      expect(sql).toContain(original);
  });
  it.each([
    sql.replace("bundle.manifest_sha256=NEW.runtime_manifest_sha256", "true"),
    sql.replace("snapshot.image_ref=NEW.image_ref AND snapshot.org_id=NEW.org_id", "snapshot.image_ref=NEW.image_ref AND true"),
    sql.replace("preserve_cloud_generation_runtime_pin", "unrelated_function"),
    `${sql}\nDROP TABLE cloud_computer_template_snapshots;`,
    sql.replace(/-- zeros-expand-exception:[^\n]+\n/, ""),
  ])("refuses unreviewed guard changes and destructive statements", changed => {
    expect(lintMigrationPhase(file, changed).length).toBeGreaterThan(0);
  });
  it("does not let another file borrow the exception", () => {
    expect(lintMigrationPhase("0143_unrelated.sql", sql).length).toBeGreaterThan(0);
  });
});

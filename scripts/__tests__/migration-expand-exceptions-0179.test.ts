import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lintMigrationPhase } from "../check-migration-phases.js";

const file = "0179_cloud_discarded_lifecycle_jobs.sql";
const source = readFileSync(new URL(`../../apps/control-plane/migrations/${file}`, import.meta.url), "utf8");

describe("discarded lifecycle scheduling expansion", () => {
  it("permits only the reviewed scheduling replacement", () => {
    expect(lintMigrationPhase(file, source)).toEqual([]);
    expect(lintMigrationPhase("0999_unreviewed.sql", source)).not.toEqual([]);
  });

  it.each([
    ["ELSIF NEW.state IN ('proven','discarded') THEN", "ELSIF NEW.state='proven' THEN"],
    ["RETURNS trigger", "RETURNS trigger SECURITY DEFINER"],
    ["RETURN NEW;", "DELETE FROM cloud_workspace_lifecycle_intents; RETURN NEW;"],
  ])("refuses unreviewed changes to %s", (before, after) => {
    expect(source).toContain(before);
    expect(lintMigrationPhase(file, source.replace(before, after))).not.toEqual([]);
  });
});

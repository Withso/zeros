import { describe, expect, it } from "vitest";

import { assertMigrationApproved } from "./migrate.js";

const file = "0009_organization_team_hierarchy.sql";
const sql = [
  "-- heading",
  "-- zeros:requires-controlled-downtime",
  "ALTER TABLE teams RENAME TO organizations;",
].join("\n");

describe("controlled-downtime migration approval", () => {
  it("blocks a marked production migration by default", () => {
    expect(() =>
      assertMigrationApproved(file, sql, { NODE_ENV: "production" }),
    ).toThrow(/requires controlled downtime/);
  });

  it("requires an exact migration filename in the approval list", () => {
    expect(() =>
      assertMigrationApproved(file, sql, {
        NODE_ENV: "production",
        CONTROL_PLANE_MIGRATION_APPROVALS: "0009",
      }),
    ).toThrow(/not approved/);
    expect(() =>
      assertMigrationApproved(file, sql, {
        NODE_ENV: "production",
        CONTROL_PLANE_MIGRATION_APPROVALS:
          "0008_previous.sql,0009_organization_team_hierarchy.sql",
      }),
    ).not.toThrow();
  });

  it("does not burden development or ordinary forward-compatible migrations", () => {
    expect(() =>
      assertMigrationApproved(file, sql, { NODE_ENV: "development" }),
    ).not.toThrow();
    expect(() =>
      assertMigrationApproved(
        "0010_additive.sql",
        "ALTER TABLE users ADD COLUMN example text;",
        { NODE_ENV: "production" },
      ),
    ).not.toThrow();
  });
});

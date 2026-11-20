import { describe, expect, it } from "vitest";
import { rowsShownForPlacements } from "../sidebar-workspace-model";

const ORG = "11111111-1111-4111-8111-111111111111";
const rows = [
  { id: "personal", path: "/worktrees/a", placement: "local" as const, organizationId: null },
  { id: "historical", path: "/worktrees/b", placement: "local" as const, organizationId: ORG },
  { id: "cloud", path: `cloud://${ORG}/22222222-2222-4222-8222-222222222222`, placement: "cloud" as const, organizationId: ORG },
  { id: "pending-cloud", path: `cloud://${ORG}/33333333-3333-4333-8333-333333333333`, organizationId: ORG },
];

describe("sidebar This Mac / Cloud filter", () => {
  it("returns the same list when nothing is hidden", () => {
    expect(rowsShownForPlacements(rows, [])).toBe(rows);
  });

  it("hides cloud rows, by placement or by cloud key", () => {
    expect(rowsShownForPlacements(rows, ["cloud"]).map((row) => row.id)).toEqual(["personal", "historical"]);
  });

  it("hides Local rows, including historical organization-owned ones", () => {
    expect(rowsShownForPlacements(rows, ["local"]).map((row) => row.id)).toEqual(["cloud", "pending-cloud"]);
  });
});

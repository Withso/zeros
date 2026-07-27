import { beforeEach, describe, expect, it } from "vitest";

import {
  getPrIslandKind,
  publishPrIslandKind,
  resetPrIslandKindsForTesting,
} from "../pr-island-state-store";

beforeEach(() => resetPrIslandKindsForTesting());

describe("pr-island-state-store exact identity", () => {
  it("does not leak a previous PR kind into a new PR in the same workspace", () => {
    publishPrIslandKind("ws-1", 41, "merged");

    expect(getPrIslandKind("ws-1", 41)).toBe("merged");
    expect(getPrIslandKind("ws-1", 42)).toBeNull();
    expect(getPrIslandKind("ws-1", null)).toBeNull();
  });

  it("isolates equal PR numbers owned by different workspaces", () => {
    publishPrIslandKind("ws-a", 7, "ready-to-merge");
    publishPrIslandKind("ws-b", 7, "merged");

    expect(getPrIslandKind("ws-a", 7)).toBe("ready-to-merge");
    expect(getPrIslandKind("ws-b", 7)).toBe("merged");
  });
});

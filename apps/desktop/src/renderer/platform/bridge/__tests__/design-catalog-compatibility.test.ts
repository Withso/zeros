import { describe, expect, it } from "vitest";
import { isDesignWorkspaceSnapshotWire } from "../design-bridge";

const snapshot = {
  protocolCapability: null,
  pages: [
    { id: "main", title: "Design", folder: "", frameFiles: ["home.html"] },
  ],
  frames: [{ file: "home.html", pageId: "main" }],
  tokens: [],
  assets: [],
  tokenSourceVersion: "a".repeat(24),
  lint: {
    workspacePath: "/synthetic",
    checkedFiles: [],
    violations: [],
    healedOids: 0,
  },
};

describe("complete Design snapshot compatibility", () => {
  it("does not admit a progressive catalog as a complete snapshot", () => {
    expect(isDesignWorkspaceSnapshotWire(snapshot)).toBe(true);
    expect(
      isDesignWorkspaceSnapshotWire({
        ...snapshot,
        nextCursor: "remaining",
        totalCount: 10000,
      }),
    ).toBe(false);
    expect(
      isDesignWorkspaceSnapshotWire({
        ...snapshot,
        coverage: "partial",
        nextCursor: null,
      }),
    ).toBe(false);
  });
});

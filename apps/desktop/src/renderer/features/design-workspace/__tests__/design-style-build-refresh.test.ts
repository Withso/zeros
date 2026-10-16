import { afterEach, describe, expect, it } from "vitest";

import type { DesignWorkspaceSnapshotWire } from "../../../platform/git";
import {
  designWorkspaceSnapshotCache,
  invalidateDesignWorkspacesForStyleBuild,
  resetDesignWorkspaceCacheForTests,
} from "../state/design-workspace-cache";

const snapshot = { frames: [] } as unknown as DesignWorkspaceSnapshotWire;
const version = (workspaceId: string) => designWorkspaceSnapshotCache.peekSnapshot(workspaceId).invalidationVersion;

describe("style build refreshes", () => {
  afterEach(() => resetDesignWorkspaceCacheForTests());

  it("revalidates only the named workspaces' Design snapshots", () => {
    designWorkspaceSnapshotCache.setData("ws-a", snapshot);
    designWorkspaceSnapshotCache.setData("ws-b", snapshot);
    const before = { a: version("ws-a"), b: version("ws-b") };
    invalidateDesignWorkspacesForStyleBuild(["ws-a"]);
    expect(version("ws-a")).toBeGreaterThan(before.a);
    expect(version("ws-b")).toBe(before.b);
    // An unnamed change (no exact row) revalidates every settled snapshot.
    invalidateDesignWorkspacesForStyleBuild(undefined);
    expect(version("ws-b")).toBeGreaterThan(before.b);
  });
});

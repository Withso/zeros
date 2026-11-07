import { afterEach, describe, expect, it, vi } from "vitest";

import type { DesignWorkspaceSnapshotWire } from "../../../platform/git";
const navigation = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../state/design-workspace-preparation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/design-workspace-preparation")>()),
  readDesignNavigation: navigation.read,
}));
import {
  designWorkspaceSnapshotCache,
  invalidateDesignWorkspacesForStyleBuild,
  refreshDesignWorkspacesForStyleStatus,
  resetDesignWorkspaceCacheForTests,
} from "../state/design-workspace-cache";

const snapshot = { frames: [] } as unknown as DesignWorkspaceSnapshotWire;
const version = (workspaceId: string) => designWorkspaceSnapshotCache.peekSnapshot(workspaceId).invalidationVersion;

const source = { id: "app", title: "App", kind: "build", path: ".zeros/design-styles/app.css", themes: [], tokens: [], bytes: 10, revision: "r1" };
const prepared = (status: "ready" | "warning") => ({
  directoryId: "design_test", protocolCapability: null, tokenSourceVersion: "tokens",
  frames: [{ file: "page/a.html", frameId: "a", pageId: "page", title: "A", x: 0, y: 0, width: 10, height: 10, z: 0,
    sourceVersion: "s".repeat(24), nodeCount: 1, modifiedAt: 0 }],
  preparation: { revision: "c".repeat(64), epoch: 1, descriptions: [], current: ["page/a.html"], errors: {} },
  styleSources: [{ ...source, status, messages: status === "ready" ? [] : [{ level: "warning", text: "Waiting for setup." }] }],
  lint: { workspacePath: "/w", checkedFiles: [], violations: [], healedOids: 0 },
}) as unknown as DesignWorkspaceSnapshotWire;

describe("style build refreshes", () => {
  afterEach(() => { resetDesignWorkspaceCacheForTests(); navigation.read.mockReset(); });

  it("refreshes statuses for a state-only change and keeps every prepared frame", async () => {
    const current = prepared("warning");
    designWorkspaceSnapshotCache.setData("ws", current);
    const before = version("ws");
    // Navigation reports the new status; its frames are unprepared until revalidated.
    navigation.read.mockResolvedValue({ ...prepared("ready"), preparation: { ...current.preparation!, epoch: 2, current: [] } });
    refreshDesignWorkspacesForStyleStatus(["ws"]);
    await vi.waitFor(() => expect(designWorkspaceSnapshotCache.peekSnapshot("ws").data?.styleSources?.[0]?.status).toBe("ready"));
    const after = designWorkspaceSnapshotCache.peekSnapshot("ws").data!;
    expect(after.frames).toBe(current.frames);
    expect(after.preparation).toBe(current.preparation);
    expect(version("ws")).toBe(before);
  });

  it("revalidates when a style source revision changed, and never publishes over a newer read", async () => {
    const current = prepared("warning");
    designWorkspaceSnapshotCache.setData("ws", current);
    const before = version("ws");
    const changed = prepared("ready");
    changed.styleSources![0] = { ...changed.styleSources![0]!, revision: "r2" };
    navigation.read.mockResolvedValue(changed);
    refreshDesignWorkspacesForStyleStatus(["ws"]);
    await vi.waitFor(() => expect(version("ws")).toBeGreaterThan(before));
    expect(designWorkspaceSnapshotCache.peekSnapshot("ws").data?.styleSources?.[0]?.status).toBe("warning");

    resetDesignWorkspaceCacheForTests();
    designWorkspaceSnapshotCache.setData("ws", current);
    let finish!: (value: DesignWorkspaceSnapshotWire) => void;
    navigation.read.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    refreshDesignWorkspacesForStyleStatus(["ws"]);
    const newer = prepared("warning");
    designWorkspaceSnapshotCache.setData("ws", newer);
    const settled = version("ws");
    finish(prepared("ready"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(designWorkspaceSnapshotCache.peekSnapshot("ws").data).toBe(newer);
    expect(version("ws")).toBe(settled);
  });

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

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DesignWorkspaceSnapshotWire } from "../../../platform/git";
import { DESIGN_FRAMES_CHANGES_CAPABILITY } from "@zeros/protocol/design-catalog";

const producer = vi.hoisted(() => ({ navigation: vi.fn(), prepare: vi.fn(), snapshot: vi.fn(), capabilities: new Set<string>() }));
vi.mock("../../../platform/git", async (original) => ({
  ...await original<typeof import("../../../platform/git")>(),
  designPrepareFrames: producer.prepare,
  designSnapshot: producer.snapshot,
}));
vi.mock("../../../platform/bridge/active-bridge", () => ({
  getActiveBridge: () => ({ supportsEngineCapability: (capability: string) => producer.capabilities.has(capability) }),
  onActiveBridgeConnected: () => () => {},
  onActiveBridgeChange: () => () => {},
}));
vi.mock("../state/design-workspace-preparation", async (original) => ({
  ...await original<typeof import("../state/design-workspace-preparation")>(),
  readDesignNavigation: producer.navigation,
}));

import { applyDesignFramesChange, applyDesignWorkspaceRefreshVersion, designFramePreparation, designWorkspaceSnapshotCache,
  resetDesignWorkspaceCacheForTests } from "../state/design-workspace-cache";

const token = {};
const revision = "a".repeat(64);
const workspaceId = "personal";
function prepared(count = 3): DesignWorkspaceSnapshotWire {
  const frames = Array.from({ length: count }, (_, index) => ({ file: `frame-${index}.html`, frameId: `frame_${index}`, pageId: "main",
    title: `Frame ${index}`, kind: "frame" as const, x: index * 100, y: 0, width: 100, height: 100, z: index, nodeCount: 1, modifiedAt: 1,
    sourceVersion: "b".repeat(24) }));
  return { directoryId: "design_test", protocolCapability: null, tokens: [], tokenSourceVersion: "tokens", assets: [],
    lint: { workspacePath: `/fixture/${workspaceId}`, checkedFiles: [], violations: [], healedOids: 0 }, frames,
    preparation: { revision, epoch: 2, current: frames.map(frame => frame.file), errors: {},
      descriptions: frames.map(({ sourceVersion: _source, nodeCount: _nodes, modifiedAt: _modified, ...description }) =>
        ({ ...description, preparation: "unprepared" as const })) } };
}
beforeEach(() => {
  designFramePreparation.setDemand(token, null);
  resetDesignWorkspaceCacheForTests();
  vi.resetAllMocks();
  producer.capabilities.clear();
});
afterEach(() => { designFramePreparation.setDemand(token, null); });

it("re-prepares only the frames an engine change names, keeping the others and their pixels current", async () => {
  // An agent editing one frame of a 1,000-frame page re-prepared every
  // visible frame: about 5 s before its new picture.
  const before = prepared();
  designWorkspaceSnapshotCache.setData(workspaceId, before);
  designFramePreparation.setDemand(token, { workspaceId, files: before.frames.map(frame => frame.file) });
  producer.prepare.mockImplementation(async (_workspace: string, _directory: string, _revision: string, files: string[]) => ({
    catalogRevision: revision, errors: [],
    frames: before.frames.filter(frame => files.includes(frame.file)).map(frame => ({ ...frame, sourceVersion: "c".repeat(24) })) }));
  applyDesignFramesChange(workspaceId, { directoryId: "design_test", sequence: 1, frames: ["frame-1.html"], catalog: false, all: false });
  // The changed frame keeps its last record as a cover while it prepares.
  expect(designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data?.frames[1]!.sourceVersion).toBe("b".repeat(24));
  await vi.waitFor(() => expect(designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data?.frames[1]!.sourceVersion).toBe("c".repeat(24)));
  expect(producer.prepare).toHaveBeenCalledOnce();
  expect(producer.prepare).toHaveBeenCalledWith(workspaceId, "design_test", revision, ["frame-1.html"]);
  const after = designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data!;
  expect(after.frames.map(frame => frame.sourceVersion)).toEqual(["b".repeat(24), "c".repeat(24), "b".repeat(24)]);
  expect(after.preparation?.current).toEqual(expect.arrayContaining(before.frames.map(frame => frame.file)));
  expect(producer.navigation).not.toHaveBeenCalled();
});

it.each([
  ["a catalog change", { catalog: true, all: false, directoryId: "design_test" }],
  ["a whole-directory change", { catalog: false, all: true, directoryId: "design_test" }],
  ["another directory's change", { catalog: false, all: false, directoryId: "design_other" }],
])("re-reads the whole snapshot for %s", (_name, change) => {
  designWorkspaceSnapshotCache.setData(workspaceId, prepared());
  const before = designWorkspaceSnapshotCache.peekSnapshot(workspaceId).invalidationVersion;
  applyDesignFramesChange(workspaceId, { sequence: 1, frames: ["frame-1.html"], ...change });
  expect(designWorkspaceSnapshotCache.peekSnapshot(workspaceId).invalidationVersion).toBeGreaterThan(before);
});

it("relies on the engine's named changes instead of every Git refresh when it sends them", () => {
  designWorkspaceSnapshotCache.setData(workspaceId, prepared());
  applyDesignWorkspaceRefreshVersion(workspaceId, 1);
  const first = designWorkspaceSnapshotCache.peekSnapshot(workspaceId).invalidationVersion;
  producer.capabilities.add(DESIGN_FRAMES_CHANGES_CAPABILITY);
  applyDesignWorkspaceRefreshVersion(workspaceId, 2);
  expect(designWorkspaceSnapshotCache.peekSnapshot(workspaceId).invalidationVersion).toBe(first);
  // Without the capability a refresh still revalidates, as before.
  producer.capabilities.clear();
  applyDesignWorkspaceRefreshVersion(workspaceId, 3);
  expect(designWorkspaceSnapshotCache.peekSnapshot(workspaceId).invalidationVersion).toBeGreaterThan(first);
});

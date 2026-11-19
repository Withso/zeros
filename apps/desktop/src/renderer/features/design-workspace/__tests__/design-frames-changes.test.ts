import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DesignWorkspaceSnapshotWire } from "../../../platform/git";
import { DESIGN_FRAMES_CHANGES_CAPABILITY, DESIGN_FRAMES_LINT_CAPABILITY } from "@zeros/protocol/design-catalog";

const producer = vi.hoisted(() => ({ navigation: vi.fn(), prepare: vi.fn(), snapshot: vi.fn(), lint: vi.fn(), capabilities: new Set<string>() }));
vi.mock("../../../platform/git", async (original) => ({
  ...await original<typeof import("../../../platform/git")>(),
  designPrepareFrames: producer.prepare,
  designLintFrames: producer.lint,
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
  primeDesignWorkspaceSnapshot, resetDesignWorkspaceCacheForTests } from "../state/design-workspace-cache";

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
  expect(producer.prepare).toHaveBeenCalledWith(workspaceId, "design_test", revision, ["frame-1.html"], ["frame-1.html"]);
  const after = designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data!;
  expect(after.frames.map(frame => frame.sourceVersion)).toEqual(["b".repeat(24), "c".repeat(24), "b".repeat(24)]);
  expect(after.preparation?.current).toEqual(expect.arrayContaining(before.frames.map(frame => frame.file)));
  expect(producer.navigation).not.toHaveBeenCalled();
});

it("replaces a changed frame's source lint rows with those of its new preparation, keeping its runtime audit and other frames' rows", async () => {
  const before = prepared();
  const row = (file: string, ruleId: string, message: string) => ({ ruleId, severity: "warning" as const, message, file, line: 1, column: 1 });
  designWorkspaceSnapshotCache.setData(workspaceId, { ...before, lint: { ...before.lint, checkedFiles: ["frame-0.html", "frame-1.html"], violations: [
    row("frame-0.html", "unknown-class", "kept"), row("frame-1.html", "unknown-class", "stale"), row("frame-1.html", "contrast", "audit")] } });
  designFramePreparation.setDemand(token, { workspaceId, files: before.frames.map(frame => frame.file) });
  producer.prepare.mockImplementation(async (_workspace: string, _directory: string, _revision: string, files: string[], lintFiles?: string[]) => ({
    catalogRevision: revision, errors: [],
    frames: before.frames.filter(frame => files.includes(frame.file)).map(frame => ({ ...frame, sourceVersion: "c".repeat(24) })),
    ...(lintFiles ? { lint: { checkedFiles: lintFiles, violations: lintFiles.map(file => row(file, "unknown-token", "fresh")) } } : {}) }));
  applyDesignFramesChange(workspaceId, { directoryId: "design_test", sequence: 1, frames: ["frame-1.html"], catalog: false, all: false });
  await vi.waitFor(() => expect(designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data?.frames[1]!.sourceVersion).toBe("c".repeat(24)));
  expect(producer.prepare).toHaveBeenCalledWith(workspaceId, "design_test", revision, ["frame-1.html"], ["frame-1.html"]);
  const lint = designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data!.lint;
  expect(lint.violations.map(violation => `${violation.file} ${violation.ruleId} ${violation.message}`).sort()).toEqual([
    "frame-0.html unknown-class kept", "frame-1.html contrast audit", "frame-1.html unknown-token fresh"]);
  expect(designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data!.preparation?.relint ?? []).toEqual([]);
});

it("does not lint frames on their first preparation", async () => {
  const before = prepared();
  designWorkspaceSnapshotCache.setData(workspaceId, { ...before, frames: [], preparation: { ...before.preparation!, current: [] } });
  producer.prepare.mockImplementation(async (_workspace: string, _directory: string, _revision: string, files: string[]) => ({
    catalogRevision: revision, errors: [], frames: before.frames.filter(frame => files.includes(frame.file)) }));
  designFramePreparation.setDemand(token, { workspaceId, files: before.frames.map(frame => frame.file) });
  await vi.waitFor(() => expect(designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data?.preparation?.current).toHaveLength(3));
  expect(producer.prepare.mock.calls[0]).toHaveLength(4);
});

/** A scoped write acknowledgement: it prepares `file` again and lints nothing. */
function writeAck(before: DesignWorkspaceSnapshotWire, file: string, sourceVersion: string): DesignWorkspaceSnapshotWire {
  return { ...before, preparation: undefined, lint: { ...before.lint, checkedFiles: [], violations: [] },
    frames: before.frames.filter(frame => frame.file === file).map(frame => ({ ...frame, sourceVersion })),
    mutationCatalog: { revision, frames: before.frames.map((frame, order) => ({ id: frame.frameId!, pageId: "main", source: frame.file,
      title: frame.title, kind: "html" as const, x: frame.x, y: frame.y, width: frame.width, height: frame.height, z: frame.z, order,
      preparation: "unprepared" as const })) } };
}
const lintRow = (file: string, ruleId: string, message: string) => ({ ruleId, severity: "warning" as const, message, file, line: 1, column: 1 });
const lintRows = () => designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data!.lint.violations
  .map(violation => `${violation.file} ${violation.ruleId} ${violation.message}`).sort();

it("lints a written frame after its acknowledgement and keeps rows only for the source version the canvas still holds", async () => {
  const before = prepared();
  designWorkspaceSnapshotCache.setData(workspaceId, { ...before, lint: { ...before.lint, checkedFiles: ["frame-0.html", "frame-1.html"], violations: [
    lintRow("frame-0.html", "unknown-class", "kept"), lintRow("frame-1.html", "unknown-class", "stale"), lintRow("frame-1.html", "contrast", "audit")] } });
  producer.capabilities.add(DESIGN_FRAMES_LINT_CAPABILITY);
  const replies: Array<(versionLabel: string) => void> = [];
  producer.lint.mockImplementation((_workspace: string, _directory: string, frames: Array<{ file: string; sourceVersion: string }>) =>
    new Promise(resolve => replies.push(label => resolve({ frames, checkedFiles: frames.map(frame => frame.file),
      violations: frames.map(frame => lintRow(frame.file, "unknown-token", label)) }))));
  primeDesignWorkspaceSnapshot(workspaceId, writeAck(before, "frame-1.html", "c".repeat(24)));
  // The acknowledgement carries no rows: the written frame keeps its last ones meanwhile.
  expect(lintRows()).toEqual(["frame-0.html unknown-class kept", "frame-1.html contrast audit", "frame-1.html unknown-class stale"]);
  await vi.waitFor(() => expect(producer.lint).toHaveBeenCalledOnce());
  expect(producer.lint).toHaveBeenCalledWith(workspaceId, "design_test", [{ file: "frame-1.html", sourceVersion: "c".repeat(24) }]);
  // A second write lands before the first lint replies.
  primeDesignWorkspaceSnapshot(workspaceId, writeAck(before, "frame-1.html", "d".repeat(24)));
  replies[0]!("for c");
  await vi.waitFor(() => expect(producer.lint).toHaveBeenCalledTimes(2));
  expect(lintRows()).not.toContain("frame-1.html unknown-token for c");
  expect(producer.lint).toHaveBeenLastCalledWith(workspaceId, "design_test", [{ file: "frame-1.html", sourceVersion: "d".repeat(24) }]);
  replies[1]!("for d");
  await vi.waitFor(() => expect(lintRows()).toEqual(["frame-0.html unknown-class kept", "frame-1.html contrast audit", "frame-1.html unknown-token for d"]));
  expect(designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data!.preparation?.lintPending ?? []).toEqual([]);
});

it("drops a written frame's lint reply when the directory changed meanwhile", async () => {
  const before = prepared();
  designWorkspaceSnapshotCache.setData(workspaceId, before);
  producer.capabilities.add(DESIGN_FRAMES_LINT_CAPABILITY);
  let reply!: () => void;
  producer.lint.mockImplementation((_workspace: string, _directory: string, frames: Array<{ file: string; sourceVersion: string }>) =>
    new Promise(resolve => { reply = () => resolve({ frames, checkedFiles: frames.map(frame => frame.file),
      violations: frames.map(frame => lintRow(frame.file, "unknown-token", "other directory")) }); }));
  primeDesignWorkspaceSnapshot(workspaceId, writeAck(before, "frame-1.html", "c".repeat(24)));
  await vi.waitFor(() => expect(producer.lint).toHaveBeenCalledOnce());
  const other = prepared();
  designWorkspaceSnapshotCache.setData(workspaceId, { ...other, directoryId: "design_other",
    frames: other.frames.map(frame => ({ ...frame, sourceVersion: "c".repeat(24) })) });
  reply();
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(lintRows()).toEqual([]);
});

it("sends no lint request to an engine without design.frames.lint", async () => {
  const before = prepared();
  designWorkspaceSnapshotCache.setData(workspaceId, before);
  primeDesignWorkspaceSnapshot(workspaceId, writeAck(before, "frame-1.html", "c".repeat(24)));
  await new Promise(resolve => setTimeout(resolve, 400));
  expect(producer.lint).not.toHaveBeenCalled();
  expect(designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data!.preparation?.lintPending).toBeUndefined();
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

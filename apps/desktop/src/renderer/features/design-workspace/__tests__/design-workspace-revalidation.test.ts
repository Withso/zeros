import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DesignWorkspaceSnapshotWire } from "../../../platform/git";

const producer = vi.hoisted(() => ({ navigation: vi.fn(), prepare: vi.fn(), snapshot: vi.fn(), create: vi.fn() }));
vi.mock("../../../platform/git", async (original) => ({
  ...await original<typeof import("../../../platform/git")>(),
  designPrepareFrames: producer.prepare,
  designSnapshot: producer.snapshot,
  designCreateFrame: producer.create,
}));
vi.mock("../../../platform/bridge/active-bridge", () => ({
  getActiveBridge: () => null,
  onActiveBridgeConnected: () => () => {},
}));
vi.mock("../state/design-workspace-preparation", async (original) => ({
  ...await original<typeof import("../state/design-workspace-preparation")>(),
  readDesignNavigation: producer.navigation,
}));

import { createDesignFrameAndRefresh, designFramePreparation, designWorkspaceSnapshotCache, fetchDesignWorkspaceSnapshot, resetDesignWorkspaceCacheForTests } from "../state/design-workspace-cache";
import { designFrameViews, isPreparedDesignFrame } from "../state/design-frame-view";

const token = {};
const revision = "a".repeat(64);
function confirmed(workspaceId: string, count = 2): DesignWorkspaceSnapshotWire {
  return { directoryId: "design_test", protocolCapability: null, tokens: [], tokenSourceVersion: "tokens", assets: [],
    lint: { workspacePath: `/fixture/${workspaceId}`, checkedFiles: [], violations: [], healedOids: 0 },
    frames: Array.from({ length: count }, (_, index) => ({ file: `frame-${index}.html`, frameId: `frame_${index}`, pageId: "main", title: `Frame ${index}`,
      kind: "frame", x: index * 100, y: 0, width: 100, height: 100, z: index, nodeCount: 1, modifiedAt: 1, sourceVersion: "b".repeat(24) })),
  };
}
function navigation(previous: DesignWorkspaceSnapshotWire): DesignWorkspaceSnapshotWire {
  return { ...previous, preparation: { revision, epoch: 2, current: [], errors: {},
    descriptions: previous.frames.map(({ sourceVersion: _source, nodeCount: _nodes, layerCount: _layers, modifiedAt: _modified, ...description }) => ({ ...description, preparation: "unprepared" as const })),
  } };
}
function reply(value: DesignWorkspaceSnapshotWire, files = value.frames.map(frame => frame.file)) {
  return { catalogRevision: revision, frames: value.frames.filter(frame => files.includes(frame.file)), errors: [] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function load(workspaceId: string) {
  return designWorkspaceSnapshotCache.load(workspaceId, () => fetchDesignWorkspaceSnapshot(workspaceId), { force: true });
}
beforeEach(() => {
  designFramePreparation.setDemand(token, null);
  resetDesignWorkspaceCacheForTests();
  vi.resetAllMocks();
});
afterEach(() => { designFramePreparation.setDemand(token, null); });

it.each(["personal", "organization-local"])("keeps %s's confirmed panel source until demanded frames are revalidated", async workspaceId => {
  const before = confirmed(workspaceId);
  const next = { ...before, frames: before.frames.map(frame => ({ ...frame, sourceVersion: "c".repeat(24) })) };
  designWorkspaceSnapshotCache.setData(workspaceId, before);
  designFramePreparation.setDemand(token, { workspaceId, files: [before.frames[0]!.file] });
  producer.navigation.mockResolvedValue(navigation(before));
  const held = deferred<ReturnType<typeof reply>>();
  producer.prepare.mockReturnValue(held.promise);
  const published: Array<DesignWorkspaceSnapshotWire | undefined> = [];
  const unsubscribe = designWorkspaceSnapshotCache.subscribe(workspaceId, () => published.push(designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data));
  const read = load(workspaceId);
  try {
    await vi.waitFor(() => expect(producer.prepare).toHaveBeenCalledOnce());
    expect(producer.prepare).toHaveBeenCalledWith(workspaceId, before.directoryId, revision, [before.frames[0]!.file]);
    expect(designWorkspaceSnapshotCache.peekSnapshot(workspaceId)).toMatchObject({ data: before, refreshing: true });
    expect(published.every(value => value === before)).toBe(true);
    held.resolve(reply(next, [before.frames[0]!.file]));
    const after = await read;
    expect(after.preparation?.current).toEqual([before.frames[0]!.file]);
    expect(after.frames[0]!.sourceVersion).toBe("c".repeat(24));
    expect(designFrameViews(after).map(isPreparedDesignFrame)).toEqual([true, false]);
    expect(published.every(value => isPreparedDesignFrame(designFrameViews(value)[0]!))).toBe(true);
  } finally { held.resolve(reply(next)); await read; unsubscribe(); }
});

it("keeps first-open navigation lazy and never prepares an inactive or cloud destination", async () => {
  for (const workspaceId of ["cold", "inactive", "cloud://organization/workspace"]) {
    const before = confirmed(workspaceId);
    if (workspaceId !== "cold") designWorkspaceSnapshotCache.setData(workspaceId, before);
    if (workspaceId !== "inactive") designFramePreparation.setDemand(token, { workspaceId, files: [before.frames[0]!.file] });
    const next = navigation(before);
    if (workspaceId === "cold") next.frames = [];
    producer.navigation.mockResolvedValue(next);
    await load(workspaceId);
    designFramePreparation.setDemand(token, null);
  }
  expect(producer.prepare).not.toHaveBeenCalled();
});

it("does not replace a newer mutation or another owner with a held warm preparation", async () => {
  const workspaceId = "personal";
  const before = confirmed(workspaceId);
  designWorkspaceSnapshotCache.setData(workspaceId, before);
  designFramePreparation.setDemand(token, { workspaceId, files: [before.frames[0]!.file] });
  producer.navigation.mockResolvedValue(navigation(before));
  const held = deferred<ReturnType<typeof reply>>();
  producer.prepare.mockReturnValue(held.promise);
  const read = load(workspaceId);
  try {
    await vi.waitFor(() => expect(producer.prepare).toHaveBeenCalledOnce());
    const newer = { ...before, frames: before.frames.map(frame => ({ ...frame, sourceVersion: "d".repeat(24) })) };
    designWorkspaceSnapshotCache.setData(workspaceId, newer);
    designFramePreparation.setDemand(token, { workspaceId: "organization-local", files: [before.frames[0]!.file] });
    held.resolve(reply(before, [before.frames[0]!.file]));
    await read;
    expect(designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data).toBe(newer);
    expect(designWorkspaceSnapshotCache.peekSnapshot("organization-local").data).toBeUndefined();
  } finally { held.resolve(reply(before)); await read; }
});

it("validates all demanded frames in bounded batches before one warm publication", async () => {
  const workspaceId = "organization-local";
  const before = confirmed(workspaceId, 35);
  designWorkspaceSnapshotCache.setData(workspaceId, before);
  designFramePreparation.setDemand(token, { workspaceId, files: before.frames.map(frame => frame.file) });
  producer.navigation.mockResolvedValue(navigation(before));
  producer.prepare.mockImplementation(async (_workspace: string, _directory: string, _revision: string, files: string[]) => reply(before, files));
  const visible: number[] = [];
  const unsubscribe = designWorkspaceSnapshotCache.subscribe(workspaceId, () => visible.push(designFrameViews(designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data).filter(isPreparedDesignFrame).length));
  try {
    const after = await load(workspaceId);
    expect(producer.prepare.mock.calls.map(call => call[3].length)).toEqual([16, 16, 3]);
    expect(after.preparation?.current).toHaveLength(35);
    expect(visible.every(count => count === 35)).toBe(true);
  } finally { unsubscribe(); }
});

it.each(["hidden", "organization-local"])("revalidates a returning activation after a held reply crossed %s", async destination => {
  const before = confirmed("personal");
  designWorkspaceSnapshotCache.setData("personal", before);
  designFramePreparation.setDemand(token, { workspaceId: "personal", files: ["frame-0.html"] });
  producer.navigation.mockResolvedValue(navigation(before));
  const held = deferred<ReturnType<typeof reply>>();
  producer.prepare.mockReturnValueOnce(held.promise).mockResolvedValue(reply(before, ["frame-0.html"]));
  const read = load("personal");
  await vi.waitFor(() => expect(producer.prepare).toHaveBeenCalledOnce());
  designFramePreparation.setDemand(token, destination === "hidden" ? null : { workspaceId: destination, files: ["frame-0.html"] });
  designFramePreparation.setDemand(token, { workspaceId: "personal", files: ["frame-0.html"] });
  held.resolve(reply({ ...before, frames: before.frames.map(frame => ({ ...frame, sourceVersion: "e".repeat(24) })) }, ["frame-0.html"]));
  const after = await read;
  expect(producer.prepare).toHaveBeenCalledTimes(2);
  expect(after.frames[0]!.sourceVersion).toBe(before.frames[0]!.sourceVersion);
  expect(after.preparation?.current).toEqual(["frame-0.html"]);
});

it("does not start another batch when a revalidating surface becomes hidden", async () => {
  const before = confirmed("personal", 35);
  designWorkspaceSnapshotCache.setData("personal", before);
  designFramePreparation.setDemand(token, { workspaceId: "personal", files: before.frames.map(frame => frame.file) });
  producer.navigation.mockResolvedValue(navigation(before));
  const held = deferred<ReturnType<typeof reply>>();
  producer.prepare.mockReturnValueOnce(held.promise);
  const read = load("personal");
  await vi.waitFor(() => expect(producer.prepare).toHaveBeenCalledOnce());
  designFramePreparation.setDemand(token, null);
  held.resolve(reply(before, before.frames.slice(0, 16).map(frame => frame.file)));
  const after = await read;
  expect(producer.prepare).toHaveBeenCalledOnce();
  expect(after.preparation?.current).toEqual([]);
});

it("retains the confirmed aggregate when editing starts during warm preparation", async () => {
  const before = confirmed("personal");
  designWorkspaceSnapshotCache.setData("personal", before);
  designFramePreparation.setDemand(token, { workspaceId: "personal", files: ["frame-0.html"] });
  producer.navigation.mockResolvedValue(navigation(before));
  const held = deferred<ReturnType<typeof reply>>();
  const mutation = deferred<{ snapshot: DesignWorkspaceSnapshotWire; frame: DesignWorkspaceSnapshotWire["frames"][number] }>();
  producer.prepare.mockReturnValueOnce(held.promise);
  producer.create.mockReturnValueOnce(mutation.promise);
  const read = load("personal");
  await vi.waitFor(() => expect(producer.prepare).toHaveBeenCalledOnce());
  const edit = createDesignFrameAndRefresh("personal");
  held.resolve(reply(before, ["frame-0.html"]));
  try {
    await read;
    expect(designWorkspaceSnapshotCache.peekSnapshot("personal").data).toBe(before);
  } finally {
    mutation.resolve({ snapshot: before, frame: before.frames[0]! });
    await edit;
  }
});

it.each(["hidden", "organization-local"])("discards a failed preparation from the visit retired through %s", async destination => {
  const before = confirmed("personal");
  designWorkspaceSnapshotCache.setData("personal", before);
  designFramePreparation.setDemand(token, { workspaceId: "personal", files: ["frame-0.html"] });
  producer.navigation.mockResolvedValue(navigation(before));
  const held = deferred<ReturnType<typeof reply>>();
  producer.prepare.mockReturnValueOnce(held.promise).mockResolvedValue(reply(before, ["frame-0.html"]));
  const read = load("personal");
  await vi.waitFor(() => expect(producer.prepare).toHaveBeenCalledOnce());
  designFramePreparation.setDemand(token, destination === "hidden" ? null : { workspaceId: destination, files: ["frame-0.html"] });
  designFramePreparation.setDemand(token, { workspaceId: "personal", files: ["frame-0.html"] });
  held.reject(new Error("Retired source read failed"));
  await expect(read).resolves.toMatchObject({ preparation: { current: ["frame-0.html"] } });
  expect(producer.prepare).toHaveBeenCalledTimes(2);
  expect(designWorkspaceSnapshotCache.peekSnapshot("personal").error).toBeNull();
});

it("keeps an edit's confirmed presentation when the superseded preparation fails", async () => {
  const before = confirmed("personal");
  designWorkspaceSnapshotCache.setData("personal", before);
  designFramePreparation.setDemand(token, { workspaceId: "personal", files: ["frame-0.html"] });
  producer.navigation.mockResolvedValue(navigation(before));
  const held = deferred<ReturnType<typeof reply>>();
  const mutation = deferred<{ snapshot: DesignWorkspaceSnapshotWire; frame: DesignWorkspaceSnapshotWire["frames"][number] }>();
  producer.prepare.mockReturnValueOnce(held.promise);
  producer.create.mockReturnValueOnce(mutation.promise);
  const read = load("personal");
  await vi.waitFor(() => expect(producer.prepare).toHaveBeenCalledOnce());
  const edit = createDesignFrameAndRefresh("personal");
  held.reject(new Error("Source was replaced by the pending edit"));
  try {
    await expect(read).resolves.toBe(before);
    expect(designWorkspaceSnapshotCache.peekSnapshot("personal").error).toBeNull();
    expect(producer.prepare).toHaveBeenCalledOnce();
  } finally {
    mutation.resolve({ snapshot: before, frame: before.frames[0]! });
    await edit;
  }
});

it("keeps active preparation failures visible without clearing the confirmed aggregate or retrying", async () => {
  const before = confirmed("personal");
  designWorkspaceSnapshotCache.setData("personal", before);
  designFramePreparation.setDemand(token, { workspaceId: "personal", files: ["frame-0.html"] });
  producer.navigation.mockResolvedValue(navigation(before));
  producer.prepare.mockRejectedValue(new Error("Current source is unavailable"));
  await expect(load("personal")).rejects.toThrow("Current source is unavailable");
  expect(designWorkspaceSnapshotCache.peekSnapshot("personal")).toMatchObject({ data: before, refreshing: false });
  designFramePreparation.resume();
  expect(producer.prepare).toHaveBeenCalledOnce();
});

it("takes the latest frame demand within a visit without publishing a partial warm result", async () => {
  const before = confirmed("personal");
  designWorkspaceSnapshotCache.setData("personal", before);
  designFramePreparation.setDemand(token, { workspaceId: "personal", files: ["frame-0.html"] });
  producer.navigation.mockResolvedValue(navigation(before));
  const held = deferred<ReturnType<typeof reply>>();
  producer.prepare.mockReturnValueOnce(held.promise).mockResolvedValue(reply(before, ["frame-1.html"]));
  const read = load("personal");
  await vi.waitFor(() => expect(producer.prepare).toHaveBeenCalledOnce());
  designFramePreparation.setDemand(token, { workspaceId: "personal", files: ["frame-1.html"] });
  expect(designWorkspaceSnapshotCache.peekSnapshot("personal").data).toBe(before);
  held.resolve(reply(before, ["frame-0.html"]));
  const after = await read;
  expect(producer.prepare.mock.calls.map(call => call[3])).toEqual([["frame-0.html"], ["frame-1.html"]]);
  expect(after.preparation?.current).toEqual(["frame-1.html"]);
});

it("does not start a warm batch queued behind cold preparation after its surface hides", async () => {
  const before = navigation(confirmed("personal"));
  designWorkspaceSnapshotCache.setData("personal", before);
  const held = deferred<ReturnType<typeof reply>>();
  producer.prepare.mockReturnValueOnce(held.promise);
  designFramePreparation.setDemand(token, { workspaceId: "personal", files: ["frame-0.html"] });
  producer.navigation.mockResolvedValue({ ...before, preparation: { ...before.preparation!, epoch: 3 } });
  const read = load("personal");
  await vi.waitFor(() => expect(producer.navigation).toHaveBeenCalledOnce());
  designFramePreparation.setDemand(token, null);
  held.resolve(reply(before, ["frame-0.html"]));
  const after = await read;
  expect(after.preparation?.current).toEqual([]);
  expect(producer.prepare).toHaveBeenCalledOnce();
});

it("does not error the new selection when preparation of the no-longer-demanded frame fails", async () => {
  const before = confirmed("personal");
  designWorkspaceSnapshotCache.setData("personal", before);
  designFramePreparation.setDemand(token, { workspaceId: "personal", files: ["frame-0.html"] });
  producer.navigation.mockResolvedValue(navigation(before));
  const held = deferred<ReturnType<typeof reply>>();
  producer.prepare.mockReturnValueOnce(held.promise).mockResolvedValue(reply(before, ["frame-1.html"]));
  const read = load("personal");
  await vi.waitFor(() => expect(producer.prepare).toHaveBeenCalledOnce());
  designFramePreparation.setDemand(token, { workspaceId: "personal", files: ["frame-1.html"] });
  held.reject(new Error("Previous selection's source is unavailable"));
  await expect(read).resolves.toMatchObject({ preparation: { current: ["frame-1.html"] } });
  expect(producer.prepare).toHaveBeenCalledTimes(2);
  expect(designWorkspaceSnapshotCache.peekSnapshot("personal").error).toBeNull();
});

it.each(["invalidate", "forget"] as const)("rejects held source preparation after cache %s and starts no follow-up batch", async action => {
  const before = confirmed("personal", 35);
  designWorkspaceSnapshotCache.setData("personal", before);
  designFramePreparation.setDemand(token, { workspaceId: "personal", files: before.frames.map(frame => frame.file) });
  producer.navigation.mockResolvedValue(navigation(before));
  const held = deferred<ReturnType<typeof reply>>();
  producer.prepare.mockReturnValueOnce(held.promise);
  const read = load("personal");
  await vi.waitFor(() => expect(producer.prepare).toHaveBeenCalledOnce());
  designWorkspaceSnapshotCache[action]("personal");
  held.resolve(reply(before, before.frames.slice(0, 16).map(frame => frame.file)));
  await read;
  expect(designWorkspaceSnapshotCache.peekSnapshot("personal").data).toBe(action === "forget" ? undefined : before);
  expect(producer.prepare).toHaveBeenCalledOnce();
});

it("caps warm source validation at 256 frames without widening the serial batch limit", async () => {
  const before = confirmed("organization-local", 300);
  designWorkspaceSnapshotCache.setData("organization-local", before);
  designFramePreparation.setDemand(token, { workspaceId: "organization-local", files: before.frames.map(frame => frame.file) });
  producer.navigation.mockResolvedValue(navigation(before));
  producer.prepare.mockImplementation(async (_workspace: string, _directory: string, _revision: string, files: string[]) => reply(before, files));
  const after = await load("organization-local");
  expect(after.preparation?.current).toHaveLength(256);
  expect(producer.prepare.mock.calls.map(call => call[3].length)).toEqual(Array.from({ length: 16 }, () => 16));
});

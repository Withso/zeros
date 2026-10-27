import { expect, it, vi } from "vitest";
import type { DesignWorkspaceSnapshotWire, DesignCanvasFrameWire } from "../../../platform/bridge/design-bridge";
import { DesignFramePreparation } from "../state/design-workspace-preparation";
import { designFrameViews, isPreparedDesignFrame, preparedDesignSnapshot } from "../state/design-frame-view";

function frame(file: string): DesignCanvasFrameWire {
  return { file, frameId: file.replace(".html", ""), pageId: "page", title: file, kind: "frame", x: 0, y: 0, width: 100, height: 100, z: 0,
    nodeCount: 1, modifiedAt: 0, sourceVersion: "a".repeat(24) };
}
function snapshot(epoch = 1, count = 3): DesignWorkspaceSnapshotWire {
  const frames = Array.from({ length: count }, (_, i) => frame(`f${i}.html`));
  return { directoryId: "design_test", protocolCapability: null, frames: [], tokens: [], tokenSourceVersion: "tokens", assets: [],
    lint: { workspacePath: "/fixture", checkedFiles: [], violations: [], healedOids: 0 },
    preparation: { revision: "a".repeat(64), epoch, current: [], errors: {}, descriptions: frames.map(({ sourceVersion: _source, nodeCount: _nodes, layerCount: _layers, modifiedAt: _modified, ...metadata }) => ({ ...metadata, preparation: "unprepared" })) },
  };
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
const reply = (files: readonly string[]) => ({ catalogRevision: "a".repeat(64), frames: files.map(frame), errors: [] });

it("does not fabricate a prepared generation from metadata or a previous matching hash", () => {
  const value = snapshot(); value.frames = [frame("f0.html")];
  const views = designFrameViews(value);
  expect(views).toBe(designFrameViews(value));
  expect(isPreparedDesignFrame(views[0]!)).toBe(false);
  expect(views[0]!.sourceVersion).toBeUndefined();
  expect(views[0]).toHaveProperty("previous", value.frames[0]);
  expect(preparedDesignSnapshot(value)!.frames).toEqual([]);
  expect(preparedDesignSnapshot(value)).toBe(preparedDesignSnapshot(value));
  expect(designFrameViews({ ...value, preparation: { ...value.preparation!, current: ["f0.html"] } })[0]).toBe(value.frames[0]);
});

it("prepares only view demand, one bounded batch, while distant descriptors stay metadata", async () => {
  let current = snapshot(1, 256);
  const held = deferred<ReturnType<typeof reply>>();
  const prepare = vi.fn(() => held.promise);
  const coordinator = new DesignFramePreparation({ snapshot: () => current, publish: (_, value) => { current = value; }, canPrepare: () => true, prepare });
  const token = {};
  coordinator.setDemand(token, { workspaceId: "personal", files: ["f0.html", "f1.html"] });
  coordinator.setDemand(token, { workspaceId: "personal", files: ["f0.html", "f1.html"] });
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(prepare.mock.calls[0]).toEqual(["personal", "design_test", "a".repeat(64), ["f0.html", "f1.html"]]);
  held.resolve(reply(["f0.html", "f1.html"]));
  await vi.waitFor(() => expect(current.preparation!.current).toHaveLength(2));
  expect(designFrameViews(current).filter(isPreparedDesignFrame)).toHaveLength(2);
  expect(coordinator.usage().running).toBe(0);
});

it("fences late batches across identical catalog revisions, owner switches, and mutation publication", async () => {
  let current = snapshot();
  const pending = [deferred<ReturnType<typeof reply>>(), deferred<ReturnType<typeof reply>>()];
  const prepare = vi.fn().mockImplementationOnce(() => pending[0]!.promise).mockImplementationOnce(() => pending[1]!.promise);
  const publish = vi.fn((_: string, next: DesignWorkspaceSnapshotWire) => { current = next; });
  const coordinator = new DesignFramePreparation({ snapshot: () => current, publish, canPrepare: () => true, prepare });
  coordinator.setDemand({}, { workspaceId: "personal", files: ["f0.html"] });
  current = snapshot(2);
  coordinator.setDemand({}, { workspaceId: "organization-local", files: ["f1.html"] });
  pending[0]!.resolve(reply(["f0.html"]));
  await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));
  expect(publish).not.toHaveBeenCalled();
  current = { ...current, frames: [frame("f1.html")], preparation: undefined };
  pending[1]!.resolve(reply(["f1.html"]));
  await vi.waitFor(() => expect(coordinator.usage().running).toBe(0));
  expect(publish).not.toHaveBeenCalled();
});

it("holds preparation during edits and exposes incomplete batches without retry storms", async () => {
  let current = snapshot(); let editing = true;
  const prepare = vi.fn(async () => reply([]));
  const coordinator = new DesignFramePreparation({ snapshot: () => current, publish: (_, next) => { current = next; }, canPrepare: () => !editing, prepare });
  coordinator.setDemand({}, { workspaceId: "local", files: ["f0.html"] });
  expect(prepare).not.toHaveBeenCalled();
  editing = false; coordinator.resume();
  await vi.waitFor(() => expect(current.preparation!.errors["f0.html"]).toContain("Incomplete"));
  coordinator.resume();
  expect(prepare).toHaveBeenCalledOnce();
  expect(current.preparation!.current).toEqual([]);
});

it("refuses a response whose geometry belongs to different metadata", async () => {
  let current = snapshot();
  const coordinator = new DesignFramePreparation({ snapshot: () => current, publish: (_, next) => { current = next; }, canPrepare: () => true,
    prepare: async () => ({ ...reply([]), frames: [{ ...frame("f0.html"), width: 200 }] }) });
  coordinator.setDemand({}, { workspaceId: "local", files: ["f0.html"] });
  await vi.waitFor(() => expect(coordinator.usage().running).toBe(0));
  expect(current.preparation!.current).toEqual([]);
  expect(current.preparation!.errors["f0.html"]).toMatch(/metadata/);
});

it("does not publish a failed preparation over an in-flight mutation", async () => {
  const current = snapshot(); let editing = false;
  const held = deferred<ReturnType<typeof reply>>();
  const publish = vi.fn();
  const coordinator = new DesignFramePreparation({ snapshot: () => current, publish, canPrepare: () => !editing, prepare: () => held.promise });
  coordinator.setDemand({}, { workspaceId: "local", files: ["f0.html"] });
  editing = true;
  held.reject(new Error("old source no longer exists"));
  await vi.waitFor(() => expect(coordinator.usage().running).toBe(0));
  expect(publish).not.toHaveBeenCalled();
});

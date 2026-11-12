import { expect, it, vi } from "vitest";
import type { DesignWorkspaceSnapshotWire, DesignCanvasFrameWire } from "../../../platform/bridge/design-bridge";
import { DesignFramePreparation, projectDesignMutationSnapshot } from "../state/design-workspace-preparation";
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

it("retains exact-owner covers after a scoped mutation without promoting unchecked source", () => {
  const previous = { ...snapshot(), frames: [frame("f0.html"), frame("f1.html"), frame("removed.html")] };
  const edited = { ...frame("f0.html"), sourceVersion: "b".repeat(24) };
  const next = { ...snapshot(), preparation: undefined, frames: [edited], mutationCatalog: { revision: "b".repeat(64),
    frames: [edited, frame("f1.html")].map((frame, order) => ({ ...frame, id: frame.frameId!, pageId: frame.pageId!, source: frame.file,
      kind: "html" as const, order, preparation: "unprepared" as const })) } };
  const projected = projectDesignMutationSnapshot(previous, next);
  expect(projected.frames).toEqual([edited, previous.frames[1]]);
  expect(preparedDesignSnapshot(projected)!.frames).toEqual([edited]);
  expect(designFrameViews(projected)[1]).toHaveProperty("previous", previous.frames[1]);
  expect(projectDesignMutationSnapshot({ ...previous, directoryId: "design_other" }, next).frames).toEqual([edited]);
  expect(projectDesignMutationSnapshot(previous, next).preparation!.epoch).not.toBe(projected.preparation!.epoch);
});

it("keeps other frames' confirmed lint across a scoped mutation", () => {
  const violation = (file: string) => ({ ruleId: "local-refs-only", severity: "error" as const, message: "Outside reference.", file, line: 1, column: 1 });
  const previous = { ...snapshot(), frames: [frame("f0.html"), frame("f1.html")],
    lint: { workspacePath: "/fixture", checkedFiles: ["f1.html", "f2.html"], violations: [violation("f1.html"), violation("f2.html"), violation("tokens.css")], healedOids: 0 } };
  const edited = { ...frame("f0.html"), sourceVersion: "b".repeat(24) };
  const next = { ...snapshot(), preparation: undefined, frames: [edited], mutationCatalog: { revision: "b".repeat(64),
    frames: [edited, frame("f1.html")].map((frame, order) => ({ ...frame, id: frame.frameId!, pageId: frame.pageId!, source: frame.file,
      kind: "html" as const, order, preparation: "unprepared" as const })) } };
  const projected = projectDesignMutationSnapshot(previous, next);
  // f2.html left the catalog; f1.html and the shared stylesheet keep their rows.
  expect(projected.lint.violations.map((row) => row.file)).toEqual(["f1.html", "tokens.css"]);
  expect(projected.lint.checkedFiles).toEqual(["f1.html"]);
  expect(projectDesignMutationSnapshot({ ...previous, directoryId: "design_other" }, next).lint.violations).toEqual([]);
});

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

it("starts no new preparation batch while a camera gesture is live, then resumes once it rests", async () => {
  // Each batch republishes the page; on a 1,000-frame page a batch completing
  // mid-pan re-rendered the whole canvas inside the gesture.
  vi.useFakeTimers();
  try {
    let current = snapshot(1, 40), quiet = 120;
    const prepare = vi.fn(async (_workspace: string, _directory: string, _revision: string, files: readonly string[]) => reply(files));
    const coordinator = new DesignFramePreparation({ snapshot: () => current, publish: (_, value) => { current = value; },
      canPrepare: () => true, prepare, quietMs: () => quiet });
    coordinator.setDemand({}, { workspaceId: "personal", files: ["f0.html", "f1.html"] });
    expect(prepare).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60);
    expect(prepare).not.toHaveBeenCalled();
    quiet = 0;
    await vi.advanceTimersByTimeAsync(60);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]![3]).toEqual(["f0.html", "f1.html"]);
  } finally { vi.useRealTimers(); }
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

it("projects a page-scoped acknowledgement onto unchanged pages it did not resend", () => {
  const description = (file: string, pageId: string) => ({ ...frame(file), pageId, preparation: "unprepared" as const });
  const strip = ({ sourceVersion: _s, nodeCount: _n, layerCount: _l, modifiedAt: _m, ...rest }: ReturnType<typeof description>) => rest;
  const kept = [strip(description("one/a0.html", "one")), strip(description("one/a1.html", "one"))];
  const previous: DesignWorkspaceSnapshotWire = { ...snapshot(), frames: [{ ...frame("one/a0.html"), pageId: "one" }],
    preparation: { revision: "a".repeat(64), epoch: 1, current: [], errors: {},
      descriptions: [...kept, strip(description("two/b0.html", "two"))], pageHashes: { one: "1".repeat(32), two: "2".repeat(32) } } };
  const descriptor = (file: string, order: number) => ({ id: file.split("/")[1]!.replace(".html", ""), pageId: "two", source: file,
    title: file, kind: "html" as const, x: 0, y: 0, width: 100, height: 100, z: 0, order, preparation: "unprepared" as const });
  const created = { ...frame("two/b1.html"), frameId: "b1", pageId: "two", sourceVersion: "c".repeat(24) };
  const ack = (oneHash: string): DesignWorkspaceSnapshotWire => ({ ...snapshot(), preparation: undefined, frames: [created],
    pageCatalog: { revision: "b".repeat(64), pages: [
      { id: "one", title: "One", folder: "one", count: 2, hash: oneHash },
      { id: "two", title: "Two", folder: "two", count: 2, hash: "3".repeat(32) }],
    frames: [descriptor("two/b0.html", 0), descriptor("two/b1.html", 1)] } });
  const projected = projectDesignMutationSnapshot(previous, ack("1".repeat(32)));
  expect(projected).not.toHaveProperty("pageCatalog");
  expect(projected.preparation!.descriptions.slice(0, 2)).toEqual(kept);
  expect(projected.preparation!.descriptions[0]).toBe(previous.preparation!.descriptions[0]);
  expect(projected.preparation!.descriptions.map((entry) => entry.file)).toEqual(["one/a0.html", "one/a1.html", "two/b0.html", "two/b1.html"]);
  expect(projected.pages!.map((page) => [page.id, page.frameFiles, page.frameIds])).toEqual([
    ["one", ["one/a0.html", "one/a1.html"], ["one/a0", "one/a1"]], ["two", ["two/b0.html", "two/b1.html"], ["b0", "b1"]]]);
  expect(projected.preparation).toMatchObject({ revision: "b".repeat(64), current: ["two/b1.html"],
    pageHashes: { one: "1".repeat(32), two: "3".repeat(32) } });
  expect(projected.preparation).not.toHaveProperty("stalePages");
  expect(projected.frames.map((entry) => entry.file)).toEqual(["one/a0.html", "two/b1.html"]);
  const drifted = projectDesignMutationSnapshot(previous, ack("9".repeat(32)));
  expect(drifted.preparation!.stalePages).toEqual(["one"]);
  expect(drifted.preparation!.pageHashes).toEqual({ two: "3".repeat(32) });
  expect(drifted.preparation!.descriptions.slice(0, 2)).toEqual(kept);
  const foreign = projectDesignMutationSnapshot({ ...previous, directoryId: "design_other" }, ack("1".repeat(32)));
  expect(foreign.preparation!.stalePages).toEqual(["one"]);
  expect(foreign.preparation!.descriptions.map((entry) => entry.file)).toEqual(["two/b0.html", "two/b1.html"]);
});

it("keeps a page's canvas items across a page-scoped acknowledgement, which carries none", () => {
  const items = [{ id: "s1", kind: "section" as const, x: 0, y: 0, width: 200, text: "Flow" }];
  const previous: DesignWorkspaceSnapshotWire = { ...snapshot(), frames: [],
    pages: [{ id: "one", title: "One", folder: "one", frameFiles: [], frameIds: [], items, itemsNotShown: 2 }],
    preparation: { revision: "a".repeat(64), epoch: 1, current: [], errors: {}, descriptions: [], pageHashes: { one: "1".repeat(32) } } };
  const ack: DesignWorkspaceSnapshotWire = { ...snapshot(), preparation: undefined, frames: [],
    pageCatalog: { revision: "b".repeat(64), pages: [{ id: "one", title: "One", folder: "one", count: 0, hash: "1".repeat(32) }], frames: [] } };
  expect(projectDesignMutationSnapshot(previous, ack).pages![0]!.items).toBe(items);
  expect(projectDesignMutationSnapshot(previous, ack).pages![0]!.itemsNotShown).toBe(2);
  const foreign = projectDesignMutationSnapshot({ ...previous, directoryId: "design_other" }, ack).pages![0]!;
  expect(foreign).not.toHaveProperty("items");
  expect(foreign).not.toHaveProperty("itemsNotShown");
});

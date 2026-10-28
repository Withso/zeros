import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";

const mocks = vi.hoisted(() => ({ designFrameRuntime: vi.fn() }));
vi.mock("../../../platform/bridge/design-frame-runtime", () => ({ designFrameRuntime: mocks.designFrameRuntime }));
vi.mock("../../../platform/bridge/active-bridge", () => ({ onActiveBridgeConnected: vi.fn(() => () => {}) }));

import { resetDesignSelectionWorkflowsForTests, warmDesignNodeDetails, warmDesignNodeDetailsWindow } from "../state/design-selection";
import { designRuntimeFrameState, resetDesignRuntimeStoreForTests, useDesignRuntimeStore } from "../state/design-runtime-store";
import { useDesignWorkspaceUiStore } from "../state/design-workspace-ui";
import { designBackgroundWork } from "../state/design-background-work";

const VERSION = "1".repeat(24);
const details = (oid: string, sourceVersion = VERSION): DesignRuntimeNodeDetails => ({
  sourceVersion, oid, tag: "div", name: oid, text: null, selector: `[data-oid="${oid}"]`, visible: true,
  breadcrumb: [oid], rect: { x: 0, y: 0, width: 10, height: 10 }, styles: {},
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  resetDesignSelectionWorkflowsForTests();
  resetDesignRuntimeStoreForTests();
  useDesignWorkspaceUiStore.setState({ byWorkspace: {} });
  vi.clearAllMocks();
});
afterEach(() => resetDesignSelectionWorkflowsForTests());

it("reads a focused row's exact details latest-only, without hovering it", async () => {
  const first = deferred<DesignRuntimeNodeDetails>();
  const reads: string[] = [];
  const runtime = {
    sourceVersion: VERSION,
    isActive: () => true,
    getNodeDetails: vi.fn((oid: string) => {
      reads.push(oid);
      return oid === "a" ? first.promise : Promise.resolve(details(oid));
    }),
  };
  mocks.designFrameRuntime.mockReturnValue(runtime);
  const input = { workspaceId: "ws", folder: "/design", frame: "home.html", sourceVersion: VERSION };
  warmDesignNodeDetails({ ...input, nodeId: "a" });
  // Keyboard travel past b to c while a is in flight: only the latest queues.
  warmDesignNodeDetails({ ...input, nodeId: "b" });
  warmDesignNodeDetails({ ...input, nodeId: "c" });
  first.resolve(details("a"));
  await vi.waitFor(() => expect(designRuntimeFrameState("ws", "home.html")?.detailsByNode.c).toBeDefined());
  expect(reads).toEqual(["a", "c"]);
  expect(designRuntimeFrameState("ws", "home.html")?.detailsByNode.a?.oid).toBe("a");
  expect(useDesignRuntimeStore.getState().byWorkspace.ws?.hoveredNodeId).toBeNull();
  // Cached exact details need no read.
  warmDesignNodeDetails({ ...input, nodeId: "c" });
  expect(reads).toEqual(["a", "c"]);
});

it("never publishes another generation's readback", async () => {
  const runtime = { sourceVersion: VERSION, isActive: () => true, getNodeDetails: vi.fn(async (oid: string) => details(oid, "2".repeat(24))) };
  mocks.designFrameRuntime.mockReturnValue(runtime);
  warmDesignNodeDetails({ workspaceId: "ws", folder: "/design", frame: "home.html", sourceVersion: VERSION, nodeId: "a" });
  await vi.waitFor(() => expect(runtime.getNodeDetails).toHaveBeenCalledTimes(1));
  await Promise.resolve();
  expect(designRuntimeFrameState("ws", "home.html")).toBeUndefined();
  mocks.designFrameRuntime.mockReturnValue(undefined);
  warmDesignNodeDetails({ workspaceId: "ws", folder: "/design", frame: "home.html", sourceVersion: VERSION, nodeId: "b" });
  await Promise.resolve();
  expect(designRuntimeFrameState("ws", "home.html")).toBeUndefined();
});

it("drops a warm reply when the retained surface becomes inactive", async () => {
  const pending = deferred<DesignRuntimeNodeDetails>();
  let active = true;
  const runtime = { sourceVersion: VERSION, isActive: () => active, getNodeDetails: vi.fn(() => pending.promise) };
  mocks.designFrameRuntime.mockReturnValue(runtime);
  warmDesignNodeDetails({ workspaceId: "ws", folder: "/design", frame: "home.html", sourceVersion: VERSION, nodeId: "a" });
  expect(runtime.getNodeDetails).toHaveBeenCalledTimes(1);
  active = false;
  pending.resolve(details("a"));
  await pending.promise;
  await Promise.resolve();
  expect(designRuntimeFrameState("ws", "home.html")).toBeUndefined();
});

it("does not publish an old directory's reply after A to B to A replacement", async () => {
  const pending = deferred<DesignRuntimeNodeDetails>();
  const runtime = { sourceVersion: VERSION, isActive: () => true, getNodeDetails: vi.fn(() => pending.promise) };
  mocks.designFrameRuntime.mockReturnValue(runtime);
  useDesignWorkspaceUiStore.getState().bindDirectory("ws", "directory-a");
  warmDesignNodeDetails({ workspaceId: "ws", folder: "/design", frame: "home.html", sourceVersion: VERSION, nodeId: "a" });
  useDesignWorkspaceUiStore.getState().bindDirectory("ws", "directory-b");
  useDesignWorkspaceUiStore.getState().bindDirectory("ws", "directory-a");
  pending.resolve(details("a"));
  await pending.promise;
  await Promise.resolve();
  expect(designRuntimeFrameState("ws", "home.html")).toBeUndefined();
});

it("does not reintroduce an older generation on the same runtime connection", async () => {
  const pending = deferred<DesignRuntimeNodeDetails>();
  const runtime = { sourceVersion: VERSION, isActive: () => true, getNodeDetails: vi.fn(() => pending.promise) };
  mocks.designFrameRuntime.mockReturnValue(runtime);
  warmDesignNodeDetails({ workspaceId: "ws", folder: "/design", frame: "home.html", sourceVersion: VERSION, nodeId: "a" });
  runtime.sourceVersion = "2".repeat(24);
  pending.resolve(details("a"));
  await pending.promise;
  await Promise.resolve();
  expect(designRuntimeFrameState("ws", "home.html")).toBeUndefined();
});

it("retires an in-flight warming queue on reset", async () => {
  const pending = deferred<DesignRuntimeNodeDetails>();
  const runtime = { sourceVersion: VERSION, isActive: () => true, getNodeDetails: vi.fn(() => pending.promise) };
  mocks.designFrameRuntime.mockReturnValue(runtime);
  const input = { workspaceId: "ws", folder: "/design", frame: "home.html", sourceVersion: VERSION };
  warmDesignNodeDetails({ ...input, nodeId: "a" });
  warmDesignNodeDetails({ ...input, nodeId: "b" });
  resetDesignSelectionWorkflowsForTests();
  pending.resolve(details("a"));
  await pending.promise;
  await Promise.resolve();
  expect(runtime.getNodeDetails).toHaveBeenCalledTimes(1);
  expect(designRuntimeFrameState("ws", "home.html")).toBeUndefined();
});

const target = (nodeId: string) => ({ frame: "home.html", sourceVersion: VERSION, nodeId });
const windowInput = (nodes: readonly string[]) => ({ workspaceId: "ws", folder: "/design", targets: nodes.map(target) });

it("warms a bounded visible window without selection, hover or duplicate cached reads", async () => {
  const runtime = { sourceVersion: VERSION, isActive: () => true, getNodeDetails: vi.fn(async (oid: string) => details(oid)) };
  mocks.designFrameRuntime.mockReturnValue(runtime);
  const nodes = Array.from({ length: 1000 }, (_, index) => `node-${index}`);
  const stop = warmDesignNodeDetailsWindow(windowInput([nodes[0], ...nodes]));
  await vi.waitFor(() => expect(designRuntimeFrameState("ws", "home.html")?.detailOrder).toHaveLength(12));
  expect(runtime.getNodeDetails.mock.calls.map(([oid]) => oid)).toEqual(nodes.slice(0, 12));
  expect(useDesignRuntimeStore.getState().byWorkspace.ws.hoveredNodeId).toBeNull();
  expect(useDesignWorkspaceUiStore.getState().byWorkspace.ws).toBeUndefined();
  stop();
  warmDesignNodeDetailsWindow(windowInput(nodes.slice(0, 12)));
  await Promise.resolve();
  expect(runtime.getNodeDetails).toHaveBeenCalledTimes(12);
});

it("keeps selected inspector values resident while warming new visible rows at the cache limit", async () => {
  const selectedDetails = details("selected");
  const store = useDesignRuntimeStore.getState();
  store.publishNodeDetails("ws", "/design", "home.html", selectedDetails, VERSION);
  for (let index = 0; index < 31; index++)
    store.publishNodeDetails("ws", "/design", "home.html", details(`cached-${index}`), VERSION);
  useDesignWorkspaceUiStore.getState().setSelection("ws", "home.html", "selected");
  const runtime = { sourceVersion: VERSION, isActive: () => true, getNodeDetails: vi.fn(async (oid: string) => details(oid)) };
  mocks.designFrameRuntime.mockReturnValue(runtime);
  warmDesignNodeDetailsWindow(windowInput(["cold"]));
  await vi.waitFor(() => expect(designRuntimeFrameState("ws", "home.html")?.detailsByNode.cold).toBeDefined());
  const frame = designRuntimeFrameState("ws", "home.html")!;
  expect(frame.detailsByNode.selected).toBe(selectedDetails);
  expect(Object.keys(frame.detailsByNode)).toHaveLength(32);
  expect(frame.detailsByNode["cached-0"]).toBeUndefined();
});

it("gives focus intent immediate priority while visible-window admission is paused", async () => {
  const resume = designBackgroundWork.pause();
  const runtime = { sourceVersion: VERSION, isActive: () => true, getNodeDetails: vi.fn(async (oid: string) => details(oid)) };
  mocks.designFrameRuntime.mockReturnValue(runtime);
  const stop = warmDesignNodeDetailsWindow(windowInput(["background-a", "background-b"]));
  expect(runtime.getNodeDetails).not.toHaveBeenCalled();
  warmDesignNodeDetails({ workspaceId: "ws", folder: "/design", ...target("focused") });
  expect(runtime.getNodeDetails.mock.calls.map(([oid]) => oid)).toEqual(["focused"]);
  await vi.waitFor(() => expect(designRuntimeFrameState("ws", "home.html")?.detailsByNode.focused).toBeDefined());
  stop();
  resume();
  expect(runtime.getNodeDetails).toHaveBeenCalledTimes(1);
});

it("replaces an in-flight window, aborts its reply and keeps only the new window", async () => {
  const first = deferred<DesignRuntimeNodeDetails>();
  const runtime = { sourceVersion: VERSION, isActive: () => true,
    getNodeDetails: vi.fn((oid: string, _signal?: AbortSignal) => oid === "old-a" ? first.promise : Promise.resolve(details(oid))) };
  mocks.designFrameRuntime.mockReturnValue(runtime);
  warmDesignNodeDetailsWindow(windowInput(["old-a", "old-b"]));
  await vi.waitFor(() => expect(runtime.getNodeDetails).toHaveBeenCalledTimes(1));
  const signal = runtime.getNodeDetails.mock.calls[0][1];
  warmDesignNodeDetailsWindow(windowInput(["new-a", "new-b"]));
  expect(signal?.aborted).toBe(true);
  first.resolve(details("old-a"));
  await vi.waitFor(() => expect(designRuntimeFrameState("ws", "home.html")?.detailsByNode["new-b"]).toBeDefined());
  expect(runtime.getNodeDetails.mock.calls.map(([oid]) => oid)).toEqual(["old-a", "new-a", "new-b"]);
  expect(designRuntimeFrameState("ws", "home.html")?.detailsByNode["old-a"]).toBeUndefined();
});

it("cancels a window before idle admission and does not start work on a hidden runtime", async () => {
  const resume = designBackgroundWork.pause();
  let active = true;
  const runtime = { sourceVersion: VERSION, isActive: () => active, getNodeDetails: vi.fn(async (oid: string) => details(oid)) };
  mocks.designFrameRuntime.mockReturnValue(runtime);
  const stop = warmDesignNodeDetailsWindow(windowInput(["cancelled"]));
  stop();
  active = false;
  warmDesignNodeDetailsWindow(windowInput(["hidden"]));
  warmDesignNodeDetails({ workspaceId: "ws", folder: "/design", ...target("hidden-focus") });
  resume();
  await designBackgroundWork.schedule("test-drained", async () => {});
  expect(runtime.getNodeDetails).not.toHaveBeenCalled();
});

it("an empty replacement window retires rows that are no longer visible", async () => {
  const resume = designBackgroundWork.pause();
  const runtime = { sourceVersion: VERSION, isActive: () => true, getNodeDetails: vi.fn(async (oid: string) => details(oid)) };
  mocks.designFrameRuntime.mockReturnValue(runtime);
  warmDesignNodeDetailsWindow(windowInput(["old-row"]));
  warmDesignNodeDetailsWindow(windowInput([]));
  resume();
  await designBackgroundWork.schedule("test-drained", async () => {});
  expect(runtime.getNodeDetails).not.toHaveBeenCalled();
});

it("continues a visible window after a node disappears", async () => {
  const runtime = { sourceVersion: VERSION, isActive: () => true, getNodeDetails: vi.fn(async (oid: string) => {
    if (oid === "deleted") throw new Error("Node no longer exists");
    return details(oid);
  }) };
  mocks.designFrameRuntime.mockReturnValue(runtime);
  warmDesignNodeDetailsWindow(windowInput(["deleted", "present"]));
  await vi.waitFor(() => expect(designRuntimeFrameState("ws", "home.html")?.detailsByNode.present).toBeDefined());
  expect(designRuntimeFrameState("ws", "home.html")?.detailsByNode.deleted).toBeUndefined();
});

it("bounds held owner queues and fences evicted replies", async () => {
  const pending = deferred<DesignRuntimeNodeDetails>();
  const runtime = { sourceVersion: VERSION, isActive: () => true, getNodeDetails: vi.fn((_oid: string, _signal?: AbortSignal) => pending.promise) };
  mocks.designFrameRuntime.mockReturnValue(runtime);
  for (let index = 0; index < 33; index++)
    warmDesignNodeDetails({ workspaceId: `workspace-${index}`, folder: `/design/${index}`, ...target("a") });
  expect(runtime.getNodeDetails.mock.calls[0][1]?.aborted).toBe(true);
  expect(runtime.getNodeDetails.mock.calls.at(-1)?.[1]?.aborted).toBe(false);
  pending.resolve(details("a"));
  await vi.waitFor(() => expect(designRuntimeFrameState("workspace-32", "home.html")?.detailsByNode.a).toBeDefined());
  expect(designRuntimeFrameState("workspace-0", "home.html")).toBeUndefined();
  expect(Object.keys(useDesignRuntimeStore.getState().byWorkspace)).toHaveLength(32);
});

it("keeps Personal and organization Local replies in their exact owner caches", async () => {
  const personal = deferred<DesignRuntimeNodeDetails>();
  const organization = deferred<DesignRuntimeNodeDetails>();
  let personalActive = true;
  const personalRuntime = { sourceVersion: VERSION, isActive: () => personalActive, getNodeDetails: () => personal.promise };
  const organizationRuntime = { sourceVersion: VERSION, isActive: () => true, getNodeDetails: () => organization.promise };
  mocks.designFrameRuntime.mockImplementation((id: string) => id === "personal-local" ? personalRuntime : organizationRuntime);
  warmDesignNodeDetails({ workspaceId: "personal-local", folder: "/personal/design", ...target("a") });
  personalActive = false;
  warmDesignNodeDetails({ workspaceId: "organization-local", folder: "/organization/design", ...target("a") });
  personal.resolve(details("a"));
  organization.resolve(details("a"));
  await vi.waitFor(() => expect(designRuntimeFrameState("organization-local", "home.html")?.detailsByNode.a).toBeDefined());
  expect(designRuntimeFrameState("personal-local", "home.html")).toBeUndefined();
  expect(useDesignRuntimeStore.getState().byWorkspace["organization-local"].folder).toBe("/organization/design");
  personalActive = true;
  warmDesignNodeDetails({ workspaceId: "personal-local", folder: "/personal/design", ...target("a") });
  await vi.waitFor(() => expect(designRuntimeFrameState("personal-local", "home.html")?.detailsByNode.a).toBeDefined());
  expect(useDesignRuntimeStore.getState().byWorkspace["personal-local"].folder).toBe("/personal/design");
});

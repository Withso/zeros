import { beforeEach, expect, it, vi } from "vitest";
import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";

const mocks = vi.hoisted(() => ({ designFrameRuntime: vi.fn() }));
vi.mock("../../../platform/bridge/design-frame-runtime", () => ({ designFrameRuntime: mocks.designFrameRuntime }));
vi.mock("../../../platform/bridge/active-bridge", () => ({ onActiveBridgeConnected: vi.fn(() => () => {}) }));

import { resetDesignSelectionWorkflowsForTests, warmDesignNodeDetails } from "../state/design-selection";
import { designRuntimeFrameState, resetDesignRuntimeStoreForTests, useDesignRuntimeStore } from "../state/design-runtime-store";

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
  vi.clearAllMocks();
});

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

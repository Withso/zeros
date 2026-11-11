import type { DesignRuntimeNodeDetails, DesignRuntimeNodeState } from "@zeros/protocol/design-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runtime: vi.fn() }));
vi.mock("../../../platform/bridge/design-frame-runtime", () => ({ designFrameRuntime: mocks.runtime }));

import {
  designHeldDetails,
  forgetDesignHeldStateRelease,
  holdDesignNodeState,
  releaseDesignNodeState,
  releaseDesignNodeStateOn,
  releaseDesignNodeStateUnless,
  resetDesignHeldStateForTests,
  useDesignHeldStateStore,
} from "../state/design-held-state";

const SOURCE_VERSION = "1".repeat(24);
const NEXT_SOURCE_VERSION = "2".repeat(24);
const KEY = { workspaceId: "w", frame: "home.html", sourceVersion: SOURCE_VERSION, nodeId: "send" };

function details(state?: DesignRuntimeNodeState, sourceVersion = SOURCE_VERSION): DesignRuntimeNodeDetails {
  return {
    sourceVersion,
    oid: "send",
    tag: "button",
    name: "Send",
    text: "Send",
    selector: '[data-oid="send"]',
    visible: true,
    breadcrumb: [],
    rect: { x: 0, y: 0, width: 80, height: 32 },
    styles: { backgroundColor: state ? "blue" : "navy" },
    states: ["hover", "focus-visible"],
    ...(state ? { heldState: state } : {}),
  };
}

function fakeRuntime(sourceVersion = SOURCE_VERSION) {
  const holds: Array<{ nodeId: string; state: DesignRuntimeNodeState; holdId: string; resolve: (value: DesignRuntimeNodeDetails) => void; reject: (error: Error) => void }> = [];
  const runtime = {
    sourceVersion,
    supports: vi.fn((method: string) => method === "holdNodeState" || method === "releaseNodeState"),
    holdNodeState: vi.fn((nodeId: string, state: DesignRuntimeNodeState, holdId: string) =>
      new Promise<DesignRuntimeNodeDetails>((resolve, reject) => holds.push({ nodeId, state, holdId, resolve, reject }))),
    releaseNodeState: vi.fn(() => Promise.resolve({ released: true })),
  };
  return { runtime, holds };
}

const held = () => useDesignHeldStateStore.getState().byWorkspace.w;

describe("held layer state", () => {
  beforeEach(() => {
    resetDesignHeldStateForTests();
    mocks.runtime.mockReset();
  });

  it("publishes one held reply under its exact key, once", async () => {
    const { runtime, holds } = fakeRuntime();
    mocks.runtime.mockReturnValue(runtime);
    const updates = vi.fn();
    const stop = useDesignHeldStateStore.subscribe(updates);
    try {
      holdDesignNodeState({ ...KEY, state: "hover" });
      expect(runtime.holdNodeState).toHaveBeenCalledExactlyOnceWith("send", "hover", expect.any(String));
      // Nothing is published until the reply: one request, one update.
      expect(updates).not.toHaveBeenCalled();
      holds[0]!.resolve(details("hover"));
      await vi.waitFor(() => expect(held()?.details?.heldState).toBe("hover"));
      expect(updates).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
    expect(designHeldDetails(useDesignHeldStateStore.getState(), KEY)?.styles.backgroundColor).toBe("blue");
    expect(designHeldDetails(useDesignHeldStateStore.getState(), { ...KEY, nodeId: "other" })).toBeNull();
    expect(designHeldDetails(useDesignHeldStateStore.getState(), { ...KEY, sourceVersion: NEXT_SOURCE_VERSION })).toBeNull();
    expect(designHeldDetails(useDesignHeldStateStore.getState(), { ...KEY, frame: "about.html" })).toBeNull();
  });

  it("drops a reply that arrives after Back to Default and lets go without waiting", async () => {
    const { runtime, holds } = fakeRuntime();
    mocks.runtime.mockReturnValue(runtime);
    holdDesignNodeState({ ...KEY, state: "hover" });
    releaseDesignNodeState("w");
    // Sent at once, behind the hold on the same port.
    expect(runtime.releaseNodeState).toHaveBeenCalledTimes(1);
    holds[0]!.resolve(details("hover"));
    await Promise.resolve();
    await Promise.resolve();
    expect(held()).toBeUndefined();
    // Nothing more is sent for the stale reply.
    expect(runtime.releaseNodeState).toHaveBeenCalledTimes(1);
  });

  it("keeps only the latest pick", async () => {
    const { runtime, holds } = fakeRuntime();
    mocks.runtime.mockReturnValue(runtime);
    holdDesignNodeState({ ...KEY, state: "hover" });
    holdDesignNodeState({ ...KEY, state: "focus-visible" });
    holds[1]!.resolve(details("focus-visible"));
    holds[0]!.resolve(details("hover"));
    await vi.waitFor(() => expect(held()?.details?.heldState).toBe("focus-visible"));
    await Promise.resolve();
    expect(held()?.state).toBe("focus-visible");
    expect(runtime.releaseNodeState).not.toHaveBeenCalled();
  });

  it("refuses a reply from another document or generation, and a reply that is not held", async () => {
    const first = fakeRuntime();
    const replacement = fakeRuntime(NEXT_SOURCE_VERSION);
    mocks.runtime.mockReturnValue(first.runtime);
    holdDesignNodeState({ ...KEY, state: "hover" });
    mocks.runtime.mockReturnValue(replacement.runtime);
    first.holds[0]!.resolve(details("hover"));
    await Promise.resolve();
    await Promise.resolve();
    expect(held()).toBeUndefined();

    mocks.runtime.mockReturnValue(first.runtime);
    holdDesignNodeState({ ...KEY, state: "hover" });
    first.holds[1]!.resolve(details());
    await Promise.resolve();
    await Promise.resolve();
    expect(held()).toBeUndefined();
    // The runtime may still be holding it: let go.
    expect(first.runtime.releaseNodeState).toHaveBeenCalledTimes(1);

    holdDesignNodeState({ ...KEY, state: "hover" });
    first.holds[2]!.resolve(details("hover", NEXT_SOURCE_VERSION));
    await Promise.resolve();
    await Promise.resolve();
    expect(held()).toBeUndefined();
  });

  it("sends nothing to a runtime that cannot hold, or of another generation", () => {
    const { runtime } = fakeRuntime();
    runtime.supports.mockReturnValue(false);
    mocks.runtime.mockReturnValue(runtime);
    holdDesignNodeState({ ...KEY, state: "hover" });
    expect(runtime.holdNodeState).not.toHaveBeenCalled();
    const stale = fakeRuntime(NEXT_SOURCE_VERSION);
    mocks.runtime.mockReturnValue(stale.runtime);
    holdDesignNodeState({ ...KEY, state: "hover" });
    expect(stale.runtime.holdNodeState).not.toHaveBeenCalled();
    releaseDesignNodeState("w");
    expect(stale.runtime.releaseNodeState).not.toHaveBeenCalled();
  });

  it("clears the slot when the runtime let go of that hold by itself, and only that hold", async () => {
    const { runtime, holds } = fakeRuntime();
    mocks.runtime.mockReturnValue(runtime);
    holdDesignNodeState({ ...KEY, state: "hover" });
    const firstId = holds[0]!.holdId;
    holds[0]!.resolve(details("hover"));
    await vi.waitFor(() => expect(held()).toBeDefined());
    forgetDesignHeldStateRelease("w", "home.html", "another");
    expect(held()).toBeDefined();
    forgetDesignHeldStateRelease("w", "about.html", firstId);
    expect(held()).toBeDefined();
    forgetDesignHeldStateRelease("w", "home.html", firstId);
    expect(held()).toBeUndefined();
    expect(runtime.releaseNodeState).not.toHaveBeenCalled();
  });

  it("lets go when a canvas gesture starts on the held layer only", async () => {
    const { runtime, holds } = fakeRuntime();
    mocks.runtime.mockReturnValue(runtime);
    holdDesignNodeState({ ...KEY, state: "hover" });
    holds[0]!.resolve(details("hover"));
    await vi.waitFor(() => expect(held()).toBeDefined());
    releaseDesignNodeStateOn("w", "home.html", "other");
    releaseDesignNodeStateOn("w", "about.html", "send");
    expect(runtime.releaseNodeState).not.toHaveBeenCalled();
    releaseDesignNodeStateOn("w", "home.html", "send");
    expect(runtime.releaseNodeState).toHaveBeenCalledTimes(1);
    expect(held()).toBeUndefined();
    // A gesture with nothing held sends nothing.
    releaseDesignNodeStateOn("w", "home.html", "send");
    expect(runtime.releaseNodeState).toHaveBeenCalledTimes(1);
  });

  it("lets go when the panel shows another layer, page, frame or generation, or hides", async () => {
    const { runtime, holds } = fakeRuntime();
    mocks.runtime.mockReturnValue(runtime);
    const shown = { frame: "home.html", sourceVersion: SOURCE_VERSION, nodeId: "send" };
    for (const next of [
      { ...shown, nodeId: "other" },
      { ...shown, frame: "about.html" },
      { ...shown, sourceVersion: NEXT_SOURCE_VERSION },
      null,
    ]) {
      holdDesignNodeState({ ...KEY, state: "hover" });
      holds.at(-1)!.resolve(details("hover"));
      await vi.waitFor(() => expect(held()).toBeDefined());
      const sent = runtime.releaseNodeState.mock.calls.length;
      releaseDesignNodeStateUnless("w", shown);
      expect(held()).toBeDefined();
      releaseDesignNodeStateUnless("w", next);
      expect(held()).toBeUndefined();
      expect(runtime.releaseNodeState).toHaveBeenCalledTimes(sent + 1);
    }
    // A pending hold for another layer lets go too.
    holdDesignNodeState({ ...KEY, state: "hover" });
    releaseDesignNodeStateUnless("w", { ...shown, nodeId: "other" });
    holds.at(-1)!.resolve(details("hover"));
    await Promise.resolve();
    await Promise.resolve();
    expect(held()).toBeUndefined();
  });

  it("does not touch other workspaces", async () => {
    const { runtime, holds } = fakeRuntime();
    mocks.runtime.mockReturnValue(runtime);
    holdDesignNodeState({ ...KEY, state: "hover" });
    holds[0]!.resolve(details("hover"));
    await vi.waitFor(() => expect(held()).toBeDefined());
    releaseDesignNodeState("elsewhere");
    expect(held()).toBeDefined();
    expect(runtime.releaseNodeState).not.toHaveBeenCalled();
  });
});

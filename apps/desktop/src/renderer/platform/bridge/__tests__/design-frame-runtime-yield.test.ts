import { describe, expect, it, vi } from "vitest";
import { DESIGN_RUNTIME_PROTOCOL, DESIGN_RUNTIME_VERSION, type DesignRuntimeSnapshot } from "@zeros/protocol/design-runtime";
import { connectDesignFrameRuntime, designFrameRuntime } from "../design-frame-runtime";
const SOURCE_VERSION = "111111111111111111111111";
const NEXT_SOURCE_VERSION = "222222222222222222222222";
const capabilities = {
  methods: [
    "getSnapshot",
    "getElementAtLoc",
    "getElementsInRect",
    "getNodeDetails",
    "getMatchedStyles",
    "setNodeVisibility",
    "setTheme",
    "previewStyles",
    "commitStyles",
    "previewText",
    "clearPreviewText",
    "previewMotion",
    "clearPreviewStyles",
    "captureScreenshot",
  ] as const,
  cancellation: true as const,
  typedErrors: true as const,
  sourcePinned: true as const,
  maxStyleProperties: 64,
  maxMatchedDeclarations: 256,
  maxCapturePixels: 2_000_000,
};

function snapshot(
  revision: number,
  sourceVersion = SOURCE_VERSION,
): DesignRuntimeSnapshot {
  return {
    sourceVersion,
    revision,
    tree: [],
    warnings: [],
    frame: {
      sourceVersion,
      oid: "frame",
      tag: "main",
      name: "Frame",
      text: null,
      selector: '[data-oid="frame"]',
      visible: true,
      breadcrumb: ["main · Frame"],
      rect: { x: 0, y: 0, width: 100, height: 80 },
      styles: {},
    },
    viewport: { width: 100, height: 80, scrollX: 0, scrollY: 0 },
  };
}

// Both document buffers of a frame can load at once during a replacement (the
// frame's documents remount): the inactive displayed one must never take the
// connecting slot from the active incoming one.
describe("a frame whose two documents connect at once", () => {
  const host = { setTimeout: (work: () => void, ms: number) => setTimeout(work, ms) as unknown as number, clearTimeout: (id: number) => clearTimeout(id) };
  const connector = (workspace: string) => (version: string, isActive: () => boolean = () => true) => {
    const source = { postMessage: vi.fn() };
    const connection = connectDesignFrameRuntime(workspace, "home.html", version, { contentWindow: source } as unknown as HTMLIFrameElement, { isActive }, host);
    const port = source.postMessage.mock.calls[0]![1].transfer[0] as MessagePort;
    const ready = () => port.postMessage({ protocol: DESIGN_RUNTIME_PROTOCOL, version: DESIGN_RUNTIME_VERSION, type: "event", event: "ready",
      payload: { sourceVersion: version, capabilities, snapshot: { ...snapshot(1), sourceVersion: version, frame: { ...snapshot(1).frame, sourceVersion: version } } } });
    return { connection, port, ready };
  };

  it("lets the incoming document take the frame when the inactive displayed one reloads after it", async () => {
    const connect = connector("stale-incoming");
    const outgoing = connect(SOURCE_VERSION);
    outgoing.ready();
    await vi.waitFor(() => expect(designFrameRuntime("stale-incoming", "home.html")).toBe(outgoing.connection));
    const incoming = connect(NEXT_SOURCE_VERSION);
    const reloaded = connect(SOURCE_VERSION, () => false);
    reloaded.ready();
    incoming.ready();
    await vi.waitFor(() => expect(designFrameRuntime("stale-incoming", "home.html")).toBe(incoming.connection));
    for (const entry of [outgoing, incoming, reloaded]) { entry.connection.destroy(true); entry.port.close(); }
  });

  it("gives the frame back to the displayed document that yielded when the incoming one is abandoned", async () => {
    const connect = connector("stale-abandoned");
    const outgoing = connect(SOURCE_VERSION);
    outgoing.ready();
    await vi.waitFor(() => expect(designFrameRuntime("stale-abandoned", "home.html")).toBe(outgoing.connection));
    const incoming = connect(NEXT_SOURCE_VERSION);
    const reloaded = connect(SOURCE_VERSION, () => false);
    reloaded.ready();
    await vi.waitFor(() => expect(reloaded.connection.supports("getSnapshot")).toBe(true));
    // An undo straight after the edit: the replacement unmounts before its handshake.
    incoming.connection.destroy(true);
    expect(reloaded.connection.reinstate?.()).toBe(true);
    expect(designFrameRuntime("stale-abandoned", "home.html")).toBe(reloaded.connection);
    // A connection that never handshook cannot take the frame.
    const silent = connect(SOURCE_VERSION, () => false);
    expect(silent.connection.reinstate?.()).toBe(false);
    for (const entry of [outgoing, incoming, reloaded, silent]) { entry.connection.destroy(true); entry.port.close(); }
  });
});

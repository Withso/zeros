import { describe, expect, it, vi } from "vitest";

import { bridgeDesignHistory, bridgeDesignSnapshot, bridgeDesignTransferNode, bridgeDesignDuplicateFrame, bridgeDesignMoveFrames, bridgeDesignUpdateCanvas, bridgeDesignCreateFrame, bridgeDesignDeleteFrame, bridgeDesignUpdateStyles, bridgeDesignSetText, bridgeDesignWriteHtml, bridgeDesignInsertAsset, isDesignWorkspaceSnapshotWire, normalizeDesignWorkspaceSnapshotPages } from "../design-bridge";
import type { RuntimeClient } from "../ws-client";
import { DESIGN_MUTATION_SNAPSHOTS_CAPABILITY } from "@zeros/protocol/design-catalog";

function scopedSnapshot() {
  const descriptor = { id: "home", pageId: "screens", source: "page-1/home.html", title: "Home", kind: "html" as const,
    x: 0, y: 0, width: 390, height: 844, z: 0, order: 0, preparation: "unprepared" as const };
  return { protocolCapability: null, directoryId: "design_a", mutationCatalog: { revision: "a".repeat(64), frames: [descriptor] },
    pages: [{ id: "screens", title: "Screens", folder: "page-1", frameFiles: [descriptor.source], frameIds: [descriptor.id] }],
    frames: [{ file: descriptor.source, frameId: descriptor.id, pageId: descriptor.pageId, kind: "frame" as const,
      title: descriptor.title, x: 0, y: 0, width: 390, height: 844, z: 0, nodeCount: 1, modifiedAt: 1, sourceVersion: "a".repeat(24) }],
    tokens: [], assets: [], tokenSourceVersion: "a".repeat(24),
    lint: { workspacePath: "/work/design", checkedFiles: [], violations: [], healedOids: 0 } };
}

describe("Design bridge read budgets", () => {
  it("validates scoped mutation descriptors against complete page and source identities", () => {
    const snapshot = scopedSnapshot();
    expect(isDesignWorkspaceSnapshotWire(snapshot)).toBe(true);
    for (const pages of [{}, [null], [{ ...snapshot.pages[0], frameIds: ["wrong"] }], [],
      [{ ...snapshot.pages[0], frameFiles: [] }]]) {
      expect(isDesignWorkspaceSnapshotWire({ ...snapshot, pages })).toBe(false);
    }
    for (const frames of [[null], [{ ...snapshot.frames[0], frameId: "wrong" }], [{ ...snapshot.frames[0], width: 400 }],
      [snapshot.frames[0], snapshot.frames[0]]]) {
      expect(isDesignWorkspaceSnapshotWire({ ...snapshot, frames })).toBe(false);
    }
    expect(isDesignWorkspaceSnapshotWire({ ...snapshot, mutationCatalog: { ...snapshot.mutationCatalog,
      frames: [...snapshot.mutationCatalog.frames, ...snapshot.mutationCatalog.frames] } })).toBe(false);
  });

  it.each([
    ["personal-local", true, true], ["organization-local", true, true],
    ["legacy-local", false, false], ["cloud://org/workspace", true, false],
  ] as const)("negotiates scoped mutation acknowledgements only on capable Local engines: %s", async (workspaceId, capable, scoped) => {
    const snapshot = scopedSnapshot();
    const request = vi.fn(async (message: { op: string }) => ({ type: "WORKSPACE_RESPONSE", result: {
      frame: message.op === "design.node.transfer" ? snapshot.frames[0]!.file : snapshot.frames[0], nodeId: "root", snapshot,
      geometry: { x: 0, y: 0, w: 390, h: 844, z: 0 }, deleted: { file: snapshot.frames[0]!.file },
      mutation: { changed: true, frame: { file: snapshot.frames[0]!.file } } } }));
    const bridge = { request, supportsEngineCapability: (capability: string) => capable && capability === DESIGN_MUTATION_SNAPSHOTS_CAPABILITY } as unknown as RuntimeClient;
    await bridgeDesignDuplicateFrame(bridge, workspaceId, snapshot.frames[0]!.file);
    await bridgeDesignTransferNode(bridge, workspaceId, { frame: snapshot.frames[0]!.file, sourceVersion: "a".repeat(24),
      nodeId: "root", x: 0, y: 0, w: 390, h: 844, z: 0 });
    const geometry = { x: 0, y: 0, w: 390, h: 844, z: 0 };
    await bridgeDesignUpdateCanvas(bridge, workspaceId, snapshot.frames[0]!.file, geometry);
    await bridgeDesignMoveFrames(bridge, workspaceId, [{ frame: snapshot.frames[0]!.file, from: geometry, to: geometry }]);
    await bridgeDesignCreateFrame(bridge, workspaceId, "New");
    await bridgeDesignDeleteFrame(bridge, workspaceId, snapshot.frames[0]!.file);
    const node = { frame: snapshot.frames[0]!.file, nodeId: "root", sourceVersion: "a".repeat(24) };
    await bridgeDesignUpdateStyles(bridge, workspaceId, { ...node, styles: { padding: "4px" } });
    await bridgeDesignSetText(bridge, workspaceId, { ...node, text: "Text" });
    await bridgeDesignWriteHtml(bridge, workspaceId, { ...node, html: "<span></span>", mode: "append" });
    await bridgeDesignInsertAsset(bridge, workspaceId, { frame: node.frame, sourceVersion: node.sourceVersion, assetPath: "assets/a.png", x: 0, y: 0 });
    expect(request).toHaveBeenCalledTimes(10);
    for (const [message] of request.mock.calls as unknown as Array<[{ params: Record<string, unknown> }]>) {
      expect(message.params.snapshotMode).toBe(scoped ? "scoped" : undefined);
    }
  });

  it("refuses a style acknowledgement whose scoped frame does not match its catalog", async () => {
    const snapshot = scopedSnapshot();
    snapshot.frames[0]!.width = 400;
    const bridge = { request: vi.fn(async () => ({ type: "WORKSPACE_RESPONSE", result: {
      mutation: { changed: true, frame: { file: snapshot.frames[0]!.file } }, snapshot } })) } as unknown as RuntimeClient;
    await expect(bridgeDesignUpdateStyles(bridge, "local", { frame: snapshot.frames[0]!.file, nodeId: "root",
      sourceVersion: "a".repeat(24), styles: { padding: "4px" } })).rejects.toThrow("malformed");
  });

  it("refuses a copy acknowledgement whose source does not match its catalog", async () => {
    const snapshot = scopedSnapshot();
    snapshot.frames[0]!.frameId = "unrelated";
    const bridge = { request: vi.fn(async () => ({ type: "WORKSPACE_RESPONSE", result: { frame: snapshot.frames[0], snapshot } })) } as unknown as RuntimeClient;
    await expect(bridgeDesignDuplicateFrame(bridge, "local", snapshot.frames[0]!.file)).rejects.toThrow("malformed");
  });

  it.each(["ws_local", "cloud://org/workspace"])("never downgrades a copy to a destructive move on an unsupported %s engine", async workspaceId => {
    const bridge = { request: vi.fn(), supportsEngineCapability: () => false } as unknown as RuntimeClient;
    await expect(bridgeDesignTransferNode(bridge, workspaceId, { frame: "a.html", sourceVersion: "a".repeat(24), nodeId: "a", duplicateNodeId: "copy",
      x: 0, y: 0, w: 100, h: 100, z: 0 })).rejects.toThrow(/copy|update/i);
    await expect(bridgeDesignDuplicateFrame(bridge, workspaceId, "a.html", undefined, { sourceVersion: "a".repeat(24), geometry: { x: 20, y: 30, w: 100, h: 100, z: 1 } })).rejects.toThrow(/copy|update/i);
    expect(bridge.request).not.toHaveBeenCalled();
  });
  it.each([undefined, "page_123"])("accepts optional history page metadata from old/new engines: %s", async historyPageId => {
    const result = { result: null, snapshot: { protocolCapability: null, frames: [] }, ...(historyPageId ? { historyPageId } : {}) };
    const bridge = { request: vi.fn(async () => ({ type: "WORKSPACE_RESPONSE", result })) } as unknown as RuntimeClient;
    expect(await bridgeDesignHistory(bridge, "ws_local_design", null, "undo")).toEqual(result);
  });
  it.each([null, 3, "../page", ""])("rejects malformed history page metadata: %j", async historyPageId => {
    const bridge = { request: vi.fn(async () => ({ type: "WORKSPACE_RESPONSE", result: { result: null, historyPageId, snapshot: { protocolCapability: null, frames: [] } } })) } as unknown as RuntimeClient;
    await expect(bridgeDesignHistory(bridge, "ws_local_design", null, "undo")).rejects.toThrow("malformed");
  });
  it.each(["undo", "redo"] as const)("preserves the local %s wire contract without cloud source versions", async direction => {
    const request = vi.fn(async () => ({ type: "WORKSPACE_RESPONSE", result: { result: null, snapshot: { protocolCapability: null, frames: [] } } }));
    const bridge = { request } as unknown as RuntimeClient;

    await bridgeDesignHistory(bridge, "ws_local_design", "page-1/home.html", direction);

    expect(request).toHaveBeenCalledExactlyOnceWith({
      type: "WORKSPACE_REQUEST", op: `design.history.${direction}`,
      params: { workspaceId: "ws_local_design", frame: "page-1/home.html" },
    }, expect.anything());
  });

  it("normalizes older engine snapshots to one legacy root page", () => {
    const snapshot = {
      protocolCapability: null,
      frames: [{ file: "home.html", sourceVersion: "a".repeat(24), title: "Home", width: 390, height: 844, x: 0, y: 0, z: 0, nodeCount: 1, modifiedAt: 0 }],
      tokens: [],
      tokenSourceVersion: "a".repeat(24), assets: [],
      lint: { workspacePath: "/work/design", checkedFiles: ["home.html"], violations: [], healedOids: 0 },
    } as Parameters<typeof normalizeDesignWorkspaceSnapshotPages>[0];
    const normalized = normalizeDesignWorkspaceSnapshotPages(snapshot);
    expect(normalized.pages).toEqual([{ id: "main", title: "Design", folder: "", frameFiles: ["home.html"] }]);
    expect(normalized.frames[0].pageId).toBe("main");
    expect(normalizeDesignWorkspaceSnapshotPages(normalized)).toBe(normalized);
  });
  it("gives the aggregate cold snapshot enough time to scan a large document", async () => {
    let timeoutMs: number | undefined;
    const bridge = {
      request: async (
        _message: { type: string; op?: string },
        timeout?: number,
      ) => {
        timeoutMs = timeout;
        return {
          type: "WORKSPACE_RESPONSE",
          op: "design.snapshot",
          result: {
            snapshot: {
              protocolCapability: null,
              frames: [],
              tokens: [],
              tokenSourceVersion: "0".repeat(24),
              assets: [],
              lint: {
                workspacePath: "/work/design",
                checkedFiles: [],
                violations: [],
                healedOids: 0,
              },
            },
          },
        };
      },
    } as unknown as RuntimeClient;

    await bridgeDesignSnapshot(bridge, "ws_design");

    expect(timeoutMs).toBe(30_000);
  });

  it("rejects malformed or mismatched page frame owners without throwing", () => {
    const snapshot = {
      protocolCapability: null, pages: [{ id: "screens", title: "Screens", folder: "page-1", frameFiles: ["page-1/home.html"] }],
      frames: [{ file: "page-1/home.html", pageId: "screens" }], tokens: [], assets: [], tokenSourceVersion: "a".repeat(24),
      lint: { workspacePath: "/work/design", checkedFiles: [], violations: [], healedOids: 0 },
    };
    expect(isDesignWorkspaceSnapshotWire(snapshot)).toBe(true);
    for (const frames of [[null], [{ file: "page-1/home.html", pageId: "checkout" }], [{ file: "checkout/home.html" }], [snapshot.frames[0], snapshot.frames[0]]])
      expect(isDesignWorkspaceSnapshotWire({ ...snapshot, frames })).toBe(false);
  });
});

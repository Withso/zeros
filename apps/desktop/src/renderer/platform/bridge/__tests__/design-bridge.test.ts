import { describe, expect, it, vi } from "vitest";

import { bridgeDesignSnapshot, isDesignWorkspaceSnapshotWire, normalizeDesignWorkspaceSnapshotPages } from "../design-bridge";
import type { RuntimeClient } from "../ws-client";
import { bridgeCloudDesignUploadAsset, rememberDesignDirectoryIdentity } from "../design-bridge";

describe("Design bridge read budgets", () => {
  it("pins uploads to their captured cloud directory without changing Local dispatch", async () => {
    const request = vi.fn().mockRejectedValue(new Error("disconnected"));
    const bridge = { request } as unknown as RuntimeClient;
    const input = { directoryId: "design_original", frame: "page-1/home.html", sourceVersion: "a".repeat(24),
      name: "pixel.png", mimeType: "image/png" as const, data: "image", x: 0, y: 0 };
    await expect(bridgeCloudDesignUploadAsset(bridge, "ws_local", input)).rejects.toThrow(/cloud/);
    expect(request).not.toHaveBeenCalled();
    rememberDesignDirectoryIdentity("cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", "design_successor");
    await expect(bridgeCloudDesignUploadAsset(bridge, "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", input)).rejects.toThrow("disconnected");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ op: "design.asset.upload",
      params: { workspaceId: "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", ...input } }), expect.anything());
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

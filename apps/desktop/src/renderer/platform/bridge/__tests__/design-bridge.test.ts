import { describe, expect, it } from "vitest";

import { bridgeDesignSnapshot, isDesignWorkspaceSnapshotWire, normalizeDesignWorkspaceSnapshotPages } from "../design-bridge";
import type { RuntimeClient } from "../ws-client";

describe("Design bridge read budgets", () => {
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

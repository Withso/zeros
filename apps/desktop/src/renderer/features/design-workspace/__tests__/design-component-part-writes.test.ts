import { beforeEach, describe, expect, it, vi } from "vitest";
import { designComponentPartNodeId } from "@zeros/protocol/design-runtime";

const bridge = vi.hoisted(() => ({
  applyTransaction: vi.fn(),
  updateStyles: vi.fn(),
  setText: vi.fn(),
  writeHtml: vi.fn(),
  transferNode: vi.fn(),
  foundationOpen: vi.fn(),
}));
vi.mock("../../../platform/git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../platform/git")>()),
  designApplyTransaction: bridge.applyTransaction,
  designUpdateStyles: bridge.updateStyles,
  designSetText: bridge.setText,
  designWriteHtml: bridge.writeHtml,
  designTransferNode: bridge.transferNode,
  designFoundationOpen: bridge.foundationOpen,
}));
vi.mock("../../../platform/bridge/active-bridge", () => ({
  getActiveBridge: () => null,
  onActiveBridgeConnected: vi.fn(() => () => {}),
}));

import { applyDesignNodeAction } from "../state/design-node-actions";
import { canEditDesignNodeText } from "../design-node-capabilities";
import { designWorkspaceSnapshotCache } from "../state/design-workspace-cache";
import { useDesignWorkspaceUiStore } from "../state/design-workspace-ui";
import {
  appendDesignNodeHtmlCached,
  applyDesignEditCached,
  applyDesignTransactionCached,
  setDesignNodeTextCached,
  transferDesignNodeCached,
  updateDesignNodeStylesCached,
} from "../state/design-workspace-cache";

const part = designComponentPartNodeId("inst", "cc-send");
const frame = { file: "home.html", sourceVersion: "a".repeat(24) };
const refused = /part of a component instance/i;
const transaction = (operation: Record<string, unknown>) => ({
  schemaVersion: 1 as const, transactionId: "desktop:t", documentId: "harness:home.html", baseRevision: "r",
  actor: { kind: "human" as const, id: "desktop" }, intent: "Edit", createdAt: 1, operations: [{ operationId: "o", ...operation }],
});

describe("an instance's parts receive only style writes", () => {
  beforeEach(() => {
    for (const mock of Object.values(bridge)) mock.mockReset();
  });
  const nothingSent = () => {
    for (const mock of [bridge.applyTransaction, bridge.updateStyles, bridge.setText, bridge.writeHtml, bridge.transferNode])
      expect(mock).not.toHaveBeenCalled();
  };

  it("sends a style commit, which the engine stores as the instance's override", async () => {
    bridge.updateStyles.mockRejectedValue(new Error("engine reached"));
    await expect(updateDesignNodeStylesCached("ws", { ...frame, frame: frame.file, nodeId: part, styles: { width: "10px" } })).rejects.toThrow("engine reached");
    expect(bridge.updateStyles).toHaveBeenCalledWith("ws", expect.objectContaining({ nodeId: part, styles: { width: "10px" } }));
  });

  it("refuses a text edit", async () => {
    await expect(setDesignNodeTextCached("ws", { ...frame, frame: frame.file, nodeId: part, text: "Go" })).rejects.toThrow(refused);
    nothingSent();
  });

  it("refuses a paste or an insert into a part", async () => {
    await expect(appendDesignNodeHtmlCached("ws", { ...frame, frame: frame.file, nodeId: part, html: "<p>x</p>" })).rejects.toThrow(refused);
    nothingSent();
  });

  it("refuses a drag that moves a part, or moves a layer into one", async () => {
    await expect(transferDesignNodeCached("ws", { frame: frame.file, sourceVersion: frame.sourceVersion, nodeId: part, parentId: "root", index: 0 } as never)).rejects.toThrow(refused);
    await expect(transferDesignNodeCached("ws", { frame: frame.file, sourceVersion: frame.sourceVersion, nodeId: "card", parentId: part, index: 0 } as never)).rejects.toThrow(refused);
    nothingSent();
  });

  it("offers no text edit on a part", () => {
    const text = { oid: part, tag: "span", name: "span", text: "Send", textEditable: true } as never;
    expect(canEditDesignNodeText(text)).toBe(false);
    expect(canEditDesignNodeText({ ...(text as object), oid: "cc-send" } as never)).toBe(true);
  });

  it("refuses a delete, a duplicate or a layout action in a transaction", async () => {
    await expect(applyDesignTransactionCached("ws", frame.file, transaction({ type: "node.delete", nodeId: part }) as never)).rejects.toThrow(refused);
    await expect(applyDesignEditCached("ws", frame, transaction({ type: "node.duplicate", nodeId: part }) as never)).rejects.toThrow(refused);
    await expect(applyDesignTransactionCached("ws", frame.file, transaction({ type: "node.move", nodeId: "card", parentId: part, index: 0 }) as never)).rejects.toThrow(refused);
    nothingSent();
  });
  it("refuses Delete, Duplicate and Copy on a selected part before anything is shown or sent", async () => {
    designWorkspaceSnapshotCache.setData("ws", { frames: [{ ...frame, title: "Home", width: 10, height: 10, x: 0, y: 0, z: 0, nodeCount: 1, modifiedAt: 1 }] } as never);
    useDesignWorkspaceUiStore.getState().setSelection("ws", frame.file, part);
    for (const action of ["delete", "duplicate"] as const)
      await expect(applyDesignNodeAction({ workspaceId: "ws", folder: "/w", action, copy: action === "duplicate" })).rejects.toThrow(refused);
    nothingSent();
  });
});

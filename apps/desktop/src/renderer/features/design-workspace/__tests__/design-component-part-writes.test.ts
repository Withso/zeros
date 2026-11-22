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

describe("an instance's parts receive no writes", () => {
  beforeEach(() => {
    for (const mock of Object.values(bridge)) mock.mockReset();
  });
  const nothingSent = () => {
    for (const mock of [bridge.applyTransaction, bridge.updateStyles, bridge.setText, bridge.writeHtml, bridge.transferNode])
      expect(mock).not.toHaveBeenCalled();
  };

  it("refuses a style commit, which would write an override on the instance", async () => {
    await expect(updateDesignNodeStylesCached("ws", { ...frame, frame: frame.file, nodeId: part, styles: { width: "10px" } })).rejects.toThrow(refused);
    await expect(applyDesignEditCached("ws", frame, transaction({ type: "node.set-styles", nodeId: part, styles: { opacity: "0.5" } }) as never)).rejects.toThrow(refused);
    await expect(applyDesignTransactionCached("ws", frame.file, transaction({ type: "node.set-styles", nodeId: part, styles: { opacity: "0.5" } }) as never)).rejects.toThrow(refused);
    nothingSent();
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

describe("an instance host takes only placement and size styles", () => {
  const hostRefused = /component instance changes through its Controls/i;
  const engineReached = new Error("engine reached");
  beforeEach(() => {
    for (const mock of Object.values(bridge)) mock.mockReset();
    bridge.updateStyles.mockRejectedValue(engineReached);
    bridge.applyTransaction.mockRejectedValue(engineReached);
    designWorkspaceSnapshotCache.setData("ws", { lint: { workspacePath: "/w", violations: [] }, frames: [{ ...frame, title: "Home", width: 10, height: 10, x: 0, y: 0, z: 0, nodeCount: 1, modifiedAt: 1,
      instances: { key: "0".repeat(16), components: {}, hosts: { inst: { component: "chip", attributes: {} } } } }] } as never);
  });
  const styles = (nodeId: string, values: Record<string, string | null>) =>
    updateDesignNodeStylesCached("ws", { ...frame, frame: frame.file, nodeId, styles: values });

  it("refuses a visual style on the host before anything is sent", async () => {
    await expect(styles("inst", { opacity: "0.5" })).rejects.toThrow(hostRefused);
    await expect(styles("inst", { width: "10px", "background-color": "red" })).rejects.toThrow(hostRefused);
    await expect(applyDesignEditCached("ws", frame, transaction({ type: "node.set-styles", nodeId: "inst", styles: { padding: "4px" } }) as never)).rejects.toThrow(hostRefused);
    await expect(applyDesignTransactionCached("ws", frame.file, transaction({ type: "node.set-styles", nodeId: "inst", styles: { scale: "2" } }) as never)).rejects.toThrow(hostRefused);
    expect(bridge.updateStyles).not.toHaveBeenCalled();
    expect(bridge.applyTransaction).not.toHaveBeenCalled();
  });

  it("sends placement, size, layout-child sizing and removals", async () => {
    for (const values of <Record<string, string | null>[]>[
      { width: "10px", height: null, "min-width": "1px", "max-height": "none" },
      { left: "4px", top: "2px", position: "absolute", rotate: "5deg", transform: "rotate(5deg)", "transform-origin": "0 0", translate: "1px 2px" },
      { "flex-grow": "1", "flex-shrink": "0", "flex-basis": "auto", "align-self": "stretch", "justify-self": "start" },
      { opacity: null, "background-color": null },
    ]) await expect(styles("inst", values)).rejects.toBe(engineReached);
    expect(bridge.updateStyles).toHaveBeenCalledTimes(4);
  });

  it("lets a parent's layout change write its bookkeeping on a host child, and refuses any other custom property", async () => {
    // Flow → None on the instance's parent: the parent's own style, and each child's place and origin.
    const flowNone = { ...transaction({ type: "node.set-styles", nodeId: "card", styles: { display: "block" } }),
      operations: [
        { operationId: "a", type: "node.set-styles", nodeId: "card", styles: { display: "block", gap: null } },
        { operationId: "b", type: "node.set-styles", nodeId: "inst", styles: { position: "absolute", left: "4px", top: "8px",
          "--zeros-layout-origin-flow": "row", "--zeros-layout-x": "4px", "--zeros-layout-y": "8px" } },
      ] };
    await expect(applyDesignTransactionCached("ws", frame.file, flowNone as never)).rejects.toBe(engineReached);
    for (const property of ["--zd-x", "--anything"])
      await expect(styles("inst", { [property]: "1px" })).rejects.toThrow(hostRefused);
  });

  it("refuses a new part override on a host, and lets one be removed", async () => {
    const attribute = (value: string | null) => transaction({ type: "node.set-attribute", nodeId: "inst", attribute: "zd-style-cc-send", value });
    await expect(applyDesignEditCached("ws", frame, attribute("opacity: 0.5") as never)).rejects.toThrow(hostRefused);
    await expect(applyDesignTransactionCached("ws", frame.file, attribute("opacity: 0.5") as never)).rejects.toThrow(hostRefused);
    expect(bridge.applyTransaction).not.toHaveBeenCalled();
    await expect(applyDesignTransactionCached("ws", frame.file, attribute(null) as never)).rejects.toBe(engineReached);
    // Other attributes are the instance's controls.
    await expect(applyDesignTransactionCached("ws", frame.file, transaction({ type: "node.set-attribute", nodeId: "inst", attribute: "width", value: "40" }) as never))
      .rejects.toBe(engineReached);
  });

  it("checks each host in a transaction and leaves plain layers alone", async () => {
    const two = (hostStyles: Record<string, string>) => ({ ...transaction({ type: "node.set-styles", nodeId: "inst", styles: hostStyles }),
      operations: [{ operationId: "a", type: "node.set-styles", nodeId: "inst", styles: hostStyles }, { operationId: "b", type: "node.set-styles", nodeId: "card", styles: { opacity: "0.5" } }] });
    await expect(applyDesignTransactionCached("ws", frame.file, two({ opacity: "0.5" }) as never)).rejects.toThrow(hostRefused);
    expect(bridge.applyTransaction).not.toHaveBeenCalled();
    await expect(applyDesignTransactionCached("ws", frame.file, two({ width: "20px" }) as never)).rejects.not.toThrow(hostRefused);
    await expect(styles("card", { opacity: "0.5" })).rejects.toBe(engineReached);
    // An own-property check: a layer named like an Object member is not a host.
    await expect(styles("constructor", { opacity: "0.5" })).rejects.toBe(engineReached);
  });
});

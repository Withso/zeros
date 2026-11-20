import { describe, expect, it, vi } from "vitest";
import { DESIGN_COMPONENT_IDENTITY_CAPABILITY, DESIGN_COMPONENT_IDENTITY_PARAM } from "@zeros/protocol/design-catalog";
import {
  bridgeDesignDeleteCanvasItem,
  bridgeDesignCreateFrame,
  bridgeDesignCreatePage,
  bridgeDesignDeletePage,
  bridgeDesignDuplicateFrame,
  bridgeDesignMoveComponent,
  bridgeDesignPutCanvasItem,
  bridgeDesignRenamePage,
  bridgeDesignRenameFrame,
  bridgeDesignSelectPage,
  bridgeDesignUpdateTheme,
  rememberDesignDirectoryIdentity,
} from "../design-bridge";
import type { RuntimeClient } from "../ws-client";

const page = {
  id: "checkout",
  title: "Checkout",
  folder: "checkout",
  frameFiles: [],
};
const snapshot = {
  directoryId: "design_fixture",
  protocolCapability: null,
  pages: [page],
  frames: [],
  tokens: [],
  tokenSourceVersion: "a".repeat(24),
  assets: [],
  lint: {
    workspacePath: "/work/design",
    checkedFiles: [],
    violations: [],
    healedOids: 0,
  },
};

function client(result: unknown) {
  const request = vi.fn(async (input: { op: string }) => ({
    type: "WORKSPACE_RESPONSE",
    op: input.op,
    result,
  }));
  return { bridge: { request } as unknown as RuntimeClient, request };
}

function capableClient(result: unknown, capabilities: readonly string[]) {
  const response = client(result);
  return {
    ...response,
    bridge: {
      ...response.bridge,
      supportsEngineCapability: (capability: string) => capabilities.includes(capability),
    } as RuntimeClient,
  };
}

type AggregateMutation = {
  name: string;
  op: string;
  malformedReply: string;
  invoke: (bridge: RuntimeClient, workspaceId: string) => Promise<unknown>;
};

const aggregateMutations: AggregateMutation[] = [
  {
    name: "page create",
    op: "design.page.create",
    malformedReply: "design.page.create: malformed engine response",
    invoke: (bridge, workspaceId) => bridgeDesignCreatePage(bridge, workspaceId, "Purchase"),
  },
  {
    name: "page rename",
    op: "design.page.rename",
    malformedReply: "design.page.rename: malformed engine response",
    invoke: (bridge, workspaceId) => bridgeDesignRenamePage(bridge, workspaceId, "checkout", "Purchase"),
  },
  {
    name: "page delete",
    op: "design.page.delete",
    malformedReply: "design.page.delete: malformed engine response",
    invoke: (bridge, workspaceId) => bridgeDesignDeletePage(bridge, workspaceId, "checkout", []),
  },
  {
    name: "canvas item put",
    op: "design.canvas.item.put",
    malformedReply: "design.canvas.item.put: malformed engine response",
    invoke: (bridge, workspaceId) => bridgeDesignPutCanvasItem(bridge, workspaceId, "checkout", {
      kind: "note", x: 0, y: 0, width: 200, height: 80, text: "Note",
    }),
  },
  {
    name: "canvas item delete",
    op: "design.canvas.item.delete",
    malformedReply: "design.canvas.item.delete: malformed engine response",
    invoke: (bridge, workspaceId) => bridgeDesignDeleteCanvasItem(bridge, workspaceId, "checkout", "note-1"),
  },
  {
    name: "component move",
    op: "design.component.move",
    malformedReply: "design.component.move: malformed engine response",
    invoke: (bridge, workspaceId) => bridgeDesignMoveComponent(bridge, workspaceId, "card", "checkout"),
  },
  {
    name: "theme update",
    op: "design.themes.update",
    malformedReply: "design.themes.update: malformed engine response",
    invoke: (bridge, workspaceId) => bridgeDesignUpdateTheme(bridge, workspaceId, { id: "light", label: "Day" }),
  },
  {
    name: "frame rename",
    op: "design.frame.rename",
    malformedReply: "design.frame.rename: malformed engine response",
    invoke: (bridge, workspaceId) => bridgeDesignRenameFrame(bridge, workspaceId, "checkout/card.html", "Card"),
  },
];

describe("Design page bridge", () => {
  it("moves a component onto a page and checks the main is on that page", async () => {
    const moved = { file: "checkout/card.html", pageId: "checkout", title: "Card", component: "card" };
    const placed = { ...snapshot, pages: [{ ...page, frameFiles: ["checkout/card.html"] }] };
    const { bridge, request } = client({ frame: moved, snapshot: placed });
    expect((await bridgeDesignMoveComponent(bridge, "ws_pages", "card", "checkout")).frame).toEqual(moved);
    expect(request.mock.calls[0]?.[0]).toMatchObject({ op: "design.component.move", params: { workspaceId: "ws_pages", component: "card", pageId: "checkout" } });
    await expect(bridgeDesignMoveComponent(client({ frame: moved, snapshot }).bridge, "ws_pages", "card"))
      .rejects.toThrow("design.component.move: malformed engine response");
    await expect(bridgeDesignMoveComponent(client({ frame: { ...moved, component: "pill" }, snapshot: placed }).bridge, "ws_pages", "card"))
      .rejects.toThrow("malformed");
  });

  it("forwards lifecycle arguments and returns the confirmed page/snapshot", async () => {
    const { bridge, request } = client({ page, snapshot });
    expect(
      await bridgeDesignCreatePage(bridge, "ws_pages", "Checkout"),
    ).toMatchObject({ page, snapshot });
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      op: "design.page.create",
      params: { workspaceId: "ws_pages", title: "Checkout" },
    });
    await bridgeDesignRenamePage(bridge, "ws_pages", "checkout", "Checkout");
    expect(request.mock.calls[1]?.[0]).toMatchObject({
      op: "design.page.rename",
      params: {
        workspaceId: "ws_pages",
        pageId: "checkout",
        title: "Checkout",
      },
    });
    const deleted = client({
      deleted: { pageId: "checkout" },
      snapshot: {
        ...snapshot,
        pages: [{ ...page, id: "remaining", folder: "remaining" }],
      },
    });
    await bridgeDesignDeletePage(deleted.bridge, "ws_pages", "checkout", [
      "home",
    ]);
    expect(deleted.request.mock.calls[0]?.[0]).toMatchObject({
      op: "design.page.delete",
      params: {
        workspaceId: "ws_pages",
        pageId: "checkout",
        expectedFrameIds: ["home"],
      },
    });
  });

  it.each(aggregateMutations)("negotiates identity only for capable Local $name snapshots", async (mutation) => {
    const workspaceId = "ws_aggregate_local";
    const local = capableClient(null, [DESIGN_COMPONENT_IDENTITY_CAPABILITY]);
    await expect(mutation.invoke(local.bridge, workspaceId)).rejects.toThrow(mutation.malformedReply);
    const message = local.request.mock.calls[0]?.[0] as unknown as { op: string; params: Record<string, unknown> };
    expect(message.op).toBe(mutation.op);
    expect(message.params).toMatchObject({ workspaceId, [DESIGN_COMPONENT_IDENTITY_PARAM]: true });
    expect(message.params).not.toHaveProperty("snapshotMode");
    expect(message.params).not.toHaveProperty("knownPages");
  });

  it.each(aggregateMutations)("keeps legacy $name requests unchanged", async (mutation) => {
    const workspaceId = "ws_aggregate_legacy";
    const legacy = client(null);
    await expect(mutation.invoke(legacy.bridge, workspaceId)).rejects.toThrow(mutation.malformedReply);
    const message = legacy.request.mock.calls[0]?.[0] as unknown as { op: string; params: Record<string, unknown> };
    expect(message.op).toBe(mutation.op);
    expect(message.params).not.toHaveProperty(DESIGN_COMPONENT_IDENTITY_PARAM);
    expect(message.params).not.toHaveProperty("snapshotMode");
    expect(message.params).not.toHaveProperty("knownPages");
  });

  it.each(aggregateMutations)("keeps cloud $name requests fail-closed", async (mutation) => {
    const workspaceId = "cloud://org/aggregate";
    const cloud = capableClient(null, [DESIGN_COMPONENT_IDENTITY_CAPABILITY]);
    await expect(mutation.invoke(cloud.bridge, workspaceId)).rejects.toThrow(mutation.malformedReply);
    const message = cloud.request.mock.calls[0]?.[0] as unknown as { op: string; params: Record<string, unknown> };
    expect(message.op).toBe(mutation.op);
    expect(message.params).not.toHaveProperty(DESIGN_COMPONENT_IDENTITY_PARAM);
    expect(message.params).not.toHaveProperty("snapshotMode");
    expect(message.params).not.toHaveProperty("knownPages");
  });

  it("sends the hint's captured owner independently of a newer mutation binding", async () => {
    const { bridge, request } = client({ ok: true });
    rememberDesignDirectoryIdentity("ws_page_hint", "design_new");
    await bridgeDesignSelectPage(
      bridge,
      "ws_page_hint",
      "design_old",
      "checkout",
    );
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      op: "design.page.select",
      params: {
        workspaceId: "ws_page_hint",
        directoryId: "design_old",
        pageId: "checkout",
      },
    });
  });

  it("forwards explicit page ownership for normal/text creation and duplication", async () => {
    const frame = { file: "checkout/home.html", pageId: "checkout" };
    const { bridge, request } = client({ frame, snapshot });
    await bridgeDesignCreateFrame(
      bridge,
      "ws_pages",
      "Home",
      undefined,
      undefined,
      "checkout",
    );
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      params: { pageId: "checkout" },
    });
    await bridgeDesignCreateFrame(
      bridge,
      "ws_pages",
      "Text",
      undefined,
      { kind: "text", nodeId: "label", text: "Hello", fixedSize: false },
      "checkout",
    );
    expect(request.mock.calls[1]?.[0]).toMatchObject({
      params: { pageId: "checkout", kind: "text" },
    });
    await bridgeDesignDuplicateFrame(
      bridge,
      "ws_pages",
      "page-1/home.html",
      "checkout",
    );
    expect(request.mock.calls[2]?.[0]).toMatchObject({
      params: { frame: "page-1/home.html", pageId: "checkout" },
    });
  });

  it("rejects malformed catalogs and page replies that disagree with the returned snapshot", async () => {
    for (const result of [
      { page: { ...page, id: "missing" }, snapshot },
      { page, snapshot: { ...snapshot, pages: [] } },
      { page: { ...page, folder: "../checkout" }, snapshot },
    ])
      await expect(
        bridgeDesignCreatePage(client(result).bridge, "ws_pages", "Checkout"),
      ).rejects.toThrow(/malformed/i);
    await expect(
      bridgeDesignDeletePage(
        client({ deleted: { pageId: "checkout" }, snapshot }).bridge,
        "ws_pages",
        "checkout",
        [],
      ),
    ).rejects.toThrow(/malformed/i);
  });
});

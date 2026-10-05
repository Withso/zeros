import { describe, expect, it, vi } from "vitest";
import {
  bridgeDesignCreateFrame,
  bridgeDesignCreatePage,
  bridgeDesignDeletePage,
  bridgeDesignDuplicateFrame,
  bridgeDesignRenamePage,
  bridgeDesignSelectPage,
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

describe("Design page bridge", () => {
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

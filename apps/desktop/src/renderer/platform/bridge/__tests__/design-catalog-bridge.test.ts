import { describe, expect, it, vi } from "vitest";
import { bridgeDesignCatalog } from "../design-catalog-bridge";
import type { RuntimeClient } from "../ws-client";
import {
  DESIGN_CATALOG_READ_CAPABILITY,
  DESIGN_CATALOG_READ_OPERATION,
  type DesignCatalogOwner,
} from "@zeros/protocol/design-catalog";

function reply(owner: DesignCatalogOwner) {
  return {
    kind: "design-catalog",
    version: 1,
    status: "ready",
    owner,
    intent: 1,
    binding: "b".repeat(64),
    revision: "a".repeat(64),
    pages: [{ id: "p", title: "Page", folder: "page-1", count: 0 }],
    total: 0,
    offset: 0,
    frames: [],
    coverage: "complete",
    nextCursor: null,
  };
}
function client(result: unknown, supported = true) {
  return {
    supportsEngineCapability: vi.fn(() => supported),
    request: vi.fn(),
    requestConnected: vi.fn(async () => ({
      type: "WORKSPACE_RESPONSE",
      op: DESIGN_CATALOG_READ_OPERATION,
      result,
    })),
  };
}
describe("negotiated passive Design catalog reads", () => {
  it.each([null, "organization-local"])(
    "keeps Local owner %s and uses only a connected passive request",
    async (organizationId) => {
      const owner = {
        workspaceId: "local",
        directoryId: "design_test",
        placement: "local" as const,
        organizationId,
      };
      const bridge = client(reply(owner));
      const request = {
        version: 1 as const,
        workspaceId: owner.workspaceId,
        directoryId: owner.directoryId,
        intent: 1,
      };
      expect(
        await bridgeDesignCatalog(
          bridge as unknown as RuntimeClient,
          request,
          owner,
        ),
      ).toEqual(reply(owner));
      expect(bridge.supportsEngineCapability).toHaveBeenCalledWith(
        DESIGN_CATALOG_READ_CAPABILITY,
        owner.workspaceId,
      );
      expect(bridge.requestConnected).toHaveBeenCalledWith(
        {
          type: "WORKSPACE_REQUEST",
          op: DESIGN_CATALOG_READ_OPERATION,
          params: request,
        },
        10000,
      );
      expect(bridge.request).not.toHaveBeenCalled();
    },
  );
  it("refuses an old engine without sending or falling back to a full snapshot", async () => {
    const owner = {
      workspaceId: "local",
      directoryId: "design_test",
      placement: "local" as const,
      organizationId: null,
    };
    const bridge = client(reply(owner), false);
    const input = {
      version: 1 as const,
      workspaceId: owner.workspaceId,
      directoryId: owner.directoryId,
      intent: 1,
    };
    await expect(
      bridgeDesignCatalog(bridge as unknown as RuntimeClient, input, owner),
    ).rejects.toThrow(/does not support/);
    expect(bridge.requestConnected).not.toHaveBeenCalled();
    expect(bridge.request).not.toHaveBeenCalled();
  });
  it("rejects old responses and foreign owner or intent responses", async () => {
    const owner = {
      workspaceId: "local",
      directoryId: "design_test",
      placement: "local" as const,
      organizationId: null,
    };
    const input = {
      version: 1 as const,
      workspaceId: owner.workspaceId,
      directoryId: owner.directoryId,
      intent: 1,
    };
    for (const result of [
      { snapshot: { frames: [] } },
      { ...reply(owner), intent: 2 },
      reply({ ...owner, organizationId: "other" }),
    ])
      await expect(
        bridgeDesignCatalog(
          client(result) as unknown as RuntimeClient,
          input,
          owner,
        ),
      ).rejects.toThrow();
  });
});

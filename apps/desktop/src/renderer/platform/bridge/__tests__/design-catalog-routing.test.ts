import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WorkspaceRuntimeClient,
  type CloudPeer,
} from "../workspace-runtime-client";
import { bridgeDesignCatalog } from "../design-catalog-bridge";
import { cloudWorkspaceKey } from "../cloud-workspace-key";
import type { RuntimeClient, RuntimeExecutionIdentity } from "../ws-client";
import type { BridgeMessage } from "../messages";
import {
  DESIGN_CATALOG_READ_CAPABILITY,
  DESIGN_CATALOG_READ_OPERATION,
} from "@zeros/protocol/design-catalog";

const scope = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  engineWorkspaceId: "local-main",
  root: "/srv/zeros/workspace",
};
const key = cloudWorkspaceKey(scope);
const owner = {
  workspaceId: key,
  directoryId: "design_test",
  organizationId: scope.organizationId,
  placement: "cloud" as const,
};
const input = {
  version: 1 as const,
  workspaceId: key,
  directoryId: owner.directoryId,
  intent: 1,
};
const clients: WorkspaceRuntimeClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function fixture(localConnected = false, admitted = true) {
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("WebSocket", { OPEN: 1 });
  const native = {
    kind: "design-catalog",
    version: 1,
    status: "ready",
    owner: { ...owner, workspaceId: scope.engineWorkspaceId },
    intent: 1,
    binding: "b".repeat(64),
    revision: "a".repeat(64),
    pages: [{ id: "p", title: "Page", folder: "page-1", count: 0 }],
    frames: [],
    total: 0,
    offset: 0,
    coverage: "complete",
    nextCursor: null,
  };
  const requestConnected = vi.fn(
    async (_message: unknown, _timeout: unknown): Promise<BridgeMessage> =>
      ({
        type: "WORKSPACE_RESPONSE",
        op: DESIGN_CATALOG_READ_OPERATION,
        result: native,
      }) as unknown as BridgeMessage,
  );
  const request = vi.fn(async () => ({
    type: "WORKSPACE_RESPONSE",
    op: "chats.list",
    result: { chats: [], chatDeletions: [] },
  }));
  const peer = {
    request,
    requestConnected,
    supportsEngineCapability: vi.fn(() => true),
    status: "connected",
    on: () => () => {},
    onStatusChange: () => () => {},
    executionIdentity: {
      kind: "cloud",
      ...scope,
      generation: 7,
      authorityEpoch: 1,
      engineInstanceId: "engine-a",
    } satisfies RuntimeExecutionIdentity,
  };
  const open = vi.fn(
    async () =>
      ({
        client: peer as unknown as RuntimeClient,
        scope,
        release: vi.fn(),
        generation: 7,
      }) satisfies CloudPeer,
  );
  let identity = "account-a:generation-7";
  let accessible = true;
  const client = new WorkspaceRuntimeClient({
    open,
    identity: () => identity,
    canAccess: () => accessible,
    workspaces: () => [],
  });
  clients.push(client);
  if (admitted) await client.warmWorkspace(scope);
  open.mockClear();
  request.mockClear();
  const state = client as unknown as { handleIncoming(message: unknown): void };
  const localSend = vi.fn((text: string) => {
    const message = JSON.parse(text) as { id: string; op: string };
    state.handleIncoming({
      type: "WORKSPACE_ERROR",
      requestId: message.id,
      op: message.op,
      code: "WORKSPACE_NOT_FOUND",
      message: "Cloud key reached Local",
    });
  });
  if (localConnected) {
    Object.assign(client, {
      ws: { readyState: 1, send: localSend, close: () => {} },
      handshakeReady: true,
      _status: "connected",
    });
    state.handleIncoming({
      type: "ENGINE_READY",
      capabilities: [DESIGN_CATALOG_READ_CAPABILITY],
    });
  }
  return {
    client,
    peer,
    requestConnected,
    request,
    open,
    localSend,
    native,
    setIdentity: (value: string) => {
      identity = value;
    },
    denyAccess: () => {
      accessible = false;
    },
  };
}

describe("catalog reads through the real workspace facade", () => {
  it.each([null, scope.organizationId])(
    "keeps Local owner %s on its connected socket",
    async (organizationId) => {
      const f = await fixture(true, false);
      const localOwner = {
        ...owner,
        workspaceId: "/local/repo",
        placement: "local" as const,
        organizationId,
      };
      const params = { ...input, workspaceId: localOwner.workspaceId };
      const state = f.client as unknown as {
        handleIncoming(message: unknown): void;
      };
      f.localSend.mockImplementation((text) => {
        const message = JSON.parse(text) as { id: string; op: string };
        state.handleIncoming({
          type: "WORKSPACE_RESPONSE",
          requestId: message.id,
          op: message.op,
          result: { ...f.native, owner: localOwner },
        });
      });
      await expect(
        bridgeDesignCatalog(f.client, params, localOwner),
      ).resolves.toMatchObject({ status: "ready", owner: localOwner });
      expect(JSON.parse(f.localSend.mock.calls[0][0])).toMatchObject({
        op: DESIGN_CATALOG_READ_OPERATION,
        params,
      });
      expect(f.requestConnected).not.toHaveBeenCalled();
      expect(f.open).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "routes a connected cloud peer with Local connected=%s",
    async (localConnected) => {
      const f = await fixture(localConnected);
      await expect(
        bridgeDesignCatalog(f.client, input, owner),
      ).resolves.toMatchObject({ status: "ready", owner });
      expect(f.requestConnected).toHaveBeenCalledWith(
        expect.objectContaining({
          op: DESIGN_CATALOG_READ_OPERATION,
          params: { ...input, workspaceId: scope.engineWorkspaceId },
        }),
        10000,
      );
      expect(f.localSend).not.toHaveBeenCalled();
      expect(f.request).not.toHaveBeenCalled();
      expect(f.open).not.toHaveBeenCalled();
    },
  );

  it.each([
    "absent",
    "retired",
    "disconnected",
    "old-engine",
    "foreign-generation",
    "foreign-execution",
    "denied",
  ])(
    "refuses a %s peer without opening or falling back to Local",
    async (condition) => {
      const f = await fixture(true, condition !== "absent");
      if (condition === "retired") f.client.clearCloudConnections();
      if (condition === "disconnected") f.peer.status = "disconnected";
      if (condition === "old-engine")
        f.peer.supportsEngineCapability.mockReturnValue(false);
      if (condition === "foreign-generation")
        f.setIdentity("account-a:generation-8");
      if (condition === "foreign-execution")
        f.peer.executionIdentity.generation = 8;
      if (condition === "denied") f.denyAccess();
      await expect(
        bridgeDesignCatalog(f.client, input, owner),
      ).rejects.toThrow();
      expect(f.requestConnected).not.toHaveBeenCalled();
      expect(f.localSend).not.toHaveBeenCalled();
      expect(f.request).not.toHaveBeenCalled();
      expect(f.open).not.toHaveBeenCalled();
    },
  );

  it.each([
    "account-ABA",
    "generation",
    "execution",
    "access",
    "replacement",
    "disconnect",
  ])("fences a held reply across %s", async (transition) => {
    const f = await fixture();
    let release!: (message: BridgeMessage) => void;
    f.requestConnected.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const reading = bridgeDesignCatalog(f.client, input, owner);
    expect(f.requestConnected).toHaveBeenCalledOnce();
    if (transition === "account-ABA") f.client.clearCloudConnections();
    if (transition === "generation") f.setIdentity("account-a:generation-8");
    if (transition === "execution")
      f.peer.executionIdentity = {
        ...f.peer.executionIdentity,
        authorityEpoch: 2,
      };
    if (transition === "access") f.denyAccess();
    if (transition === "replacement") {
      f.client.clearCloudConnections();
      await f.client.warmWorkspace(scope);
      f.open.mockClear();
      f.request.mockClear();
    }
    if (transition === "disconnect") f.peer.status = "disconnected";
    release({
      type: "WORKSPACE_RESPONSE",
      op: DESIGN_CATALOG_READ_OPERATION,
      result: f.native,
    } as unknown as BridgeMessage);
    await expect(reading).rejects.toThrow();
    expect(f.open).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
    expect(f.localSend).not.toHaveBeenCalled();
  });
});

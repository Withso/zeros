import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZerosEngine } from "../zeros-engine";
import {
  DesignCatalogReader,
  type DesignCatalogAdmission,
  type DesignCatalogSnapshot,
} from "../design/catalog";
import { closeState, setStateRootForTesting } from "../git";
import type { TransportClient } from "../transport/types";
import type {
  DesignCatalogRead,
  DesignCatalogReply,
} from "@zeros/protocol/design-catalog";

const methods = ZerosEngine.prototype as unknown as {
  handleWorkspaceMessage(
    this: unknown,
    message: unknown,
    client: TransportClient,
  ): Promise<void>;
  clearOwnerBinding(this: unknown): void;
  verifyAccountBinding(
    this: unknown,
    message: unknown,
    client: TransportClient,
  ): Promise<void>;
};
const input: DesignCatalogRead = {
  version: 1,
  workspaceId: "local",
  directoryId: "design_test",
  intent: 1,
  limit: 1,
};
const snapshot: DesignCatalogSnapshot = {
  owner: {
    workspaceId: "local",
    directoryId: "design_test",
    placement: "local",
    organizationId: null,
  },
  binding: "root-a",
  revision: "a".repeat(64),
  pages: [{ id: "p", title: "Page", folder: "page-1", count: 2 }],
  frames: [0, 1].map((index) => ({
    id: `f${index}`,
    pageId: "p",
    source: `page-1/f${index}.html`,
    title: "Frame",
    kind: "html",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    z: index,
    order: index,
    preparation: "unprepared",
  })),
};
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-account-"));
  setStateRootForTesting(path.join(root, "state"));
});
afterEach(() => {
  closeState();
  setStateRootForTesting(null);
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function fixture(validate = async () => true) {
  const reader = new DesignCatalogReader();
  const client: TransportClient = {
    id: "same-local-socket",
    kind: "local",
    send: vi.fn(),
    close: vi.fn(),
  };
  const engine = {
    workspace: {
      lifecycleMutationWorkspaceId: () => null,
      isWriteOp: () => false,
      handle: (
        _op: string,
        params: DesignCatalogRead,
        opts: { catalogAdmission: DesignCatalogAdmission },
      ) =>
        reader.read(params, opts.catalogAdmission, {
          open: async () => snapshot,
          validate,
        }),
      retireDesignCatalog: (id: string) => reader.retire(id),
    },
    cloudWorker: null,
    cloudRuntimeAuthorityStopping: false,
    clientAccount: new Map(),
    clientAccountNames: new Map(),
    clientTokenExp: new Map(),
    ownerAccountSub: "account-a" as string | null,
    ownerAccountName: null,
    accountAuth: { required: false },
    verifyAccountToken: vi.fn(async () => ({
      sub: "account-a" as string | null,
    })),
    globalDesignTerritoryTransitionCount: 0,
    isHostRelayClient: () => false,
    slowWorkspaceOperations: { observe: vi.fn() },
    router: {
      getClient: () => client,
      broadcast: vi.fn(),
      broadcastExcept: vi.fn(),
    },
    reportEngineError: vi.fn(),
  };
  const send = async (params = input): Promise<DesignCatalogReply> => {
    vi.mocked(client.send).mockClear();
    await methods.handleWorkspaceMessage.call(
      engine,
      {
        type: "WORKSPACE_REQUEST",
        id: "catalog-request",
        source: "browser",
        timestamp: 1,
        op: "design.catalog.read",
        params,
      },
      client,
    );
    const message = vi.mocked(client.send).mock.calls.at(-1)?.[0];
    if (message?.type !== "WORKSPACE_RESPONSE")
      throw new Error("expected workspace response");
    return message.result as DesignCatalogReply;
  };
  const bind = async (sub: string | null) => {
    engine.verifyAccountToken.mockResolvedValueOnce({ sub });
    await methods.verifyAccountBinding.call(
      engine,
      {
        type: "CONNECTED",
        id: "binding",
        source: "browser",
        timestamp: 1,
        authToken: "synthetic-placeholder",
      },
      client,
    );
  };
  return { engine, send, bind };
}

describe("Local catalog account-binding lifetime", () => {
  it.each([true, false])(
    "refuses a cursor after account A to B to A, sign-out=%s",
    async (signOut) => {
      const f = fixture();
      const first = await f.send();
      if (first.status !== "ready" || !first.nextCursor)
        throw new Error("expected cursor");
      if (signOut) methods.clearOwnerBinding.call(f.engine);
      await f.bind("account-b");
      await f.bind("account-a");
      expect(
        await f.send({ ...input, cursor: first.nextCursor }),
      ).toMatchObject({ status: "unavailable" });
    },
  );

  it.each([true, false])(
    "fences a held read across account A to B to A, sign-out=%s",
    async (signOut) => {
      let release!: (valid: boolean) => void;
      let entered!: () => void;
      const gate = new Promise<boolean>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const f = fixture(async () => {
        entered();
        return gate;
      });
      const reading = f.send();
      await started;
      if (signOut) methods.clearOwnerBinding.call(f.engine);
      await f.bind("account-b");
      await f.bind("account-a");
      release(true);
      expect(await reading).toMatchObject({
        status: "unavailable",
        reason: "authority-lost",
      });
    },
  );

  it("preserves valid pagination through unchanged-account reverification and unavailable claims", async () => {
    const f = fixture();
    const first = await f.send();
    if (first.status !== "ready" || !first.nextCursor)
      throw new Error("expected cursor");
    await f.bind("account-a");
    await f.bind(null);
    expect(await f.send({ ...input, cursor: first.nextCursor })).toMatchObject({
      status: "ready",
      offset: 1,
    });
  });

  it("keeps unsigned offline Local reads valid but retires their execution on explicit sign-out", async () => {
    const f = fixture();
    f.engine.ownerAccountSub = null;
    const first = await f.send();
    if (first.status !== "ready" || !first.nextCursor)
      throw new Error("expected cursor");
    expect(await f.send({ ...input, cursor: first.nextCursor })).toMatchObject({
      status: "ready",
      offset: 1,
    });
    methods.clearOwnerBinding.call(f.engine);
    expect(await f.send({ ...input, cursor: first.nextCursor })).toMatchObject({
      status: "unavailable",
    });
    expect(await f.send()).toMatchObject({ status: "ready" });
  });
});

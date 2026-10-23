import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DESIGN_CATALOG_READ_CAPABILITY,
  DESIGN_CATALOG_READ_OPERATION,
  designCatalogBatchSchema,
  type DesignCatalogBatch,
  type DesignCatalogOwner,
  type DesignCatalogRead,
} from "@zeros/protocol/design-catalog";
import {
  WorkspaceRuntimeClient,
  type CloudPeer,
} from "../../../platform/bridge/workspace-runtime-client";
import { cloudWorkspaceKey } from "../../../platform/bridge/cloud-workspace-key";
import type {
  RuntimeClient,
  RuntimeExecutionIdentity,
} from "../../../platform/bridge/ws-client";
import {
  DesignCatalogReadAdapter,
  type DesignCatalogReadAuthority,
} from "../state/design-catalog-read-adapter";

const scope = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  engineWorkspaceId: "local-main",
  root: "/srv/zeros/workspace",
};
const clients: WorkspaceRuntimeClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function held<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function lifetime(owner: DesignCatalogOwner) {
  const controller = new AbortController();
  let epoch = 0;
  const authority: DesignCatalogReadAuthority = {
    owner,
    signal: controller.signal,
    isCurrent: () => epoch === 0,
  };
  return {
    authority,
    retire: () => controller.abort(),
    awayAndBack: () => {
      epoch += 2;
    },
  };
}

function packet(
  owner: DesignCatalogOwner,
  total = 2,
  offset = 0,
  count = total - offset,
  intent = 1,
): DesignCatalogBatch {
  return {
    kind: "design-catalog",
    version: 1,
    status: "ready",
    owner,
    binding: "b".repeat(64),
    revision: "a".repeat(64),
    intent,
    pages: [{ id: "page", title: "Page", folder: "page-1", count: total }],
    total,
    offset,
    frames: Array.from({ length: count }, (_, index) => ({
      id: `frame_${offset + index}`,
      pageId: "page",
      source: `page-1/frame-${offset + index}.html`,
      title: `Frame ${offset + index}`,
      kind: "html",
      x: offset + index,
      y: 0,
      width: 1280,
      height: 800,
      z: 0,
      order: offset + index,
      preparation: "unprepared",
    })),
    coverage: offset === 0 && count === total ? "complete" : "partial",
    nextCursor: offset + count === total ? null : `opaque-${offset + count}`,
  };
}

interface RetainedCatalogTask {
  header: Pick<
    DesignCatalogBatch,
    "owner" | "binding" | "revision" | "pages"
  > | null;
  frames: readonly Readonly<DesignCatalogBatch["frames"][number]>[];
  sources: ReadonlySet<string>;
  cursors: ReadonlySet<string>;
  reserved: boolean;
}

function retainedTasks(
  adapter: DesignCatalogReadAdapter,
): RetainedCatalogTask[] {
  return [...(adapter as unknown as { work: Set<RetainedCatalogTask> }).work];
}

function retainedPayloadBytes(task: RetainedCatalogTask): number {
  const dataBytes = task.header
    ? JSON.stringify({
        kind: "coherent-design-catalog",
        owner: task.header.owner,
        binding: task.header.binding,
        revision: task.header.revision,
        pages: task.header.pages,
        frames: task.frames,
      }).length * 2
    : 0;
  return (
    dataBytes +
    [...task.sources, ...task.cursors].reduce(
      (bytes, value) => bytes + value.length * 2,
      0,
    )
  );
}

function longSourcePacket(
  owner: DesignCatalogOwner,
  total: number,
  offset: number,
  count: number,
  intent: number,
): DesignCatalogBatch {
  const reply = packet(owner, total, offset, count, intent);
  for (const frame of reply.frames)
    frame.source = `page-1/${"A".repeat(3950)}-${owner.directoryId}-${frame.id.toUpperCase()}.html`;
  return designCatalogBatchSchema.parse(reply);
}

async function fixture(
  placement: "personal" | "organization-local" | "cloud" = "organization-local",
  admitted = true,
  connected = true,
) {
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("WebSocket", { OPEN: 1 });
  const owner: DesignCatalogOwner = {
    workspaceId:
      placement === "cloud" ? cloudWorkspaceKey(scope) : "/local/repo",
    directoryId: "design_test",
    organizationId: placement === "personal" ? null : scope.organizationId,
    placement: placement === "cloud" ? "cloud" : "local",
  };
  let handler: (input: DesignCatalogRead) => Promise<unknown> = async (input) =>
    packet(owner, 2, 0, 2, input.intent);
  const calls: DesignCatalogRead[] = [];
  const dispatch = async (input: DesignCatalogRead) => {
    calls.push(input);
    const result = await handler(input);
    if (
      placement === "cloud" &&
      result &&
      typeof result === "object" &&
      "owner" in result
    )
      return {
        ...result,
        owner: {
          ...(result as DesignCatalogBatch).owner,
          workspaceId: scope.engineWorkspaceId,
        },
      };
    return result;
  };
  const requestConnected = vi.fn(
    async (message: { params: DesignCatalogRead }) => ({
      type: "WORKSPACE_RESPONSE",
      op: DESIGN_CATALOG_READ_OPERATION,
      result: await dispatch(message.params),
    }),
  );
  const peer = {
    status: "connected",
    requestConnected,
    request: vi.fn(async () => ({
      type: "WORKSPACE_RESPONSE",
      op: "chats.list",
      result: { chats: [], chatDeletions: [] },
    })),
    supportsEngineCapability: vi.fn(() => true),
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
        generation: 7,
        release: vi.fn(),
      }) satisfies CloudPeer,
  );
  const client = new WorkspaceRuntimeClient({
    open,
    identity: () => "account-a:generation-7",
    canAccess: () => true,
    workspaces: () => [],
  });
  clients.push(client);
  const localConnect = vi.spyOn(client, "connect").mockResolvedValue();
  const state = client as unknown as {
    handleIncoming: (message: unknown) => void;
  };
  const localSend = vi.fn((text: string) => {
    const message = JSON.parse(text);
    if (message.type !== "WORKSPACE_REQUEST") return;
    void dispatch(message.params).then(
      (result) =>
        state.handleIncoming({
          type: "WORKSPACE_RESPONSE",
          requestId: message.id,
          op: message.op,
          result,
        }),
      () =>
        state.handleIncoming({
          type: "WORKSPACE_ERROR",
          requestId: message.id,
          op: message.op,
          message: "Read failed",
        }),
    );
  });
  if (placement !== "cloud" && connected) {
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
  if (placement === "cloud" && admitted) await client.warmWorkspace(scope);
  if (!connected) peer.status = "disconnected";
  open.mockClear();
  peer.request.mockClear();
  localConnect.mockClear();
  return {
    client,
    owner,
    peer,
    open,
    localSend,
    localConnect,
    calls,
    setHandler: (next: typeof handler) => {
      handler = next;
    },
  };
}

describe("coherent Design catalog read adapter", () => {
  it.each(["personal", "organization-local"] as const)(
    "assembles through the real passive %s facade and keeps descriptors unprepared",
    async (placement) => {
      const f = await fixture(placement);
      const a = lifetime(f.owner);
      f.setHandler(async (input) =>
        input.cursor ? packet(f.owner, 2, 1, 1) : packet(f.owner, 2, 0, 1),
      );
      const adapter = new DesignCatalogReadAdapter(f.client);
      const result = await adapter.read(a.authority, 1);
      expect(result.status).toBe("coherent");
      if (result.status !== "coherent")
        throw new Error("Expected coherent catalog");
      expect(result.catalog.kind).toBe("coherent-design-catalog");
      expect(result.catalog.frames.map((frame) => frame.id)).toEqual([
        "frame_0",
        "frame_1",
      ]);
      expect(
        result.catalog.frames.every(
          (frame) =>
            frame.preparation === "unprepared" && !("sourceVersion" in frame),
        ),
      ).toBe(true);
      expect(f.calls.map((input) => input.cursor)).toEqual([
        undefined,
        "opaque-1",
      ]);
      expect(f.open).not.toHaveBeenCalled();
      expect(f.peer.request).not.toHaveBeenCalled();
      expect(f.localConnect).not.toHaveBeenCalled();
      expect(f.localSend).toHaveBeenCalledTimes(2);
      expect(adapter.isAuthoritative(a.authority, result.catalog)).toBe(true);
    },
  );

  it("does not publish a raw terminal partial packet without coverage from zero", async () => {
    const f = await fixture();
    const a = lifetime(f.owner);
    f.setHandler(async () => packet(f.owner, 2, 1, 1));
    const adapter = new DesignCatalogReadAdapter(f.client);
    expect((await adapter.read(a.authority, 1)).status).toBe("unavailable");
    expect(adapter.peek(a.authority)).toBeNull();
  });

  it.each(["revision", "binding", "pages", "total"] as const)(
    "refuses %s drift across otherwise valid fragments",
    async (field) => {
      const f = await fixture();
      const a = lifetime(f.owner);
      f.setHandler(async (input) => {
        if (!input.cursor) return packet(f.owner, 2, 0, 1);
        const next = packet(
          f.owner,
          field === "total" ? 3 : 2,
          1,
          field === "total" ? 2 : 1,
        );
        if (field === "revision" || field === "binding")
          next[field] = "c".repeat(64);
        if (field === "pages") next.pages[0]!.title = "Changed";
        return next;
      });
      const adapter = new DesignCatalogReadAdapter(f.client);
      expect((await adapter.read(a.authority, 1)).status).toBe("unavailable");
      expect(adapter.peek(a.authority)).toBeNull();
    },
  );

  it("retains the exact-key confirmed scene during revalidation but cannot authorize stale membership", async () => {
    const f = await fixture();
    const a = lifetime(f.owner);
    const adapter = new DesignCatalogReadAdapter(f.client);
    const first = await adapter.read(a.authority, 1);
    if (first.status !== "coherent")
      throw new Error("Expected initial catalog");
    const pending = held<unknown>();
    f.setHandler(() => pending.promise);
    const second = adapter.read(a.authority, 2);
    expect(adapter.peek(a.authority)).toBe(first.catalog);
    expect(adapter.isAuthoritative(a.authority, first.catalog)).toBe(false);
    pending.reject(new Error("Late transport rejection"));
    expect((await second).status).toBe("unavailable");
    expect(adapter.peek(a.authority)).toBe(first.catalog);
    expect(adapter.isAuthoritative(a.authority, first.catalog)).toBe(false);
  });

  it.each(["owner", "directory", "root", "account"])(
    "fences a held completion after %s A to B to A",
    async () => {
      const f = await fixture();
      const a = lifetime(f.owner);
      const pending = held<unknown>();
      f.setHandler(() => pending.promise);
      const adapter = new DesignCatalogReadAdapter(f.client);
      const reading = adapter.read(a.authority, 1);
      a.awayAndBack();
      pending.resolve(packet(f.owner));
      expect((await reading).status).toBe("unavailable");
      expect(adapter.peek(a.authority)).toBeNull();
    },
  );

  it.each(["resolve", "reject"])(
    "keeps a cancelled producer charged until its late %s",
    async (outcome) => {
      const f = await fixture();
      const a = lifetime(f.owner);
      const pending = held<unknown>();
      f.setHandler(() => pending.promise);
      const adapter = new DesignCatalogReadAdapter(f.client, { maxReads: 1 });
      const cancel = new AbortController();
      const reading = adapter.read(a.authority, 1, cancel.signal);
      cancel.abort();
      expect(adapter.getUsage().reads).toBe(1);
      expect(adapter.getUsage().retiredReads).toBe(1);
      const next = adapter.read(a.authority, 2);
      expect(f.calls).toHaveLength(1);
      if (outcome === "resolve") pending.resolve(packet(f.owner));
      else pending.reject(new Error("Retired rejection"));
      expect((await reading).status).toBe("unavailable");
      expect((await next).status).toBe("unavailable");
      await vi.waitFor(() => expect(adapter.getUsage().reads).toBe(0));
      expect(adapter.peek(a.authority)).toBeNull();
    },
  );

  it.each(["id", "source"] as const)(
    "rejects cross-fragment duplicate %s",
    async (field) => {
      const f = await fixture();
      const a = lifetime(f.owner);
      f.setHandler(async (input) => {
        const next = packet(f.owner, 2, input.cursor ? 1 : 0, 1);
        if (input.cursor)
          next.frames[0]![field] =
            field === "id" ? "frame_0" : "page-1/FRAME-0.html";
        return next;
      });
      const adapter = new DesignCatalogReadAdapter(f.client);
      expect((await adapter.read(a.authority, 1)).status).toBe("unavailable");
      expect(adapter.peek(a.authority)).toBeNull();
    },
  );

  it("rejects a nonprogressing opaque cursor instead of decoding or repeating it", async () => {
    const f = await fixture();
    const a = lifetime(f.owner);
    f.setHandler(async (input) =>
      f.calls.length > 2
        ? {
            kind: "design-catalog",
            version: 1,
            status: "unavailable",
            reason: "expired",
          }
        : {
            ...packet(f.owner, 3, input.cursor ? 1 : 0, 1),
            nextCursor: "same-opaque-token",
          },
    );
    const adapter = new DesignCatalogReadAdapter(f.client);
    expect((await adapter.read(a.authority, 1)).status).toBe("unavailable");
    expect(f.calls).toHaveLength(2);
    expect(adapter.peek(a.authority)).toBeNull();
  });

  it.each(["absent", "disconnected", "unsupported"])(
    "never wakes or falls back for an %s cloud peer",
    async (state) => {
      const f = await fixture(
        "cloud",
        state !== "absent",
        state !== "disconnected",
      );
      if (state === "unsupported")
        f.peer.supportsEngineCapability.mockReturnValue(false);
      const adapter = new DesignCatalogReadAdapter(f.client);
      expect((await adapter.read(lifetime(f.owner).authority, 1)).status).toBe(
        "unavailable",
      );
      expect(f.open).not.toHaveBeenCalled();
      expect(f.localConnect).not.toHaveBeenCalled();
      expect(f.localSend).not.toHaveBeenCalled();
      expect(f.peer.request).not.toHaveBeenCalled();
    },
  );
  it("shares one exact-intent flight without publishing its first fragment", async () => {
    const f = await fixture();
    const a = lifetime(f.owner);
    const last = held<unknown>();
    f.setHandler(async (input) =>
      input.cursor ? last.promise : packet(f.owner, 2, 0, 1),
    );
    const adapter = new DesignCatalogReadAdapter(f.client);
    const one = adapter.read(a.authority, 1);
    const two = adapter.read(a.authority, 1);
    expect(one).toBe(two);
    await vi.waitFor(() => expect(f.calls).toHaveLength(2));
    expect(adapter.peek(a.authority)).toBeNull();
    last.resolve(packet(f.owner, 2, 1, 1));
    expect((await one).status).toBe("coherent");
    expect(await two).toBe(await one);
    expect(adapter.peek(lifetime(f.owner).authority)).toBeNull();
  });

  it("reuses unchanged descriptor and page references only after complete validation", async () => {
    const f = await fixture();
    const a = lifetime(f.owner);
    const adapter = new DesignCatalogReadAdapter(f.client);
    const first = await adapter.read(a.authority, 1);
    if (first.status !== "coherent") throw new Error("Initial read failed");
    f.setHandler(async (input) => {
      const next = packet(f.owner, 2, 0, 2, input.intent);
      next.revision = "c".repeat(64);
      next.frames[1]!.title = "Changed";
      return next;
    });
    const second = await adapter.read(a.authority, 2);
    if (second.status !== "coherent") throw new Error("Refresh failed");
    expect(second.catalog.frames[0]).toBe(first.catalog.frames[0]);
    expect(second.catalog.frames[1]).not.toBe(first.catalog.frames[1]);
    expect(second.catalog.pages).toBe(first.catalog.pages);
    expect(Object.isFrozen(second.catalog.frames)).toBe(true);
    expect(Object.isFrozen(second.catalog.frames[1])).toBe(true);
  });

  it("refuses different content under an unchanged confirmed revision", async () => {
    const f = await fixture();
    const a = lifetime(f.owner);
    const adapter = new DesignCatalogReadAdapter(f.client);
    const old = await adapter.read(a.authority, 1);
    if (old.status !== "coherent") throw new Error("Initial read failed");
    f.setHandler(async (input) => {
      const next = packet(f.owner, 2, 0, 2, input.intent);
      next.frames[0]!.title = "Same revision, other contents";
      return next;
    });
    expect((await adapter.read(a.authority, 2)).status).toBe("unavailable");
    expect(adapter.peek(a.authority)).toBe(old.catalog);
    expect(adapter.isAuthoritative(a.authority, old.catalog)).toBe(false);
  });

  it("requires a new authority lifetime for a replaced physical root binding", async () => {
    const f = await fixture();
    const a = lifetime(f.owner);
    const adapter = new DesignCatalogReadAdapter(f.client);
    expect((await adapter.read(a.authority, 1)).status).toBe("coherent");
    f.setHandler(async (input) => ({
      ...packet(f.owner, 2, 0, 2, input.intent),
      binding: "c".repeat(64),
    }));
    expect((await adapter.read(a.authority, 2)).status).toBe("unavailable");
    expect(adapter.peek(a.authority)).toBeNull();
    expect((await adapter.read(lifetime(f.owner).authority, 3)).status).toBe(
      "coherent",
    );
  });

  it.each([
    "gap",
    "empty",
    "overflow",
    "duplicate-page",
    "prepared",
    "wrong-intent",
    "wrong-owner",
  ])("refuses malformed %s coverage without publishing", async (kind) => {
    const f = await fixture();
    const a = lifetime(f.owner);
    f.setHandler(async () => {
      const next = packet(f.owner);
      if (kind === "gap") {
        next.offset = 1;
        next.frames = next.frames.slice(1);
      }
      if (kind === "empty") next.frames = [];
      if (kind === "overflow") {
        next.total = 10_001;
        next.pages[0]!.count = 10_001;
      }
      if (kind === "duplicate-page") next.pages.push(next.pages[0]!);
      if (kind === "prepared")
        Object.assign(next.frames[0]!, { sourceVersion: "invented" });
      if (kind === "wrong-intent") next.intent = 2;
      if (kind === "wrong-owner")
        next.owner = { ...next.owner, directoryId: "design_other" };
      return next;
    });
    const adapter = new DesignCatalogReadAdapter(f.client);
    expect((await adapter.read(a.authority, 1)).status).toBe("unavailable");
    expect(adapter.peek(a.authority)).toBeNull();
  });

  it.each(["expired", "unsettled", "busy"] as const)(
    "discards a partial sequence when its producer reports %s",
    async (reason) => {
      const f = await fixture();
      const a = lifetime(f.owner);
      f.setHandler(async (input) =>
        input.cursor
          ? {
              kind: "design-catalog",
              version: 1,
              status: "unavailable",
              reason,
            }
          : packet(f.owner, 2, 0, 1),
      );
      const adapter = new DesignCatalogReadAdapter(f.client);
      expect(await adapter.read(a.authority, 1)).toEqual({
        status: "unavailable",
        reason,
      });
      expect(adapter.peek(a.authority)).toBeNull();
      expect(adapter.getUsage().descriptors).toBe(0);
    },
  );

  it.each([
    "maxSnapshotBytes",
    "maxTransferBytes",
    "maxOwnedDescriptors",
    "maxRoundTrips",
  ] as const)(
    "bounds %s and retains the last confirmed exact-key scene",
    async (limit) => {
      const f = await fixture();
      const a = lifetime(f.owner);
      const adapter = new DesignCatalogReadAdapter(f.client, { [limit]: 1 });
      f.setHandler(async (input) =>
        input.cursor ? packet(f.owner, 2, 1, 1) : packet(f.owner, 2, 0, 1),
      );
      expect((await adapter.read(a.authority, 1)).status).toBe("unavailable");
      expect(adapter.peek(a.authority)).toBeNull();
      expect(adapter.getUsage().reads).toBe(0);
    },
  );

  it("keeps retired stages, response reservations and owner slots charged until settlement", async () => {
    const f = await fixture();
    const a = lifetime(f.owner);
    const last = held<unknown>();
    f.setHandler(async (input) =>
      input.cursor ? last.promise : packet(f.owner, 2, 0, 1),
    );
    const adapter = new DesignCatalogReadAdapter(f.client, {
      maxOwners: 1,
      maxReads: 1,
    });
    const reading = adapter.read(a.authority, 1);
    await vi.waitFor(() => expect(f.calls).toHaveLength(2));
    const charged = adapter.getUsage();
    expect(charged.descriptors).toBe(1);
    expect(charged.bytes).toBeGreaterThan(2 * 1024 * 1024);
    a.retire();
    expect((await reading).status).toBe("unavailable");
    expect(adapter.getUsage()).toMatchObject({
      owners: 1,
      reads: 1,
      retiredReads: 1,
      descriptors: 1,
      bytes: charged.bytes,
    });
    expect((await adapter.read(lifetime(f.owner).authority, 2)).status).toBe(
      "unavailable",
    );
    expect(f.calls).toHaveLength(2);
    last.resolve(packet(f.owner, 2, 1, 1));
    await vi.waitFor(() => expect(adapter.getUsage().reads).toBe(0));
    expect(adapter.getUsage()).toEqual({
      owners: 0,
      reads: 0,
      retiredReads: 0,
      descriptors: 0,
      bytes: 0,
    });
  });

  it.each(["resolve", "reject"] as const)(
    "charges normalized source strings through retired callback %s settlement",
    async (settlement) => {
      const f = await fixture();
      const a = lifetime(f.owner);
      const adapter = new DesignCatalogReadAdapter(f.client);
      const last = held<unknown>();
      const first = longSourcePacket(f.owner, 120, 0, 60, 1);
      const final = longSourcePacket(f.owner, 120, 60, 60, 1);
      f.setHandler(async (input) => (input.cursor ? last.promise : first));
      const reading = adapter.read(a.authority, 1);
      const ownerBytes = adapter.getUsage().bytes - 2 * 1024 * 1024;
      try {
        await vi.waitFor(() => expect(f.calls).toHaveLength(2));
        const [task] = retainedTasks(adapter);
        expect(task).toBeDefined();
        expect(task!.frames.map((frame) => frame.source)).toEqual(
          first.frames.map((frame) => frame.source),
        );
        expect([...task!.sources]).toEqual(
          first.frames.map((frame) => frame.source.toLowerCase()),
        );
        expect(
          [...task!.sources].every(
            (key, index) => key !== task!.frames[index]!.source,
          ),
        ).toBe(true);
        const charged = adapter.getUsage();
        expect(charged.bytes).toBe(
          ownerBytes + retainedPayloadBytes(task!) + 2 * 1024 * 1024,
        );
        a.retire();
        expect(await reading).toEqual({
          status: "unavailable",
          reason: "retired",
        });
        expect(adapter.getUsage()).toEqual({ ...charged, retiredReads: 1 });
        expect(task!.sources.size).toBe(60);
        if (settlement === "resolve") last.resolve(final);
        else last.reject(new Error("Retire normalized source payload"));
        await vi.waitFor(() => expect(adapter.getUsage().reads).toBe(0));
        expect(task!.sources.size).toBe(0);
        expect(adapter.getUsage()).toEqual({
          owners: 0,
          reads: 0,
          retiredReads: 0,
          descriptors: 0,
          bytes: 0,
        });
      } finally {
        a.retire();
        last.resolve(final);
        await reading;
        await vi.waitFor(() => expect(adapter.getUsage().reads).toBe(0));
      }
    },
  );

  it.each(["maxSnapshotBytes", "maxBytes"] as const)(
    "prices normalized keys before %s admission",
    async (limit) => {
      const f = await fixture();
      const a = lifetime(f.owner);
      const reply = longSourcePacket(f.owner, 60, 0, 60, 1);
      const adapter = new DesignCatalogReadAdapter(f.client, {
        [limit]: limit === "maxBytes" ? 2 * 1024 * 1024 + 700_000 : 700_000,
      });
      f.setHandler(async () => reply);
      expect(await adapter.read(a.authority, 1)).toEqual({
        status: "unavailable",
        reason: "too-large",
      });
      expect(f.calls).toHaveLength(1);
      expect(adapter.peek(a.authority)).toBeNull();
      expect(adapter.getUsage().reads).toBe(0);
    },
  );

  it("releases temporary normalized keys rather than transferring them to confirmed ownership", async () => {
    const f = await fixture();
    const a = lifetime(f.owner);
    const adapter = new DesignCatalogReadAdapter(f.client);
    const last = held<unknown>();
    const first = longSourcePacket(f.owner, 120, 0, 60, 1);
    const final = longSourcePacket(f.owner, 120, 60, 60, 1);
    f.setHandler(async (input) => (input.cursor ? last.promise : first));
    const reading = adapter.read(a.authority, 1);
    const ownerBytes = adapter.getUsage().bytes - 2 * 1024 * 1024;
    try {
      await vi.waitFor(() => expect(f.calls).toHaveLength(2));
      const [task] = retainedTasks(adapter);
      expect(task!.sources.size).toBe(60);
      last.resolve(final);
      const result = await reading;
      if (result.status !== "coherent")
        throw new Error(
          "Long authored paths must remain accepted within budget",
        );
      expect(result.catalog.frames.map((frame) => frame.source)).toEqual(
        [...first.frames, ...final.frames].map((frame) => frame.source),
      );
      expect(task!.sources.size).toBe(0);
      expect(adapter.getUsage().bytes).toBe(
        ownerBytes + JSON.stringify(result.catalog).length * 2,
      );
    } finally {
      last.resolve(final);
      await reading;
      a.retire();
    }
  });

  it("keeps four-owner long-source staging within independently priced default byte budgets", async () => {
    const f = await fixture();
    const adapter = new DesignCatalogReadAdapter(f.client);
    const authorities = Array.from({ length: 4 }, (_, index) =>
      lifetime({ ...f.owner, directoryId: `design_keys_${index}` }),
    );
    const offsets = new Map<string, number>();
    const observations: {
      charged: number;
      lowerBound: number;
      stages: number[];
    }[] = [];
    f.setHandler(async (input) => {
      const tasks = retainedTasks(adapter);
      const stages = tasks.map(retainedPayloadBytes);
      observations.push({
        charged: adapter.getUsage().bytes,
        lowerBound:
          stages.reduce((sum, bytes) => sum + bytes, 0) +
          tasks.filter((task) => task.reserved).length * 2 * 1024 * 1024,
        stages,
      });
      const offset = offsets.get(input.directoryId) ?? 0;
      const count = Math.min(60, 1000 - offset);
      const owner = { ...f.owner, directoryId: input.directoryId };
      offsets.set(input.directoryId, offset + count);
      return longSourcePacket(owner, 1000, offset, count, input.intent);
    });
    try {
      await Promise.all(
        authorities.map((a, index) => adapter.read(a.authority, index + 1)),
      );
      expect(observations.length).toBeGreaterThan(4);
      for (const observation of observations) {
        expect(observation.charged).toBeGreaterThanOrEqual(
          observation.lowerBound,
        );
        expect(observation.lowerBound).toBeLessThanOrEqual(32 * 1024 * 1024);
        for (const stage of observation.stages)
          expect(stage).toBeLessThanOrEqual(8 * 1024 * 1024);
      }
    } finally {
      authorities.forEach((a) => a.retire());
    }
    expect(adapter.getUsage()).toEqual({
      owners: 0,
      reads: 0,
      retiredReads: 0,
      descriptors: 0,
      bytes: 0,
    });
  });

  it("expires at an anchored deadline without freeing an executing response reservation", async () => {
    const f = await fixture();
    const a = lifetime(f.owner);
    const pending = held<unknown>();
    f.setHandler(() => pending.promise);
    vi.useFakeTimers();
    const adapter = new DesignCatalogReadAdapter(f.client, {
      maxDurationMs: 10,
    });
    const reading = adapter.read(a.authority, 1);
    await vi.advanceTimersByTimeAsync(10);
    expect(await reading).toEqual({ status: "unavailable", reason: "expired" });
    expect(adapter.getUsage()).toMatchObject({ reads: 1, retiredReads: 1 });
    pending.resolve(packet(f.owner));
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.getUsage().reads).toBe(0);
    expect(adapter.peek(a.authority)).toBeNull();
  });

  it.each(["personal", "organization-local"] as const)(
    "fences caller account ABA on the real %s socket",
    async (placement) => {
      const f = await fixture(placement);
      const a = lifetime(f.owner);
      const pending = held<unknown>();
      f.setHandler(() => pending.promise);
      const adapter = new DesignCatalogReadAdapter(f.client);
      const reading = adapter.read(a.authority, 1);
      f.client.signalOwnerSignedOut();
      a.awayAndBack();
      pending.resolve(packet(f.owner));
      expect((await reading).status).toBe("unavailable");
      expect(adapter.peek(a.authority)).toBeNull();
      expect(f.open).not.toHaveBeenCalled();
      expect(f.localConnect).not.toHaveBeenCalled();
    },
  );

  it("uses the facade's actual cloud peer-retirement fence", async () => {
    const f = await fixture("cloud");
    const a = lifetime(f.owner);
    const pending = held<unknown>();
    f.setHandler(() => pending.promise);
    const adapter = new DesignCatalogReadAdapter(f.client);
    const reading = adapter.read(a.authority, 1);
    f.client.clearCloudConnections();
    pending.resolve(packet(f.owner));
    expect((await reading).status).toBe("unavailable");
    expect(adapter.peek(a.authority)).toBeNull();
    expect(f.open).not.toHaveBeenCalled();
  });

  it.each(["personal", "organization-local"] as const)(
    "does not connect a disconnected %s socket",
    async (placement) => {
      const f = await fixture(placement, false, false);
      const adapter = new DesignCatalogReadAdapter(f.client);
      expect((await adapter.read(lifetime(f.owner).authority, 1)).status).toBe(
        "unavailable",
      );
      expect(f.localSend).not.toHaveBeenCalled();
      expect(f.localConnect).not.toHaveBeenCalled();
      expect(f.open).not.toHaveBeenCalled();
    },
  );

  it("does not authorize a completed result after its caller cancels publication", async () => {
    const f = await fixture();
    const a = lifetime(f.owner);
    const signal = new AbortController();
    const adapter = new DesignCatalogReadAdapter(f.client);
    const result = await adapter.read(a.authority, 1, signal.signal);
    if (result.status !== "coherent") throw new Error("Initial read failed");
    signal.abort();
    expect(adapter.peek(a.authority)).toBe(result.catalog);
    expect(adapter.isAuthoritative(a.authority, result.catalog)).toBe(false);
  });

  it("never revives an older publication when unchanged data is confirmed again", async () => {
    const f = await fixture();
    const a = lifetime(f.owner);
    const cancel = new AbortController();
    const adapter = new DesignCatalogReadAdapter(f.client);
    const first = await adapter.read(a.authority, 1, cancel.signal);
    if (first.status !== "coherent") throw new Error("First read failed");
    cancel.abort();
    const second = await adapter.read(a.authority, 2);
    if (second.status !== "coherent") throw new Error("Second read failed");
    expect(second.catalog.frames).toBe(first.catalog.frames);
    expect(second.catalog.pages).toBe(first.catalog.pages);
    expect(adapter.isAuthoritative(a.authority, first.catalog)).toBe(false);
    expect(adapter.isAuthoritative(a.authority, second.catalog)).toBe(true);
  });

  it("does not transfer completed publication ownership to a different cancellation signal", async () => {
    const f = await fixture();
    const a = lifetime(f.owner);
    const firstSignal = new AbortController();
    const secondSignal = new AbortController();
    const adapter = new DesignCatalogReadAdapter(f.client);
    const first = await adapter.read(a.authority, 1, firstSignal.signal);
    if (first.status !== "coherent") throw new Error("First read failed");
    expect(await adapter.read(a.authority, 1, secondSignal.signal)).toEqual({
      status: "unavailable",
      reason: "superseded",
    });
    secondSignal.abort();
    expect(adapter.isAuthoritative(a.authority, first.catalog)).toBe(true);
    expect(f.calls).toHaveLength(1);
  });

  it("preserves confirmed data when aggregate descriptor budget refuses revalidation", async () => {
    const f = await fixture();
    const a = lifetime(f.owner);
    const adapter = new DesignCatalogReadAdapter(f.client, {
      maxOwnedDescriptors: 3,
    });
    const old = await adapter.read(a.authority, 1);
    if (old.status !== "coherent") throw new Error("Initial read failed");
    f.setHandler(async (input) => ({
      ...packet(f.owner, 2, 0, 2, input.intent),
      revision: "c".repeat(64),
    }));
    expect((await adapter.read(a.authority, 2)).status).toBe("unavailable");
    expect(adapter.peek(a.authority)).toBe(old.catalog);
    expect(adapter.isAuthoritative(a.authority, old.catalog)).toBe(false);
    expect(adapter.getUsage().descriptors).toBe(2);
  });

  it("does not dispatch when a response reservation cannot fit", async () => {
    const f = await fixture();
    const adapter = new DesignCatalogReadAdapter(f.client, {
      maxBytes: 2 * 1024 * 1024,
    });
    expect((await adapter.read(lifetime(f.owner).authority, 1)).status).toBe(
      "unavailable",
    );
    expect(f.calls).toHaveLength(0);
    expect(adapter.getUsage().bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  it("fences real directory A to B to A reads without reviving the retired A flight", async () => {
    const f = await fixture();
    const old = lifetime(f.owner);
    const heldA = held<unknown>();
    f.setHandler(async (input) =>
      input.intent === 1
        ? heldA.promise
        : packet(
            { ...f.owner, directoryId: input.directoryId },
            2,
            0,
            2,
            input.intent,
          ),
    );
    const adapter = new DesignCatalogReadAdapter(f.client);
    const first = adapter.read(old.authority, 1);
    old.retire();
    const b = lifetime({ ...f.owner, directoryId: "design_other" });
    expect((await adapter.read(b.authority, 2)).status).toBe("coherent");
    b.retire();
    const nextA = lifetime(f.owner);
    const latest = await adapter.read(nextA.authority, 3);
    if (latest.status !== "coherent") throw new Error("New A failed");
    heldA.resolve(packet(f.owner));
    expect((await first).status).toBe("unavailable");
    await vi.waitFor(() => expect(adapter.getUsage().reads).toBe(0));
    expect(adapter.peek(old.authority)).toBeNull();
    expect(adapter.peek(nextA.authority)).toBe(latest.catalog);
    expect(f.calls.map((input) => input.directoryId)).toEqual([
      "design_test",
      "design_other",
      "design_test",
    ]);
  });

  it.each([0, -1, NaN, Infinity, 4.5, 5])(
    "rejects an invalid read concurrency bound %s",
    async (maxReads) => {
      const f = await fixture();
      expect(
        () => new DesignCatalogReadAdapter(f.client, { maxReads }),
      ).toThrow(RangeError);
    },
  );

  it("assembles ten thousand synthetic metadata descriptors within explicit pool bounds", async () => {
    const f = await fixture();
    const a = lifetime(f.owner);
    const adapter = new DesignCatalogReadAdapter(f.client);
    let offset = 0,
      peakBytes = 0,
      peakDescriptors = 0;
    f.setHandler(async (input) => {
      const usage = adapter.getUsage();
      peakBytes = Math.max(peakBytes, usage.bytes);
      peakDescriptors = Math.max(peakDescriptors, usage.descriptors);
      const count = Math.min(256, 10_000 - offset);
      const next = packet(f.owner, 10_000, offset, count, input.intent);
      offset += count;
      return next;
    });
    const result = await adapter.read(a.authority, 1);
    expect(result.status).toBe("coherent");
    if (result.status !== "coherent")
      throw new Error("Synthetic metadata assembly failed");
    expect(result.catalog.frames).toHaveLength(10_000);
    expect(f.calls).toHaveLength(40);
    expect(peakBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(peakDescriptors).toBeLessThanOrEqual(40_000);
    expect(adapter.getUsage()).toMatchObject({ reads: 0, descriptors: 10_000 });
    adapter.retire(a.authority);
    expect(adapter.getUsage()).toEqual({
      owners: 0,
      reads: 0,
      retiredReads: 0,
      descriptors: 0,
      bytes: 0,
    });
  });
});

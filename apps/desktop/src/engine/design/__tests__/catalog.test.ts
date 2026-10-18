import { describe, expect, it, vi } from "vitest";
import {
  DesignCatalogReader,
  projectDesignCatalog,
  type DesignCatalogSnapshot,
} from "../catalog";
import type { CanvasDocument } from "../document-model";
import {
  DESIGN_CATALOG_BATCH_BYTES,
  type DesignCatalogRead,
} from "@zeros/protocol/design-catalog";

const input: DesignCatalogRead = {
  version: 1,
  workspaceId: "local",
  directoryId: "design_test",
  intent: 1,
  limit: 2,
};
const admission = {
  connectionId: "connection-a",
  authority: "local-account",
  authorized: () => true,
};
function metadata(count: number): DesignCatalogSnapshot {
  const ids = Array.from({ length: count }, (_, i) => `f${i}`);
  const canvas: Pick<CanvasDocument, "frames" | "frame_info" | "pages"> = {
    frames: Object.fromEntries(
      ids.map((id, i) => [
        `page-1/${id}.html`,
        { x: i, y: 0, w: 100, h: 100, z: 0 },
      ]),
    ),
    frame_info: Object.fromEntries(
      ids.map((id) => [
        `page-1/${id}.html`,
        { id, title: id, kind: "frame" as const },
      ]),
    ),
    pages: [{ id: "p", title: "Page", folder: "page-1", frames: ids }],
  };
  return {
    owner: {
      workspaceId: "local",
      directoryId: "design_test",
      placement: "local",
      organizationId: null,
    },
    revision: "a".repeat(64),
    binding: "root-a",
    ...projectDesignCatalog(canvas),
  };
}
const source = (snapshot = metadata(3)) => ({
  open: vi.fn(async () => snapshot),
  validate: vi.fn(async () => true),
});
const held = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("bounded revisioned metadata catalog", () => {
  it.each(["disconnect", "supersede", "expire", "evict"])(
    "retains executing snapshot charges through %s and releases the last lease exactly once",
    async (transition) => {
      const data = metadata(3);
      const size = Buffer.byteLength(JSON.stringify(data)) * 2;
      let time = 0;
      const reader = new DesignCatalogReader({
        maxBytes: size * 2,
        maxSessions: 2,
        maxReads: 4,
        now: () => time,
        ttlMs: 10,
      });
      const state = reader as unknown as {
        retainedBytes: number;
        running: number;
      };
      const first = await reader.read(input, admission, source(data));
      if (first.status !== "ready" || !first.nextCursor)
        throw new Error("expected cursor");
      const gates = [held<boolean>(), held<boolean>()];
      const entered = [held<void>(), held<void>()];
      const reads = gates.map((gate, index) =>
        reader.read({ ...input, cursor: first.nextCursor! }, admission, {
          open: async () => data,
          validate: () => {
            entered[index].resolve();
            return gate.promise;
          },
        }),
      );
      await Promise.all(entered.map((gate) => gate.promise));
      if (transition === "disconnect") reader.retire(admission.connectionId);
      if (transition === "supersede")
        expect(
          await reader.read({ ...input, intent: 2 }, admission, source(data)),
        ).toMatchObject({ status: "ready" });
      if (transition === "expire") time = 10;
      const latest = await reader.read(
        input,
        { ...admission, connectionId: "b" },
        source(data),
      );
      expect(latest).toMatchObject({ status: "ready" });
      const next = await reader.read(
        input,
        { ...admission, connectionId: "c" },
        source(data),
      );
      expect(next).toMatchObject({ status: "ready" });
      expect(state.retainedBytes).toBe(size * 2);
      expect(state.running).toBe(2);
      gates[0].resolve(true);
      expect(await reads[0]).toMatchObject({ status: "unavailable" });
      expect(state.retainedBytes).toBe(size * 2);
      expect(state.running).toBe(1);
      gates[1].resolve(true);
      expect(await reads[1]).toMatchObject({ status: "unavailable" });
      expect(state.retainedBytes).toBe(size);
      expect(state.running).toBe(0);
      reader.retire("b");
      reader.retire("c");
      reader.retire("c");
      reader.retire(admission.connectionId);
      expect(state.retainedBytes).toBe(0);
    },
  );

  it("refuses a snapshot when every byte is leased by retired continuations, without freeing producer slots", async () => {
    const data = metadata(3),
      size = Buffer.byteLength(JSON.stringify(data)) * 2;
    const reader = new DesignCatalogReader({ maxBytes: size, maxReads: 2 });
    const first = await reader.read(input, admission, source(data));
    if (first.status !== "ready" || !first.nextCursor)
      throw new Error("expected cursor");
    const gate = held<boolean>(),
      entered = held<void>();
    const reading = reader.read(
      { ...input, cursor: first.nextCursor },
      admission,
      {
        open: async () => data,
        validate: () => {
          entered.resolve();
          return gate.promise;
        },
      },
    );
    await entered.promise;
    reader.retire(admission.connectionId);
    expect(
      await reader.read(
        input,
        { ...admission, connectionId: "b" },
        source(data),
      ),
    ).toMatchObject({ reason: "busy" });
    const state = reader as unknown as {
      retainedBytes: number;
      running: number;
    };
    expect(state.running).toBe(1);
    expect(state.retainedBytes).toBe(size);
    gate.resolve(true);
    expect(await reading).toMatchObject({ reason: "superseded" });
    expect(state.retainedBytes).toBe(0);
    expect(
      await reader.read(
        input,
        { ...admission, connectionId: "b" },
        source(data),
      ),
    ).toMatchObject({ status: "ready" });
  });

  it("counts three retired executing snapshots inside the default 32 MiB aggregate ceiling", async () => {
    const reader = new DesignCatalogReader();
    const data = metadata(256);
    data.frames = data.frames.map((frame, index) => ({
      ...frame,
      source: `page-1/f${index}${"x".repeat(3900)}.html`,
    }));
    const size = Buffer.byteLength(JSON.stringify(data)) * 2;
    const retired: { bytes: number }[] = [];
    const state = reader as unknown as {
      sessions: Map<string, { bytes: number }>;
      retainedBytes: number;
      running: number;
    };
    const gates = [held<boolean>(), held<boolean>(), held<boolean>()];
    const reads: Promise<unknown>[] = [];
    for (let i = 0; i < gates.length; i++) {
      const actor = { ...admission, connectionId: `old-${i}` };
      const first = await reader.read(input, actor, source(data));
      if (first.status !== "ready" || !first.nextCursor)
        throw new Error("expected cursor");
      const entered = held<void>();
      reads.push(
        reader.read({ ...input, cursor: first.nextCursor }, actor, {
          open: async () => data,
          validate: () => {
            entered.resolve();
            return gates[i].promise;
          },
        }),
      );
      await entered.promise;
      retired.push(
        state.sessions.get(
          JSON.stringify([actor.connectionId, input.workspaceId]),
        )!,
      );
      reader.retire(actor.connectionId);
    }
    for (let i = 0; i < 16; i++)
      expect(
        await reader.read(
          input,
          { ...admission, connectionId: `new-${i}` },
          source(data),
        ),
      ).toMatchObject({ status: "ready" });
    const activeBytes = [...state.sessions.values()].reduce(
      (sum, session) => sum + session.bytes,
      0,
    );
    const retiredBytes = retired.reduce(
      (sum, session) => sum + session.bytes,
      0,
    );
    expect(activeBytes + retiredBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(state.retainedBytes).toBe(activeBytes + retiredBytes);
    expect(retiredBytes).toBe(size * 3);
    expect(state.running).toBe(3);
    for (const gate of gates) gate.resolve(true);
    for (const result of await Promise.all(reads))
      expect(result).toMatchObject({ reason: "superseded" });
    expect(state.retainedBytes).toBe(activeBytes);
    expect(state.running).toBe(0);
    for (let i = 0; i < 16; i++) reader.retire(`new-${i}`);
    expect(state.retainedBytes).toBe(0);
  });

  it("allows a new authority to start its own intent while retiring the predecessor", async () => {
    const reader = new DesignCatalogReader();
    const pending = held<DesignCatalogSnapshot>();
    const old = reader.read({ ...input, intent: 8 }, admission, {
      open: () => pending.promise,
      validate: async () => true,
    });
    const next = metadata(0);
    next.owner.directoryId = "design_other";
    expect(
      await reader.read(
        { ...input, intent: 8, directoryId: "design_other" },
        { ...admission, authority: "next-account" },
        source(next),
      ),
    ).toMatchObject({ status: "ready" });
    pending.resolve(metadata(3));
    expect(await old).toMatchObject({ reason: "superseded" });
  });

  it("retires older intent even when the new read must wait for producer capacity", async () => {
    const reader = new DesignCatalogReader({ maxReads: 1 });
    const pending = held<DesignCatalogSnapshot>();
    const old = reader.read(input, admission, {
      open: () => pending.promise,
      validate: async () => true,
    });
    expect(
      await reader.read({ ...input, intent: 2 }, admission, source()),
    ).toMatchObject({ reason: "busy" });
    pending.resolve(metadata(3));
    expect(await old).toMatchObject({ reason: "superseded" });
    expect(
      await reader.read({ ...input, intent: 2 }, admission, source()),
    ).toMatchObject({ status: "ready" });
  });

  it("pages a bounded 10k metadata helper fixture without claiming production admission", async () => {
    const reader = new DesignCatalogReader();
    const read = source(metadata(10000));
    const found: string[] = [];
    let cursor: string | undefined;
    do {
      const batch = await reader.read(
        { ...input, limit: 256, ...(cursor ? { cursor } : {}) },
        admission,
        read,
      );
      expect(batch.status).toBe("ready");
      if (batch.status !== "ready") throw new Error("expected batch");
      expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(
        DESIGN_CATALOG_BATCH_BYTES,
      );
      expect(batch.offset).toBe(found.length);
      expect(batch.coverage).toBe("partial");
      found.push(...batch.frames.map((frame) => frame.id));
      cursor = batch.nextCursor ?? undefined;
    } while (cursor);
    expect(found).toEqual(Array.from({ length: 10000 }, (_, i) => `f${i}`));
    expect(read.open).toHaveBeenCalledOnce();
  });
  it("stops at the byte bound before the entry bound and completes small/empty catalogs", async () => {
    const reader = new DesignCatalogReader();
    const data = metadata(256);
    data.frames = data.frames.map((frame, i) => ({
      ...frame,
      source: `page-1/${i}${"x".repeat(2000)}.html`,
      title: "界".repeat(120),
    }));
    const batch = await reader.read(
      { ...input, limit: 256 },
      admission,
      source(data),
    );
    expect(batch).toMatchObject({ status: "ready", coverage: "partial" });
    if (batch.status !== "ready") throw new Error("expected batch");
    expect(batch.frames.length).toBeLessThan(256);
    expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(
      DESIGN_CATALOG_BATCH_BYTES,
    );
    for (const count of [0, 1, 2])
      expect(
        await reader.read(input, admission, source(metadata(count))),
      ).toMatchObject({
        status: "ready",
        coverage: "complete",
        nextCursor: null,
      });
  });
  it("rejects forged cursors, changed revisions, root bindings, owners and connection lifetimes", async () => {
    const reader = new DesignCatalogReader();
    const read = source();
    const first = await reader.read(input, admission, read);
    if (first.status !== "ready" || !first.nextCursor)
      throw new Error("expected cursor");
    const next = { ...input, cursor: first.nextCursor };
    expect(
      await reader.read(
        { ...next, cursor: first.nextCursor.replace(/.$/, "z") },
        admission,
        read,
      ),
    ).toMatchObject({ reason: "expired" });
    expect(
      await reader.read(next, { ...admission, connectionId: "other" }, read),
    ).toMatchObject({ reason: "expired" });
    expect(
      await reader.read(next, { ...admission, authority: "other-owner" }, read),
    ).toMatchObject({ reason: "expired" });
    read.validate.mockResolvedValue(false);
    expect(await reader.read(next, admission, read)).toMatchObject({
      reason: "stale",
    });
    expect(await reader.read(next, admission, read)).toMatchObject({
      reason: "expired",
    });
  });
  it("fences held A to B to A work with intent rather than equal metadata hashes", async () => {
    const reader = new DesignCatalogReader();
    const pending = held<DesignCatalogSnapshot>();
    const a = reader.read(input, admission, {
      open: () => pending.promise,
      validate: async () => true,
    });
    expect(
      await reader.read(
        { ...input, directoryId: "design_b", intent: 2 },
        admission,
        source({
          ...metadata(0),
          owner: { ...metadata(0).owner, directoryId: "design_b" },
        }),
      ),
    ).toMatchObject({ status: "ready" });
    expect(
      await reader.read({ ...input, intent: 3 }, admission, source()),
    ).toMatchObject({ status: "ready" });
    pending.resolve(metadata(3));
    expect(await a).toMatchObject({ reason: "superseded" });
    expect(await reader.read(input, admission, source())).toMatchObject({
      reason: "superseded",
    });
  });
  it("expires from admission, retires held reads, and bounds concurrent reads without queuing", async () => {
    let time = 0;
    const reader = new DesignCatalogReader({
      now: () => time,
      ttlMs: 10,
      maxReads: 1,
    });
    const pending = held<DesignCatalogSnapshot>();
    const a = reader.read(input, admission, {
      open: () => pending.promise,
      validate: async () => true,
    });
    expect(
      await reader.read(
        input,
        { ...admission, connectionId: "other" },
        source(),
      ),
    ).toMatchObject({ reason: "busy" });
    time = 10;
    pending.resolve(metadata(3));
    expect(await a).toMatchObject({ reason: "expired" });
    const verify = held<boolean>();
    const entered = held<void>();
    const b = reader.read(input, admission, {
      open: async () => metadata(3),
      validate: () => {
        entered.resolve();
        return verify.promise;
      },
    });
    await entered.promise;
    reader.retire(admission.connectionId);
    verify.resolve(true);
    expect(await b).toMatchObject({ reason: "superseded" });
  });
  it("evicts bounded sessions and bytes and refuses oversized admission", async () => {
    const reader = new DesignCatalogReader({ maxSessions: 1, maxBytes: 4000 });
    const a = await reader.read(input, admission, source());
    if (a.status !== "ready" || !a.nextCursor)
      throw new Error("expected cursor");
    expect(
      await reader.read(input, { ...admission, connectionId: "b" }, source()),
    ).toMatchObject({ status: "ready" });
    expect(
      await reader.read(
        { ...input, cursor: a.nextCursor },
        admission,
        source(),
      ),
    ).toMatchObject({ reason: "expired" });
    expect(
      await reader.read(input, admission, source(metadata(100))),
    ).toMatchObject({ reason: "too-large" });
    const byteBound = new DesignCatalogReader({
      maxSessions: 4,
      maxBytes: 2500,
    });
    const first = await byteBound.read(input, admission, source());
    if (first.status !== "ready" || !first.nextCursor)
      throw new Error("expected cursor");
    expect(
      await byteBound.read(
        input,
        { ...admission, connectionId: "b" },
        source(),
      ),
    ).toMatchObject({ status: "ready" });
    expect(
      await byteBound.read(
        { ...input, cursor: first.nextCursor },
        admission,
        source(),
      ),
    ).toMatchObject({ reason: "expired" });
  });
  it("does not renew a cursor deadline or let a late failed read retire its successor", async () => {
    let time = 0;
    const reader = new DesignCatalogReader({ now: () => time, ttlMs: 10 });
    const first = await reader.read(
      { ...input, limit: 1 },
      admission,
      source(),
    );
    if (first.status !== "ready" || !first.nextCursor)
      throw new Error("expected cursor");
    time = 9;
    const second = await reader.read(
      { ...input, limit: 1, cursor: first.nextCursor },
      admission,
      source(),
    );
    if (second.status !== "ready" || !second.nextCursor)
      throw new Error("expected cursor");
    time = 10;
    expect(
      await reader.read(
        { ...input, cursor: second.nextCursor },
        admission,
        source(),
      ),
    ).toMatchObject({ reason: "expired" });
    const pending = held<void>();
    const failed = reader.read({ ...input, intent: 2 }, admission, {
      open: async () => {
        await pending.promise;
        throw new Error("old failure");
      },
      validate: async () => true,
    });
    const observedFailure = expect(failed).rejects.toThrow("old failure");
    const latest = await reader.read(
      { ...input, intent: 3 },
      admission,
      source(),
    );
    if (latest.status !== "ready" || !latest.nextCursor)
      throw new Error("expected cursor");
    pending.resolve();
    await observedFailure;
    expect(
      await reader.read(
        { ...input, intent: 3, cursor: latest.nextCursor },
        admission,
        source(),
      ),
    ).toMatchObject({ status: "ready", offset: 2 });
  });
});

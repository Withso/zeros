import { describe, expect, it, vi } from "vitest";
import { NativeCloudChatCacheClient } from "../cloud-chat-cache-client";
import type { CloudCacheRequest } from "../../../../shared/cloud-chat-cache";

const owner = JSON.stringify(["https://api.example.test", "viewer-a"]), other = JSON.stringify(["https://api.example.test", "viewer-b"]);
const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", chatId: "chat" };
const lease = "33333333-3333-4333-8333-333333333333";
const snapshot = { range: { revision: 1, messageCount: 0, fromIndex: 0, toIndex: 0, rows: [] }, pending: null };
const ok = (result: unknown) => ({ ok: true, result });
function held<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const invoke = vi.fn(async (input: CloudCacheRequest): Promise<unknown> => input.op === "bind" ? ok({ lease }) : ok(snapshot));
  const lost = vi.fn();
  const client = new NativeCloudChatCacheClient({ invoke, accessLost: lost });
  return { client, invoke, lost };
}

describe("renderer native cloud cache owner boundary", () => {
  it("keeps Local idle and binds main's lease once for simultaneous cached reads", async () => {
    const f = fixture();
    expect(await f.client.read(target, 200)).toBeNull();
    expect(f.invoke).not.toHaveBeenCalled();
    f.client.bindOwner(owner, "session-a");
    expect(f.invoke).not.toHaveBeenCalled();
    const first = f.client.read(target, 200), second = f.client.read(target, 200);
    expect(await first).toEqual(snapshot); expect(await second).toEqual(snapshot);
    expect(f.invoke.mock.calls.map(([call]) => call.op)).toEqual(["bind", "read"]);
    expect(f.invoke.mock.calls[0][0]).toMatchObject({ op: "bind", owner });
    expect(f.invoke.mock.calls[1][0]).toEqual({ op: "read", lease, target, limit: 200 });
  });

  it("refuses a delayed read after A to B to A and after a same-account replacement sign-in", async () => {
    for (const replace of [false, true]) {
      const f = fixture(), pending = held<unknown>(), started = held<void>();
      f.client.bindOwner(owner, "session-a");
      f.invoke.mockImplementation(async input => {
        if (input.op === "bind") return ok({ lease });
        if (input.op === "read") { started.resolve(); return pending.promise; }
        return ok(null);
      });
      const read = f.client.read(target, 200);
      await started.promise;
      if (!replace) f.client.bindOwner(other, "session-b");
      f.client.bindOwner(owner, replace ? "session-new" : "session-a");
      pending.resolve(ok(snapshot));
      expect(await read).toBeNull();
    }
  });

  it("does not paint an in-flight cached read after its chat is forgotten", async () => {
    const f = fixture(), pending = held<unknown>(), started = held<void>();
    f.client.bindOwner(owner, "session-a");
    f.invoke.mockImplementation(async input => {
      if (input.op === "bind") return ok({ lease });
      if (input.op === "read") { started.resolve(); return pending.promise; }
      return ok(null);
    });
    const read = f.client.read(target, 200);
    await started.promise;
    await f.client.forget([target]);
    pending.resolve(ok(snapshot));
    expect(await read).toBeNull();
  });

  it("reports confirmed access loss only to the captured current owner and scope", async () => {
    const f = fixture(); f.client.bindOwner(owner, "session-a");
    f.invoke.mockImplementation(async input => input.op === "bind" ? ok({ lease }) : { ok: false, reason: "access_lost", scope: "workspace" });
    await expect(f.client.refresh(target, 200)).rejects.toThrow();
    expect(f.lost).toHaveBeenCalledWith(owner, target, "workspace");
  });

  it("does not erase cached presentation for a transient failure or a missing native command", async () => {
    const f = fixture(); f.client.bindOwner(owner, "session-a");
    f.invoke.mockRejectedValue(new Error("missing native command"));
    expect(await f.client.read(target, 200)).toBeNull();
    expect(f.lost).not.toHaveBeenCalled();
  });

  it("protects the selected chat after a transient bind failure before a later refresh can evict it", async () => {
    const f = fixture(); f.client.bindOwner(owner, "session-a");
    let unavailable = true;
    f.invoke.mockImplementation(async input => {
      if (input.op === "bind") {
        if (unavailable) { unavailable = false; return { ok: false, reason: "unavailable" }; }
        return ok({ lease });
      }
      return ok(input.op === "protect" ? null : { range: snapshot.range, replaced: false });
    });
    await f.client.protect(target);
    await f.client.refresh(target);
    expect(f.invoke.mock.calls.map(([call]) => call.op)).toEqual(["bind", "bind", "protect", "refresh"]);
    expect(f.invoke.mock.calls[2][0]).toEqual({ op: "protect", target, lease });
  });

  it("restores open-chat protection when main replaces the lease within the same sign-in", async () => {
    const f = fixture(); f.client.bindOwner(owner, "session-a");
    const replacement = "44444444-4444-4444-8444-444444444444";
    let current = lease;
    f.invoke.mockImplementation(async input => {
      if (input.op === "bind") return ok({ lease: current });
      if (input.lease !== current) return { ok: false, reason: "owner_changed" };
      return ok(input.op === "protect" ? null : { range: snapshot.range, replaced: false });
    });
    await f.client.protect(target);
    current = replacement;
    await expect(f.client.refresh(target)).rejects.toMatchObject({ reason: "owner_changed" });
    await f.client.refresh(target);
    expect(f.invoke.mock.calls.slice(-3).map(([call]) => call.op)).toEqual(["bind", "protect", "refresh"]);
    expect(f.invoke.mock.calls.at(-2)?.[0]).toEqual({ op: "protect", target, lease: replacement });
  });
});

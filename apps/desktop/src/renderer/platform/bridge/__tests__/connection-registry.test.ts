import { describe, expect, it, vi } from "vitest";

import { RuntimeConnectionRegistry } from "../connection-registry";
import {
  runtimeExecutionKey,
  type RuntimeExecutionIdentity,
} from "../ws-client";

class FakeClient {
  private listeners = new Set<(identity: RuntimeExecutionIdentity) => void>();
  readonly dispose = vi.fn();

  constructor(public executionIdentity: RuntimeExecutionIdentity) {}

  onExecutionIdentityChange(
    listener: (identity: RuntimeExecutionIdentity) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  move(identity: RuntimeExecutionIdentity): void {
    this.executionIdentity = identity;
    for (const listener of this.listeners) listener(identity);
  }
}

const local = (): RuntimeExecutionIdentity => ({
  kind: "local",
  sidecar: "active",
});
const cloud = (
  workspaceId: string,
  generation = 1,
): RuntimeExecutionIdentity => ({
  kind: "cloud",
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId,
  generation,
  authorityEpoch: generation,
  engineInstanceId: `${String(generation).padStart(8, "0")}-2222-4222-8222-222222222222`,
});

describe("runtime connection registry", () => {
  it("keys cloud connections by exact authority and keeps credentials out", () => {
    const identity = cloud("33333333-3333-4333-8333-333333333333", 7);
    const key = runtimeExecutionKey(identity);
    expect(key).toContain(":7:7:");
    expect(key).not.toContain("token");
    expect(runtimeExecutionKey(local())).toBe("local:sidecar");
  });

  it("atomically rekeys the active client after an execution rotation", () => {
    const registry = new RuntimeConnectionRegistry();
    const first = cloud("33333333-3333-4333-8333-333333333333");
    const rotated = cloud("33333333-3333-4333-8333-333333333333", 2);
    const client = new FakeClient(first);
    registry.register(client);
    registry.activate(first);

    client.move(rotated);

    expect(registry.get(first)).toBeNull();
    expect(registry.active()).toBe(client);
    expect(registry.get(rotated)).toBe(client);
  });

  it("bounds retained clients and evicts only the least-recent hidden entry", () => {
    const registry = new RuntimeConnectionRegistry(2);
    const localClient = new FakeClient(local());
    const firstIdentity = cloud("33333333-3333-4333-8333-333333333333");
    const firstCloud = new FakeClient(firstIdentity);
    registry.register(localClient);
    registry.activate(local());
    registry.register(firstCloud);

    const secondCloud = new FakeClient(
      cloud("44444444-4444-4444-8444-444444444444"),
    );
    registry.register(secondCloud);

    expect(localClient.dispose).not.toHaveBeenCalled();
    expect(firstCloud.dispose).toHaveBeenCalledOnce();
    expect(registry.size).toBe(2);
  });

  it("fails closed when a rotating client claims an existing exact key", () => {
    const registry = new RuntimeConnectionRegistry();
    const firstIdentity = cloud("33333333-3333-4333-8333-333333333333");
    const secondIdentity = cloud("44444444-4444-4444-8444-444444444444");
    const first = new FakeClient(firstIdentity);
    const second = new FakeClient(secondIdentity);
    registry.register(first);
    registry.register(second);

    second.move(firstIdentity);

    expect(second.dispose).toHaveBeenCalledOnce();
    expect(registry.get(firstIdentity)).toBe(first);
    expect(registry.get(secondIdentity)).toBeNull();
  });
});

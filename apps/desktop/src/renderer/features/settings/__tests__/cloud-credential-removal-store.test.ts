import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const storage = vi.hoisted(() => ({ values: new Map<string, unknown>(), accepts: true, drops: false, unreadable: false, recoverOnWrite: false, writes: 0 }));
vi.mock("../../../platform/settings", () => ({
  getSetting: (key: string, fallback: unknown) => storage.unreadable ? fallback : storage.values.get(key) ?? fallback,
  setSetting: (key: string, value: unknown) => {
    storage.writes++; if (storage.recoverOnWrite) storage.unreadable = false;
    if (!storage.accepts) return false;
    if (!storage.drops) storage.values.set(key, structuredClone(value));
    return true;
  },
}));
import { beginCloudCredentialRemoval, acceptCloudCredentialRemovalOutcome, decideCloudCredentialRemovalState,
  type CloudCredentialRemovalTarget } from "../cloud-credential-removal";
import { readCloudCredentialRemovalIntent, persistCloudCredentialRemovalIntent, findCloudCredentialRemovalIntent } from "../cloud-credential-removal-store";

const ids = Array.from({ length: 6 }, (_, i) => `${String(i + 1).padStart(8,"0")}-1111-4111-8111-111111111111`);
const target: CloudCredentialRemovalTarget = { kind: "remove-organization-credential", organizationId: ids[1], credentialId: ids[2], expectedCredentialRevision: 1 };
function awaiting() {
  return acceptCloudCredentialRemovalOutcome(beginCloudCredentialRemoval(ids[3], target), {
    version: 1, operationId: ids[3], revision: 2, state: "awaiting-confirmation", confirmedRunning: true, expiresAt: "2026-10-08T17:00:00Z",
  });
}
beforeEach(() => {
  storage.values.clear(); storage.accepts = true; storage.drops = false; storage.unreadable = false; storage.recoverOnWrite = false; storage.writes = 0;
  vi.stubGlobal("localStorage", {
    getItem(key: string) {
      if (storage.unreadable) throw new Error("Synthetic unavailable storage");
      const value = storage.values.get(key.replace(/^zeros-/, "")); return value === undefined ? null : JSON.stringify(value);
    },
    setItem(key: string, raw: string) {
      storage.writes++; if (storage.recoverOnWrite) storage.unreadable = false;
      if (!storage.accepts) throw new Error("Synthetic storage write refusal");
      if (!storage.drops) storage.values.set(key.replace(/^zeros-/, ""), JSON.parse(raw));
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("durable exact-account cloud removal intent", () => {
  it("retains operation and submitted Yes identity across a new Settings instance", () => {
    const state = decideCloudCredentialRemovalState(awaiting(), "confirm", ids[4]);
    persistCloudCredentialRemovalIntent(ids[0], state);
    const restored = readCloudCredentialRemovalIntent(ids[0], state.operationId);
    expect(restored).toEqual(state);
    expect(restored?.decision).toEqual({ action: "confirm", requestId: ids[4], expectedRevision: 2 });
    expect(findCloudCredentialRemovalIntent(ids[0], target)).toEqual(state);
  });

  it("does not expose another account, organization or replacement source revision", () => {
    persistCloudCredentialRemovalIntent(ids[0], awaiting());
    expect(readCloudCredentialRemovalIntent(ids[5], ids[3])).toBeUndefined();
    expect(findCloudCredentialRemovalIntent(ids[0], { ...target, organizationId: ids[5] })).toBeUndefined();
    expect(findCloudCredentialRemovalIntent(ids[0], { ...target, expectedCredentialRevision: 2 })).toBeUndefined();
  });

  it.each(["refused", "silently-dropped"] as const)("refuses to submit an identity when persistence is %s", mode => {
    storage.accepts = mode !== "refused";
    storage.drops = mode === "silently-dropped";
    expect(() => persistCloudCredentialRemovalIntent(ids[0], decideCloudCredentialRemovalState(awaiting(), "confirm", ids[4]))).toThrow();
  });

  it("never overwrites a submitted decision with cleanup or a different request ID", () => {
    const first = decideCloudCredentialRemovalState(awaiting(), "confirm", ids[4]);
    persistCloudCredentialRemovalIntent(ids[0], first);
    expect(() => persistCloudCredentialRemovalIntent(ids[0], awaiting())).toThrow();
    expect(() => persistCloudCredentialRemovalIntent(ids[0], decideCloudCredentialRemovalState(awaiting(), "cancel", ids[5]))).toThrow();
    expect(readCloudCredentialRemovalIntent(ids[0], ids[3])).toEqual(first);
  });

  it("keeps monotonic CP outcomes and terminal removal identity without guessing success", () => {
    const first = decideCloudCredentialRemovalState(awaiting(), "confirm", ids[4]);
    persistCloudCredentialRemovalIntent(ids[0], first);
    const removing = acceptCloudCredentialRemovalOutcome(first, { version: 1, operationId: ids[3], revision: 3, state: "pending", phase: "removing", retryAfterMs: 100 });
    persistCloudCredentialRemovalIntent(ids[0], removing);
    expect(() => persistCloudCredentialRemovalIntent(ids[0], first)).toThrow();
    const removed = acceptCloudCredentialRemovalOutcome(removing, { version: 1, operationId: ids[3], revision: 4, state: "removed" });
    persistCloudCredentialRemovalIntent(ids[0], removed);
    expect(readCloudCredentialRemovalIntent(ids[0], ids[3])?.outcome?.state).toBe("removed");
    expect(findCloudCredentialRemovalIntent(ids[0], target)).toBeUndefined();
  });

  it("bounds retained intents without evicting an unresolved Yes", () => {
    const first = decideCloudCredentialRemovalState(awaiting(), "confirm", ids[4]);
    persistCloudCredentialRemovalIntent(ids[0], first);
    for (let i = 0; i < 63; i++) {
      const operationId = `${String(i + 100).padStart(8,"0")}-1111-4111-8111-111111111111`;
      persistCloudCredentialRemovalIntent(ids[0], beginCloudCredentialRemoval(operationId, { ...target, expectedCredentialRevision: i + 2 }));
    }
    expect(() => persistCloudCredentialRemovalIntent(ids[0], beginCloudCredentialRemoval(ids[5], { ...target, expectedCredentialRevision: 100 }))).toThrow();
    expect(readCloudCredentialRemovalIntent(ids[0], ids[3])).toEqual(first);
  });

  it("refuses an unreadable prior Yes even if storage would recover on write, preserving the unknown-ACK identity", () => {
    const first = decideCloudCredentialRemovalState(awaiting(), "confirm", ids[4]);
    persistCloudCredentialRemovalIntent(ids[0], first);
    const before = structuredClone([...storage.values]); storage.writes = 0; storage.unreadable = true; storage.recoverOnWrite = true;
    expect(() => findCloudCredentialRemovalIntent(ids[0], target)).toThrow();
    expect(() => persistCloudCredentialRemovalIntent(ids[0], beginCloudCredentialRemoval(ids[5], target))).toThrow();
    expect(storage.writes).toBe(0); expect([...storage.values]).toEqual(before);
    storage.unreadable = false;
    expect(findCloudCredentialRemovalIntent(ids[0], target)).toEqual(first);
  });
});

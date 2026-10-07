import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  readFreshCloudRuntimeQuietSnapshot,
  cloudRuntimeQuietAbsentPolicy,
} from "./runtime-quiet-trigger.js";

const scope = {
  workspaceId: randomUUID(),
  organizationId: randomUUID(),
  generation: 1,
  engineInstanceId: randomUUID(),
};
function snapshot(challenge: string) {
  return {
    version: 1 as const,
    challenge,
    ...scope,
    activityRevision: 4,
    quietForMs: 60_000,
    stable: true,
    recordSync: "ready" as const,
    workloadBusy: false,
    livePty: false,
    userProcesses: "idle" as const,
    presence: "absent" as const,
  };
}
describe("fresh cloud runtime quiet evidence", () => {
  it("accepts an exact fresh source and gives each read a different challenge", async () => {
    const read = vi.fn(async (request) => snapshot(request.challenge));
    const first = await readFreshCloudRuntimeQuietSnapshot(read, scope);
    const second = await readFreshCloudRuntimeQuietSnapshot(read, scope);
    expect(first).toMatchObject({
      snapshot: { ...scope, activityRevision: 4 },
    });
    expect(first!.snapshot.challenge === second!.snapshot.challenge).toBe(
      false,
    );
  });
  it.each([
    "workspaceId",
    "organizationId",
    "engineInstanceId",
    "challenge",
  ] as const)("rejects a foreign %s", async (key) => {
    expect(
      await readFreshCloudRuntimeQuietSnapshot(
        async (request) => ({
          ...snapshot(request.challenge),
          [key]: randomUUID(),
        }),
        scope,
      ),
    ).toBeNull();
  });
  it("rejects a new generation, extra data, stale observations and unavailable readers", async () => {
    expect(
      await readFreshCloudRuntimeQuietSnapshot(
        async (request) => ({ ...snapshot(request.challenge), generation: 2 }),
        scope,
      ),
    ).toBeNull();
    expect(
      await readFreshCloudRuntimeQuietSnapshot(
        async (request) => ({
          ...snapshot(request.challenge),
          privateData: "must not escape",
        }),
        scope,
      ),
    ).toBeNull();
    let now = 0;
    expect(
      await readFreshCloudRuntimeQuietSnapshot(
        async (request) => {
          now = 2_001;
          return snapshot(request.challenge);
        },
        scope,
        () => now,
      ),
    ).toBeNull();
    expect(
      await readFreshCloudRuntimeQuietSnapshot(async () => {
        throw new Error("private diagnostics");
      }, scope),
    ).toBeNull();
  });
  it("bounds a hung reader and aborts its transport", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const pending = readFreshCloudRuntimeQuietSnapshot(async (request) => {
        signal = request.signal;
        return new Promise(() => {});
      }, scope);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await pending).toBeNull();
      expect(signal!.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it("defaults to absent clients, sixty quiet seconds and all guards clear", () => {
    const ready = snapshot(randomUUID());
    expect(cloudRuntimeQuietAbsentPolicy.accepts(ready)).toBe(true);
    for (const override of [
      { presence: "present" },
      { presence: "unknown" },
      { quietForMs: 59_999 },
      { workloadBusy: true },
      { livePty: true },
      { userProcesses: "busy" },
      { userProcesses: "unknown" },
      { stable: false },
      { recordSync: "pending" },
      { recordSync: "failed" },
    ])
      expect(
        cloudRuntimeQuietAbsentPolicy.accepts({
          ...ready,
          ...override,
        } as typeof ready),
      ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { FakeBoat } from "./__fixtures__/boat-fake.js";
import { diskSettled, stopKeepingWrites } from "./boat-disk.js";

/** A running machine on the fake, and the sleeps a helper asked for, in order. */
async function running() {
  const boat = new FakeBoat(() => 1_000), sleeps: number[] = [];
  const { sandboxId } = await boat.create({ key: "k", name: "m", env: {} });
  return { boat, sandboxId, wait: { sleep: async (ms: number) => { sleeps.push(ms); } }, sleeps };
}

describe("stopping a machine so its archive holds its writes", () => {
  it("holds when nothing was in progress and the stop's own attempt completed", async () => {
    const { boat, sandboxId, wait } = await running();
    expect(await stopKeepingWrites(boat, sandboxId, wait)).toMatchObject({ holds: true, failed: false, status: "completed" });
  });

  it("does not hold when a failed attempt is reported for one read right after the stop: it reads at once", async () => {
    const { boat, sandboxId, wait, sleeps } = await running();
    boat.attemptAtStop = { inProgressReads: 0, failedReads: 1 };
    const inspects = () => boat.calls.filter(call => call.op === "inspect").length;
    expect(await stopKeepingWrites(boat, sandboxId, wait)).toMatchObject({ holds: false, failed: true });
    // The read before the stop, then the first read after it with no sleep between.
    expect(inspects()).toBeGreaterThanOrEqual(2);
    expect(sleeps[0] ?? 0).toBeLessThanOrEqual(300);
  });

  it("does not hold when an attempt began between the last read and the stop, though none is reported failed", async () => {
    const { boat, sandboxId, wait } = await running();
    boat.attemptAtStop = { inProgressReads: 1, failedReads: 0 };
    expect(await stopKeepingWrites(boat, sandboxId, wait)).toMatchObject({ holds: false, failed: false });
  });

  it("counts the stop as failed when the wait before it gives up on an attempt in progress, or on a machine never hydrated", async () => {
    const attempt = await running();
    attempt.boat.beginSnapshotAttempt(attempt.sandboxId);
    expect(await stopKeepingWrites(attempt.boat, attempt.sandboxId, { ...attempt.wait, reads: 3 })).toMatchObject({ holds: false, failed: true });
    const restoring = await running();
    restoring.boat.machine(restoring.sandboxId)!.hydrateReads = 100;
    expect(await stopKeepingWrites(restoring.boat, restoring.sandboxId, { ...restoring.wait, reads: 3 })).toMatchObject({ holds: false, failed: true });
  });

  it("waits out an attempt in progress and a restore before the stop, then holds", async () => {
    const { boat, sandboxId, wait, sleeps } = await running();
    boat.machine(sandboxId)!.hydrateReads = 2;
    boat.beginSnapshotAttempt(sandboxId, 3);
    expect(await stopKeepingWrites(boat, sandboxId, wait)).toMatchObject({ holds: true, failed: false });
    expect(sleeps.length).toBeGreaterThan(0);
    expect(await diskSettled(boat, (await boat.create({ key: "k2", name: "m2", env: {} })).sandboxId, wait)).toBe("settled");
  });
});

import { describe, expect, it } from "vitest";
import { builderFixture, builderIntent, BUILDER_SANDBOX } from "./cloud-builder-vm-test-fixtures.js";

describe("the capture deadline bounds every provider request", () => {
  it.each(["initial inspection", "stop request"])("aborts a stalled %s within the caller's remaining time", async phase => {
    const f = builderFixture();
    const vm = await f.vms.create({ ...builderIntent, purpose: "computer-build" });
    Object.assign(f.state, { stopId: "stop_3f9a1c2e7b4d5a60", stopStatuses: ["pending", "completed"],
      snapshot: { snapshotAvailable: true, lastSnapshotStatus: "completed" }, states: ["running"] });
    const fetch = f.fetcher.getMockImplementation()!;
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    f.fetcher.mockImplementation(async (...args) => {
      const url = String(args[0]), method = args[1]?.method ?? "GET";
      const block = phase === "initial inspection"
        ? method === "GET" && url.endsWith(`/sandboxes/${BUILDER_SANDBOX}`)
        : method === "POST" && url.endsWith(`/sandboxes/${BUILDER_SANDBOX}/stop`);
      if (!block) return fetch(...args);
      return new Promise<Response>((resolve, reject) => {
        const signal = args[1]!.signal!;
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        release = () => {
          signal.removeEventListener("abort", abort);
          f.advance(501);
          resolve(Response.json({ ok: true, sandbox: { id: BUILDER_SANDBOX, state: "running" },
            stop: { id: f.state.stopId, status: "pending" } }));
        };
        enter();
      });
    });
    let settled = false;
    const stopped = f.vms.stop(vm, { timeoutMs: 100, requireSnapshot: true })
      .then(result => ({ result }), error => ({ error }))
      .finally(() => { settled = true; });
    await entered;
    await new Promise(resolve => setTimeout(resolve, 250));
    const stoppedWithinBound = settled;
    release();
    const result = await stopped;
    expect(stoppedWithinBound).toBe(true);
    expect(result).toMatchObject({ error: { check: "timeout" } });
  });
});

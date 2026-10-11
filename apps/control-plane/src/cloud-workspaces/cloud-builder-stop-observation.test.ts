import { describe, expect, it } from "vitest";
import { BuilderVmError } from "./cloud-builder-vm.js";
import { BUILDER_SANDBOX, builderFixture, builderIntent } from "./cloud-builder-vm-test-fixtures.js";

const stopId = "stop_3f9a1c2e7b4d5a60";
const snapshot = { snapshotAvailable: true, lastSnapshotStatus: "completed" };
async function fixture(statuses: string[] = ["pending", "completed"]) {
  const f = builderFixture();
  const vm = await f.vms.create({ ...builderIntent, purpose: "computer-build" });
  Object.assign(f.state, { stopId, stopStatuses: statuses, snapshot, states: ["running"] });
  return { f, vm };
}

describe("the exact template stop must justify capture", () => {
  it.each(["superseded", "pending"])("does not accept an archived snapshot while the pinned stop is %s", async status => {
    const { f, vm } = await fixture(status === "pending" ? ["pending"] : ["pending", status]);
    const fetch = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (...args) => {
      const reply = await fetch(...args);
      if (String(args[0]).endsWith(`/stops/${stopId}`)) {
        const body = await reply.clone().json() as { stop?: { status?: string } };
        // Another resume/stop can archive the VM after the old stop was superseded.
        // An inconsistent pending operation also is not a completed stop receipt.
        if (body.stop?.status === status) f.state.states = ["archived"];
      }
      return reply;
    });
    await expect(f.vms.stop(vm, { timeoutMs: 10_000, requireSnapshot: true })).rejects.toBeInstanceOf(BuilderVmError);
    expect((await f.operations.find(vm.operationKey))?.state).toBe("stopping");
  });

  it("requires an identified stop even when an action and following read report an archived snapshot", async () => {
    const { f, vm } = await fixture();
    f.state.stopId = null;
    await expect(f.vms.stop(vm, { timeoutMs: 10_000, requireSnapshot: true })).rejects.toMatchObject({ check: "stop_unconfirmed" });
  });

  it("does not reuse an already archived snapshot with no receipt from this sanitized build", async () => {
    const { f, vm } = await fixture();
    f.state.states = ["archived"];
    await expect(f.vms.stop(vm, { timeoutMs: 10_000, requireSnapshot: true })).rejects.toMatchObject({ check: "stop_unconfirmed" });
  });

  it("rejects a final archive observation received after the absolute capture deadline", async () => {
    const { f, vm } = await fixture(["completed"]);
    const fetch = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (...args) => {
      const reply = await fetch(...args);
      if (String(args[0]).endsWith(`/sandboxes/${BUILDER_SANDBOX}`) && (args[1]?.method ?? "GET") === "GET") {
        const body = await reply.clone().json() as { sandbox?: { state?: string } };
        if (body.sandbox?.state === "archived") f.advance(10_001);
      }
      return reply;
    });
    await expect(f.vms.stop(vm, { timeoutMs: 10_000, requireSnapshot: true })).rejects.toMatchObject({ check: "timeout" });
  });
});

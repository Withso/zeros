// Phase 0 conformance experiment. This is deliberately outside the product:
// no new persisted surface kinds or executable adapters are enabled here.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

class AdapterSlots {
  slots = 0;
  owners = new Map();
  constructor(limit = 3) {
    this.limit = limit;
  }
  replace(owner, kind, mount) {
    if (kind !== "authored") throw new Error("Unknown adapter kind");
    if (this.slots >= this.limit) throw new Error("No replacement slot");
    let record = this.owners.get(owner);
    if (!record) {
      record = { current: null, pending: null };
      this.owners.set(owner, record);
    }
    record.pending?.abort();
    const controller = new AbortController();
    record.pending = controller;
    this.slots++;
    const ready = Promise.resolve()
      .then(() => mount(controller.signal))
      .then(
        async (adapter) => {
          let disposed = false;
          const lease = {
            dispose: async () => {
              if (disposed) return;
              disposed = true;
              await adapter.dispose();
              this.slots--;
            },
          };
          if (
            controller.signal.aborted ||
            this.owners.get(owner) !== record ||
            record.pending !== controller
          ) {
            await lease.dispose();
            return false;
          }
          const previous = record.current;
          record.current = lease;
          record.pending = null;
          await previous?.dispose();
          return true;
        },
        (error) => {
          this.slots--;
          if (record.pending === controller) record.pending = null;
          throw error;
        },
      );
    return { ready, cancel: () => controller.abort() };
  }
  async remove(owner) {
    const record = this.owners.get(owner);
    if (!record) return;
    this.owners.delete(owner);
    record.pending?.abort();
    await record.current?.dispose();
  }
}
const checks = [];
const slots = new AdapterSlots();
const disposed = [];
const adapter = (id) => ({
  dispose: async () => {
    disposed.push(id);
  },
});
const deferred = () => {
  let resolve;
  const promise = new Promise((ready) => {
    resolve = ready;
  });
  return { promise, resolve };
};
const check = (label, value) => {
  assert.ok(value, label);
  checks.push(label);
};
assert.throws(
  () =>
    slots.replace("workspace-a/frame", "future-kind", () => adapter("unknown")),
  /Unknown/,
);
check("Unknown kinds consume no slots and never mount", slots.slots === 0);
await slots.replace("workspace-a/frame", "authored", () => adapter("a-v1"))
  .ready;
await slots.replace("workspace-b/frame", "authored", () => adapter("b-v1"))
  .ready;
const late = deferred();
const replacement = slots.replace(
  "workspace-a/frame",
  "authored",
  () => late.promise,
);
assert.throws(
  () =>
    slots.replace("workspace-c/frame", "authored", () => adapter("overflow")),
  /replacement slot/,
);
check(
  "Pending replacement counts with both displayed owners",
  slots.slots === 3 && !disposed.includes("a-v1"),
);
replacement.cancel();
check(
  "Cancellation retains admission until late mount is disposed",
  slots.slots === 3,
);
late.resolve(adapter("a-cancelled"));
assert.equal(await replacement.ready, false);
check(
  "Late readiness cannot replace the current generation",
  disposed.includes("a-cancelled") &&
    !disposed.includes("a-v1") &&
    slots.slots === 2,
);
const deleted = deferred();
const flight = slots.replace(
  "workspace-a/frame",
  "authored",
  () => deleted.promise,
);
await slots.remove("workspace-a/frame");
const recreated = slots.replace("workspace-a/frame", "authored", () =>
  adapter("a-recreated"),
);
deleted.resolve(adapter("a-deleted"));
assert.equal(await flight.ready, false);
await recreated.ready;
check(
  "Deleting and recreating an owner cannot resurrect its late adapter",
  disposed.includes("a-deleted") &&
    disposed.includes("a-v1") &&
    !disposed.includes("a-recreated"),
);
await slots.remove("workspace-a/frame");
check(
  "Owner deletion leaves independent owners mounted",
  !disposed.includes("b-v1") && slots.slots === 1,
);
await slots.remove("workspace-b/frame");
check("Teardown returns the aggregate slot count to zero", slots.slots === 0);
await mkdir(".context", { recursive: true });
await writeFile(
  ".context/design-adapter-prototype.json",
  JSON.stringify(
    {
      checks,
      qualification:
        "Inert lifecycle model only; actual hosts must additionally prove process cleanup, isolation, and resource budgets.",
    },
    null,
    2,
  ),
);
for (const label of checks) console.log("PASS", label);

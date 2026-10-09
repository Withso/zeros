import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudActionRuntime } from "../cloud-action-runtime";
import { CloudLocalCommandQueue } from "../cloud-local-command-queue";
import { CloudLocalCommandActionStore } from "../cloud-local-command-queue-actions";
import { CloudActorAuthorityRegistry } from "../agents/cloud-actor-authority";
import { testCloudBootFixture } from "../agents/__tests__/helpers/test-cloud-boot";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "zeros-action-cutover-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const f = await testCloudBootFixture(directory); cleanup.push(f.close);
  const registry = new CloudActorAuthorityRegistry({ scope: f.scope, engineLive: () => true });
  registry.confirm(f.provenance); cleanup.push(() => registry.dispose());
  const file = path.join(directory, "queue.sqlite");
  const queue = new CloudLocalCommandQueue({ file, scope: f.scope, actors: registry, engineLive: () => true,
    ready: () => true, history: () => ({ recordSequence: 0, eventSequence: 0 }) }); cleanup.push(() => queue.close());
  const store = new CloudLocalCommandActionStore({ file, queue, engineLive: () => true,
    authorize: (id, capability) => registry.authorizeCurrent(id, capability) }); cleanup.push(() => store.close());
  const request = vi.fn(async (): Promise<unknown> => { throw new Error("Unexpected legacy CP action request"); });
  const dispatch = vi.fn(async () => ({ outcome: "delivered" as const, turnId: "turn" }));
  const runtime = new CloudActionRuntime({ request, dispatch, changed: vi.fn(), validate: () => true,
    authorize: async (_action, id) => { registry.authorizeCurrent(id!, "run"); } }); cleanup.push(() => runtime.close());
  const action = { operationId: randomUUID(), conversationId: "chat", executionId: "execution", kind: "permission" as const,
    requestId: randomUUID(), payload: { response: { outcome: { outcome: "cancelled" as const } } } };
  return { ...f, store, runtime, request, dispatch, action };
}
describe("negotiated FULL action source cutover", () => {
  it("routes exact begin/read/settle/retry locally without a legacy CP request", async () => {
    const f = await fixture(); f.runtime.installLocalStore(f.store);
    expect(await f.runtime.handle({ kind: "submit", action: f.action }, f.provenance.actorSessionId))
      .toMatchObject({ state: "settled", outcome: "delivered" });
    expect(await f.runtime.handle({ kind: "submit", action: f.action }, f.provenance.actorSessionId))
      .toMatchObject({ state: "settled", replayed: true });
    expect(await f.runtime.handle({ kind: "read", operationId: f.action.operationId }, f.provenance.actorSessionId))
      .toMatchObject({ outcome: "delivered" });
    expect(f.dispatch).toHaveBeenCalledOnce(); expect(f.request).not.toHaveBeenCalled();
  });
  it("rejects a copied source and preserves the installed original", async () => {
    const f = await fixture(); f.runtime.installLocalStore(f.store); f.runtime.installLocalStore(f.store);
    expect(() => f.runtime.installLocalStore({ ...f.store } as CloudLocalCommandActionStore)).toThrow("engine_authority_rejected");
    await f.runtime.handle({ kind: "submit", action: f.action }, f.provenance.actorSessionId);
    expect(f.request).not.toHaveBeenCalled();
  });
  it("does not cross the source boundary while a legacy request is in flight", async () => {
    const f = await fixture(); let reject!: (error: Error) => void;
    f.request.mockImplementationOnce(() => new Promise((_resolve, failure) => { reject = failure; }));
    const read = f.runtime.handle({ kind: "read", operationId: f.action.operationId }, f.provenance.actorSessionId);
    expect(() => f.runtime.installLocalStore(f.store)).toThrow("command_conflict");
    reject(new Error("closed legacy read")); await expect(read).rejects.toThrow("closed legacy read");
    f.runtime.installLocalStore(f.store); expect(f.runtime.hasActiveWork()).toBe(false);
  });
});

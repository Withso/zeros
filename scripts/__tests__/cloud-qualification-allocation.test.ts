import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Daytona } from "@daytona/sdk";
import { describe, expect, it, vi } from "vitest";
import { createQualificationSandbox, cleanupQualificationAllocation, withQualificationAllocationRun, type QualificationAllocation } from "../cloud-workspace-validation/lib/qualification-allocation";

function fixture() {
  let saved: QualificationAllocation | null = null;
  const order: string[] = [];
  let resource: any;
  const store = { providerScope: "a".repeat(64), read: () => saved, write: (value: QualificationAllocation) => { order.push("persist"); saved = value; }, clear: () => { saved = null; } };
  const client = {
    create: vi.fn(async (params: any) => {
      order.push("create");
      resource = { id: randomUUID(), name: params.name, labels: params.labels, snapshot: params.snapshot,
        createdAt: new Date().toISOString(), autoDestroyAt: new Date(Date.now() + params.ttlMinutes * 60_000).toISOString(),
        delete: vi.fn(async () => { resource = undefined; }),
      };
      return resource;
    }),
    get: vi.fn(async () => resource),
    list: async function* () { if(resource) yield resource; },
  };
  return {store,client,order,resource:()=>resource};
}

describe("qualification allocation crash recovery", () => {
  it("retains a receipt when provider credentials or endpoint scope change", async () => {
    const f = fixture();
    await createQualificationSandbox(f.client,f.store,{snapshot:"pinned",ttlMinutes:60});
    f.store.providerScope = "b".repeat(64);
    f.client.get.mockImplementation(async()=>{throw new Error("not found in another account");});
    await expect(cleanupQualificationAllocation(f.client,f.store)).rejects.toThrow(/scope/);
    expect(f.client.get).not.toHaveBeenCalled();
    expect(f.store.read()).not.toBeNull();
  });
  it("refuses legacy connection state even when no allocation intent exists", async () => {
    const f = fixture();
    await expect(withQualificationAllocationRun(f.client, f.store, store =>
      createQualificationSandbox(f.client, store, {snapshot:"pinned",ttlMinutes:60}),
      { hasExistingState: true })).rejects.toThrow(/previous/);
    expect(f.client.create).not.toHaveBeenCalled();
    expect(f.client.get).not.toHaveBeenCalled();
  });
  it("cleans an acknowledged create even when its snapshot fails qualification", async () => {
    const f = fixture(); const create = f.client.create.getMockImplementation()!;
    f.client.create.mockImplementation(async p => {const r = await create(p); r.snapshot = "unexpected"; return r;});
    await expect(withQualificationAllocationRun(f.client, f.store, store =>
      createQualificationSandbox(f.client, store, {snapshot:"pinned",ttlMinutes:60}))).rejects.toThrow(/identity/);
    expect(f.resource()).toBeUndefined();
    expect(f.store.read()).toBeNull();
  });
  it("never cleans a previous run when new provisioning is refused", async () => {
    const f = fixture();
    const prior = await createQualificationSandbox(f.client, f.store, {snapshot:"pinned",ttlMinutes:60});
    await expect(withQualificationAllocationRun(f.client, f.store, async store => {
      return createQualificationSandbox(f.client, store, {snapshot:"pinned",ttlMinutes:60});
    })).rejects.toThrow(/previous/);
    expect(prior.delete).not.toHaveBeenCalled();
    expect(f.store.read()?.sandboxId).toBe(prior.id);
    expect(f.client.create).toHaveBeenCalledOnce();
  });
  it("cleans only this invocation after a missing provider deadline", async () => {
    const f = fixture(); const create = f.client.create.getMockImplementation()!;
    f.client.create.mockImplementation(async p => { const r = await create(p); delete r.autoDestroyAt; return r; });
    await expect(withQualificationAllocationRun(f.client, f.store, store =>
      createQualificationSandbox(f.client, store, {snapshot:"pinned",ttlMinutes:60}))).rejects.toThrow(/deadline/);
    expect(f.resource()).toBeUndefined();
    expect(f.store.read()).toBeNull();
  });
  it("sends the wall-clock TTL in the pinned SDK's actual create HTTP body", async () => {
    let body: Record<string, unknown> | undefined;
    const server = createServer(async (request, response) => {
      let text = "";
      for await (const chunk of request) text += chunk.toString();
      if (request.method === "POST" && request.url === "/sandbox") body = JSON.parse(text);
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "Intentional transport fixture" }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const client = new Daytona({ apiKey: "fixture-key", apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        target: "eu", requestTimeoutMs: 1000, useDeprecatedPolling: true });
      await expect(client.create({ snapshot: "pinned-fixture", ttlMinutes: 60 }, { timeout: 1 })).rejects.toThrow();
      expect(body).toMatchObject({ snapshot: "pinned-fixture", ttlMinutes: 60 });
    } finally { server.closeAllConnections(); await new Promise<void>((resolve,reject) => server.close(e=>e?reject(e):resolve())); }
  });
  it("persists intent before create and verifies an actual wall-clock deadline", async () => {
    const f=fixture();
    const sandbox=await createQualificationSandbox(f.client,f.store,{snapshot:"pinned",ttlMinutes:60});
    expect(f.order).toEqual(["persist","create","persist"]);
    expect(f.store.read()?.sandboxId).toBe(sandbox.id);
    expect(f.client.create.mock.calls[0]![0]).toMatchObject({ttlMinutes:60,public:false});
  });

  it("recovers a committed create after its response is lost without allocating twice", async () => {
    const f=fixture();const create=f.client.create.getMockImplementation()!;
    f.client.create.mockImplementation(async p=>{await create(p);throw new Error("lost acknowledgement");});
    const sandbox=await createQualificationSandbox(f.client,f.store,{snapshot:"pinned",ttlMinutes:60});
    expect(f.client.create).toHaveBeenCalledOnce();
    expect(f.store.read()?.sandboxId).toBe(sandbox.id);
    await cleanupQualificationAllocation(f.client,f.store);
    expect(f.resource()).toBeUndefined();expect(f.store.read()).toBeNull();
  });

  it("does not accept a missing TTL or delete a foreign named resource", async () => {
    const f=fixture();const create=f.client.create.getMockImplementation()!;
    f.client.create.mockImplementation(async p=>{const r=await create(p);delete r.autoDestroyAt;return r;});
    await expect(createQualificationSandbox(f.client,f.store,{snapshot:"pinned",ttlMinutes:60})).rejects.toThrow(/deadline/i);
    f.resource().id = randomUUID();
    await expect(cleanupQualificationAllocation(f.client,f.store)).rejects.toThrow(/identity/i);
    expect(f.resource().delete).not.toHaveBeenCalled();expect(f.store.read()).not.toBeNull();
  });
});

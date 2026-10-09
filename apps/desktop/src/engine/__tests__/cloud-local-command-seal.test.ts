import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalCloudLocalCommandHistoryJson } from "@zeros/protocol/cloud-local-mirror";
import { requestCloudLocalCommandSeal } from "../cloud-local-command-mirror";
import type { CloudRuntimeAuthority } from "../cloud-runtime-registration";

function setup() {
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1, engineInstanceId: randomUUID(),
    bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1 };
  const fields = { version: 1 as const, scope, sealId: randomUUID(), sequence: 3, recordSequence: 4, eventSequence: 9, inventorySha256: "a".repeat(64) };
  const seal = { ...fields, sha256: createHash("sha256").update(canonicalCloudLocalCommandHistoryJson(fields)).digest("hex") };
  const ack = { version: 1 as const, writerEpoch: scope.writerEpoch, sealId: seal.sealId,
    sequence: 3, recordSequence: 4, eventSequence: 9, inventorySha256: seal.inventorySha256, sha256: seal.sha256 };
  const authority: CloudRuntimeAuthority = { organizationId: scope.organizationId, workspaceId: scope.workspaceId, generation: scope.generation, engineInstanceId: scope.engineInstanceId,
    heartbeatToken: `zwh_${"a".repeat(43)}`, heartbeatEndpoint: "https://control.fixture.test/internal/v1/cloud-workspaces/engine/heartbeat" };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ result: ack }));
  const call = (raw: unknown = seal, signal = new AbortController().signal) => requestCloudLocalCommandSeal(authority, raw, signal, fetcher);
  return { scope, seal, ack, authority, fetcher, call };
}
describe("actual private seal HTTP client", () => {
  it("posts immutable descriptor only to the registered CP origin with exact engine scope and no redirects", async () => {
    const f = setup(); expect(await f.call()).toEqual(f.ack);
    const [url, init] = f.fetcher.mock.calls[0]!;
    expect(String(url)).toBe("https://control.fixture.test/internal/v2/cloud-workspaces/engine/commands/seal");
    expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { authorization: `Bearer ${f.authority.heartbeatToken}` } });
    const { heartbeatToken: _token, heartbeatEndpoint: _endpoint, ...scope } = f.authority;
    expect(JSON.parse(String(init!.body))).toEqual({ ...scope, seal: f.seal });
  });
  it.each(["organizationId", "workspaceId", "generation", "engineInstanceId"] as const)("refuses foreign parent %s before fetch", async field => {
    const f = setup(), seal = structuredClone(f.seal);
    if (field === "generation") seal.scope[field]++;
    else seal.scope[field] = randomUUID();
    const { sha256: _hash, ...fields } = seal;
    seal.sha256 = createHash("sha256").update(canonicalCloudLocalCommandHistoryJson(fields)).digest("hex");
    await expect(f.call(seal)).rejects.toMatchObject({ code: "command_context_changed" }); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each(["extra", "hash", "inventory", "unsafe", "invalid-authority", "http", "query", "aborted"])("refuses invalid %s before request", async kind => {
    const f = setup();
    if (kind === "invalid-authority") f.authority.workspaceId = "invalid";
    if (kind === "http") f.authority.heartbeatEndpoint = "http://control.fixture.test/heartbeat";
    if (kind === "query") f.authority.heartbeatEndpoint += "?selector=private";
    const { inventorySha256: _inventory, ...withoutInventory } = f.seal;
    const raw = kind === "extra" ? { ...f.seal, retired: true } : kind === "hash" ? { ...f.seal, sha256: "f".repeat(64) }
      : kind === "inventory" ? withoutInventory : kind === "unsafe" ? { ...f.seal, sequence: Number.MAX_SAFE_INTEGER + 1 } : f.seal;
    const controller = new AbortController(); if (kind === "aborted") controller.abort();
    await expect(f.call(raw, controller.signal)).rejects.toHaveProperty("code"); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each(["sealId", "writerEpoch", "sequence", "recordSequence", "eventSequence", "inventorySha256", "sha256", "extra"] as const)("never acknowledges changed %s", async field => {
    const f = setup();
    const changed = field === "extra" ? { ...f.ack, retired: true } : { ...f.ack, [field]: typeof f.ack[field] === "number" ? 99 :
      field === "sealId" || field === "writerEpoch" ? randomUUID() : "f".repeat(64) };
    f.fetcher.mockResolvedValueOnce(Response.json({ result: changed }));
    await expect(f.call()).rejects.toMatchObject({ code: "command_response_invalid" });
  });
  it.each(["extra-response", "oversized", "json", "closed-error", "unknown-error"])("keeps %s response bounded and closed", async kind => {
    const f = setup();
    f.fetcher.mockResolvedValueOnce(kind === "extra-response" ? Response.json({ result: f.ack, private: "fixture-private" })
      : kind === "oversized" ? new Response("x".repeat(16 * 1024 + 1)) : kind === "json" ? new Response("{")
        : Response.json({ error: kind === "closed-error" ? "command_context_changed" : "fixture-private" }, { status: 409 }));
    await expect(f.call()).rejects.toMatchObject({ code: kind === "closed-error" ? "command_context_changed" : kind === "unknown-error" ?
      "command_service_unavailable" : "command_response_invalid" });
  });
  it("cancels a hung response body and refuses an empty successful ACK", async () => {
    const f = setup(), controller = new AbortController(), cancel = vi.fn();
    f.fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
    const pending = f.call(f.seal, controller.signal);
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce(), { interval: 1 }); controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "command_service_unavailable" }); expect(cancel).toHaveBeenCalledOnce();
    f.fetcher.mockResolvedValueOnce(Response.json({ result: null }));
    await expect(f.call()).rejects.toMatchObject({ code: "command_response_invalid" });
  });
});

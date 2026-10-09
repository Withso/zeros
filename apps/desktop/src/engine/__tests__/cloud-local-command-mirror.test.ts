import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CloudLocalCommandMirrorBatchSchema, type CloudLocalCommandMirrorAck, type CloudLocalCommandMirrorBatch } from "@zeros/protocol/cloud-local-mirror";
import { CloudLocalCommandMirrorDriver, requestCloudLocalCommandMirror } from "../cloud-local-command-mirror";

function setup() {
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1, engineInstanceId: randomUUID(),
    bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1 };
  const batch = CloudLocalCommandMirrorBatchSchema.parse({ version: 1, bootId: scope.bootId, writerEpoch: scope.writerEpoch,
    batchId: randomUUID(), after: 0, through: 1, changes: [{ sequence: 1, conversationId: "chat", revision: 1, paused: false,
      originWriterEpoch: scope.writerEpoch, intent: { userMessageId: "turn", agentId: "claude" },
      actor: { scope, actor: { userId: scope.fundingOwnerUserId, deviceId: randomUUID(), deviceKeyVersion: 1,
        fingerprint: "a".repeat(64), role: "developer" }, actorSessionId: randomUUID(), authorityEpoch: 1,
      confirmedUntilMs: Date.now() + 30_000, fundingConsentVersion: 1, fundingGrant: { kind: "owner" } },
      entry: { commandId: randomUUID(), position: 1, state: "queued", payload: { agentId: "claude", userMessageId: "turn",
        model: "fixture-model", prompt: [{ type: "text", text: "fixture-private-input" }], modeRevision: 0 },
      executionId: null, generation: 1, resultCode: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }] });
  let pending: unknown = batch, live = true;
  const queue = { scope, peekMirrorBatch: vi.fn(() => pending), mirrorDrained: vi.fn(() => pending === null),
    acknowledgeMirror: vi.fn((_ack: CloudLocalCommandMirrorAck) => { pending = null; }) };
  const ack = (value = batch): CloudLocalCommandMirrorAck => ({ version: 1, writerEpoch: value.writerEpoch, batchId: value.batchId, through: value.through });
  const request = vi.fn(async (value: CloudLocalCommandMirrorBatch, _signal: AbortSignal) => ack(value));
  const driver = (override: Partial<ConstructorParameters<typeof CloudLocalCommandMirrorDriver>[0]> = {}) => new CloudLocalCommandMirrorDriver({
    scope, queue, request, assertCurrent: () => { if (!live) throw new Error("fixture-current-refusal"); }, retryDelayMs: 1,
    requestTimeoutMs: 25, ...override });
  return { scope, batch, ack, queue, request, driver, replace: (value: unknown) => { pending = value; }, revoke: () => { live = false; } };
}

describe("background FULL outbox mirror driver", () => {
  it("sends the exact immutable flight and applies only its authenticated ACK", async () => {
    const f = setup(), d = f.driver(); await d.flush({ timeoutMs: 100 });
    expect(f.request).toHaveBeenCalledOnce(); expect(f.request.mock.calls[0]![0]).toEqual(f.batch);
    expect(f.queue.acknowledgeMirror).toHaveBeenCalledWith(f.ack()); expect(f.queue.mirrorDrained()).toBe(true);
    d.close();
  });
  it("retries a lost reply with identical assigned flight, never another claim or fresh batch", async () => {
    const f = setup(); let first = true;
    const request = vi.fn(async (batch: CloudLocalCommandMirrorBatch) => {
      if (first) { first = false; f.replace({ ...f.batch, batchId: randomUUID() }); throw new Error("fixture-private-network-prose"); }
      return f.ack(batch);
    });
    const d = f.driver({ request }); await d.flush({ timeoutMs: 100 });
    expect(request).toHaveBeenCalledTimes(2); expect(request.mock.calls[1]![0]).toEqual(request.mock.calls[0]![0]);
    expect(f.queue.acknowledgeMirror).toHaveBeenCalledOnce(); d.close();
  });
  it("coalesces concurrent flushes into one actual request", async () => {
    const f = setup(); let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const request = vi.fn(async (batch: CloudLocalCommandMirrorBatch) => { await wait; return f.ack(batch); });
    const d = f.driver({ request, requestTimeoutMs: 250 }); const a = d.flush({ timeoutMs: 500 }), b = d.flush({ timeoutMs: 500 });
    const joined = Promise.all([a, b]);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce(), { interval: 1 }); release(); await joined; d.close();
  });
  it.each(["writerEpoch", "batchId", "through", "extra", "feedback"])("never prunes on mismatched %s ACK", async field => {
    const f = setup(); const wrong = { ...f.ack(), ...(field === "through" ? { through: 2 } : field === "extra" ? { extra: "private" }
      : field === "feedback" ? { historyLimits: [{ conversationId: "chat", sha256: "a".repeat(64) }] } : { [field]: randomUUID() }) };
    const d = f.driver({ request: async () => wrong });
    await expect(d.flush({ timeoutMs: 100 })).rejects.toMatchObject({ code: "cloud_mirror_invalid_ack" });
    expect(f.queue.acknowledgeMirror).not.toHaveBeenCalled(); d.close();
  });
  it.each(["bootId", "writerEpoch", "fundingOwnerEpoch", "generation", "two-watermark-terminal"] as const)("refuses invalid/foreign %s flight before sending", async field => {
    const f = setup(), changed = structuredClone(f.batch);
    if (field === "bootId" || field === "writerEpoch") changed[field] = randomUUID();
    else if (field === "two-watermark-terminal") {
      const entry = changed.changes[0]!.entry!; entry.state = "failed"; entry.payload = null;
      Object.assign(changed.changes[0]!, { history: { recordSequence: 1, eventSequence: 1 } });
    } else changed.changes[0]!.actor!.scope[field]++;
    f.replace(changed); const d = f.driver();
    await expect(d.flush({ timeoutMs: 100 })).rejects.toMatchObject({ code: "cloud_mirror_invalid_batch" });
    expect(f.request).not.toHaveBeenCalled(); expect(f.queue.acknowledgeMirror).not.toHaveBeenCalled(); d.close();
  });
  it("fences a retired authority before and after an in-flight reply", async () => {
    const f = setup(); const d = f.driver({ request: async batch => { f.revoke(); return f.ack(batch); } });
    await expect(d.flush({ timeoutMs: 100 })).rejects.toMatchObject({ code: "cloud_mirror_scope_changed" });
    expect(f.queue.acknowledgeMirror).not.toHaveBeenCalled(); d.close();
    const before = setup(); before.revoke(); const retired = before.driver();
    await expect(retired.flush({ timeoutMs: 100 })).rejects.toMatchObject({ code: "cloud_mirror_scope_changed" });
    expect(before.request).not.toHaveBeenCalled(); retired.close();
  });
  it("times out/aborts observation without success or pruning and bounds a hung request", async () => {
    const f = setup(); let requestSignal: AbortSignal | undefined;
    const d = f.driver({ request: async (_batch, signal) => { requestSignal = signal; return new Promise(() => {}); } });
    await expect(d.flush({ timeoutMs: 60 })).rejects.toMatchObject({ code: "cloud_mirror_timeout" });
    expect(requestSignal?.aborted).toBe(true); expect(f.queue.acknowledgeMirror).not.toHaveBeenCalled(); d.close();
    const stopped = setup(), controller = new AbortController(); controller.abort(); const idle = stopped.driver();
    await expect(idle.flush({ signal: controller.signal, timeoutMs: 100 })).rejects.toMatchObject({ code: "cloud_mirror_cancelled" });
    expect(stopped.request).not.toHaveBeenCalled(); idle.close();
  });
  it("close aborts its exact request and drops a late reply", async () => {
    const f = setup(); let release!: (ack: CloudLocalCommandMirrorAck) => void, signal: AbortSignal | undefined;
    const d = f.driver({ requestTimeoutMs: 250, request: async (_batch, value) => { signal = value; return new Promise(resolve => { release = resolve; }); } });
    const flush = expect(d.flush({ timeoutMs: 500 })).rejects.toMatchObject({ code: "cloud_mirror_closed" });
    await vi.waitFor(() => expect(signal).toBeDefined(), { interval: 1 });
    d.close(); release(f.ack()); await flush;
    expect(signal!.aborted).toBe(true); expect(f.queue.acknowledgeMirror).not.toHaveBeenCalled(); d.close();
  });
  it("background notify is passive and never surfaces provider prose in failure inspection", async () => {
    const f = setup(); const d = f.driver({ request: async () => { throw new Error("fixture-private-network-prose"); } });
    expect(d.notify()).toBeUndefined(); await new Promise(resolve => setTimeout(resolve, 10));
    expect(JSON.stringify(d.inspect())).not.toContain("fixture-private"); d.close();
  });
});

describe("private mirror HTTP client", () => {
  function authority(f: ReturnType<typeof setup>) {
    const { organizationId, workspaceId, generation, engineInstanceId } = f.scope;
    return { organizationId, workspaceId, generation, engineInstanceId,
      heartbeatEndpoint: "https://control.fixture.test/internal/v1/cloud-workspaces/engine/heartbeat", heartbeatToken: `zwh_${"a".repeat(43)}` };
  }
  it("posts only exact engine scope/batch to the registered CP origin and refuses redirects", async () => {
    const f = setup(), fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ result: f.ack() }));
    expect(await requestCloudLocalCommandMirror(authority(f), f.batch, new AbortController().signal, fetcher)).toEqual(f.ack());
    const [endpoint, init] = fetcher.mock.calls[0]!;
    expect(String(endpoint)).toBe("https://control.fixture.test/internal/v2/cloud-workspaces/engine/commands/mirror");
    expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { authorization: `Bearer ${authority(f).heartbeatToken}` } });
    const { heartbeatEndpoint: _endpoint, heartbeatToken: _token, ...scope } = authority(f);
    expect(JSON.parse(String(init?.body))).toEqual({ ...scope, batch: f.batch });
  });
  it.each(["foreign-ack", "extra-result", "huge", "native-prose", "invalid-json"])("rejects %s response without leaking native prose", async kind => {
    const f = setup(); const response = kind === "foreign-ack" ? Response.json({ result: { ...f.ack(), batchId: randomUUID() } })
      : kind === "extra-result" ? Response.json({ result: f.ack(), extra: "fixture-private" })
        : kind === "huge" ? new Response("x".repeat(16_385))
          : kind === "native-prose" ? Response.json({ error: "fixture-private-prose" }, { status: 500 }) : new Response("fixture-private-prose");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    await expect(requestCloudLocalCommandMirror(authority(f), f.batch, new AbortController().signal, fetcher))
      .rejects.toMatchObject({ code: kind === "native-prose" ? "command_service_unavailable" : "command_response_invalid" });
  });
  it("retains a closed current-writer refusal and validates before any I/O", async () => {
    const f = setup(), fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: "command_context_changed" }, { status: 409 }));
    await expect(requestCloudLocalCommandMirror(authority(f), f.batch, new AbortController().signal, fetcher)).rejects.toMatchObject({ code: "command_context_changed" });
    const bad = vi.fn<typeof fetch>();
    await expect(requestCloudLocalCommandMirror({ ...authority(f), heartbeatEndpoint: "http://control.fixture.test" }, f.batch, new AbortController().signal, bad))
      .rejects.toMatchObject({ code: "engine_authority_rejected" });
    await expect(requestCloudLocalCommandMirror(authority(f), { ...f.batch, changes: [] }, new AbortController().signal, bad))
      .rejects.toMatchObject({ code: "invalid_command" });
    expect(bad).not.toHaveBeenCalled();
  });
  it.each(["organizationId", "workspaceId", "engineInstanceId"] as const)("rejects a malformed %s before HTTP", async field => {
    const f = setup(), fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ result: f.ack() }));
    await expect(requestCloudLocalCommandMirror({ ...authority(f), [field]: "-".repeat(36) }, f.batch,
      new AbortController().signal, fetcher)).rejects.toMatchObject({ code: "engine_authority_rejected" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("retires an aborted in-flight response body instead of awaiting an unbounded read", async () => {
    const f = setup(), aborted = new AbortController(), cancel = vi.fn();
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { bodyController = value; }, cancel });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    const task = requestCloudLocalCommandMirror(authority(f), f.batch, aborted.signal, fetcher)
      .then(() => "success", error => (error as { code: string }).code);
    await vi.waitFor(() => expect(body.locked).toBe(true), { interval: 1 });
    aborted.abort();
    let timer: ReturnType<typeof setTimeout>;
    const result = await Promise.race([task, new Promise<string>(resolve => { timer = setTimeout(() => resolve("unbounded_read"), 50); })]);
    clearTimeout(timer!);
    if (result === "unbounded_read") bodyController.close();
    await task;
    expect(result).toBe("command_service_unavailable");
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
});

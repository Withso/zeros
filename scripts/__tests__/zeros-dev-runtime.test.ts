import { randomUUID, createPublicKey, verify } from "node:crypto";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCloudReplicaDeviceCredential, cloudReplicaDeviceProofMessage } from "../../apps/desktop/src/engine/cloud-replica-device";
import type { RuntimeClientEnvironment } from "../../apps/desktop/src/renderer/platform/bridge/runtime-client";
import { ZerosDevRuntime } from "../zeros-dev/runtime";
import type { ProductApi } from "../zeros-dev/product";
import type { RunHandle } from "../zeros-dev/receipts";
import { AlphaTransport } from "../zeros-dev/transport";
import { parseFixture } from "../zeros-dev/config";
import type { AdmissionObservation } from "../zeros-dev/admission-observation";
import { runInfrastructure } from "../zeros-dev/infrastructure";
import { initialInfrastructure } from "../zeros-dev/infrastructure-contract";
import { Evidence } from "../zeros-dev/evidence";
import { ZerosDevError } from "../zeros-dev/errors";
import { computerBuild } from "../../apps/desktop/src/renderer/features/settings/__tests__/cloud-computer-v2-fixtures";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(options: { rejection?: { reason: string; message: string }; listResult?: unknown; onList?: (count: number) => void } = {}) {
  const values = { ZEROS_DEV_WORKOS_SUBJECT: "user_fixture", ZEROS_DEV_ACCOUNT_ID: randomUUID(), ZEROS_DEV_EMAIL: "fixture@example.test",
    ZEROS_DEV_ORGANIZATION_ID: randomUUID(), ZEROS_DEV_REPOSITORY: "test-owner/test-repo", ZEROS_DEV_REPOSITORY_ID: "1234", ZEROS_DEV_GITHUB_INSTALLATION_ID: randomUUID() };
  const configured = parseFixture(values), workspaceId = randomUUID(), streamId = randomUUID();
  const credential = { ...createCloudReplicaDeviceCredential(configured.accountId), deviceId: randomUUID() };
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture not listening");
  cleanups.push(async () => { for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const origin = `http://127.0.0.1:${address.port}`, seen: Record<string, any>[] = [], headers: Record<string, unknown>[] = [];
  const workspace = { id: workspaceId, generation: { number: 1 }, status: "ready" };
  let generation = 1, engineRoot = "/home/user/test-repo", receiptState = "succeeded", exitCode: number | null = 0, permission = false, enqueued: any;
  let conversationId = "", commandId = "", wrote = false, listRequests = 0;
  server.on("connection", (socket, request) => {
    headers.push(request.headers);
    socket.on("message", bytes => {
      const message = JSON.parse(bytes.toString()); seen.push(message);
      const send = (body: object) => socket.send(JSON.stringify({ id: randomUUID(), timestamp: Date.now(), source: "engine", ...body }));
      if (options.rejection) {
        if (message.type === "CONNECTED") send({ type: "CONNECTION_REJECTED", ...options.rejection });
        return;
      }
      if (message.type === "PTY_CREATE") {
        send({ type: "PTY_CREATED", requestId: message.id, sessionId: message.sessionId, cwd: engineRoot, pid: 123, cols: 120, rows: 30 }); return;
      }
      if (message.type === "PTY_WRITE") {
        wrote = true; send({ type: "PTY_DATA", sessionId: message.sessionId, data: "synthetic output\n" });
        send({ type: "PTY_EXIT", sessionId: message.sessionId, exitCode, signal: null }); return;
      }
      if (message.type !== "WORKSPACE_REQUEST") return;
      const params = message.params ?? {}, request = params.request;
      const queue = () => ({ version: 1, conversationId, revision: 0, paused: false, pending: [], receipts: [] });
      let result: unknown;
      if (message.op === "workspace.list") {
        listRequests++; options.onList?.(listRequests);
        result = listRequests > 1 && options.listResult !== undefined ? options.listResult : { workspaces: [{ id: "local-main", path: engineRoot }] };
      }
      else if (message.op === "cloudCommands.createConversation" || message.op === "cloudCommands.conversation") {
        conversationId = params.conversationId;
        result = { conversationId, modeRevision: 0, permissionModeVersion: 1, nativeCommandsVersion: 1 };
      } else if (message.op === "cloudCommands.request") {
        if (request.kind === "snapshot") result = queue();
        else if (request.kind === "mutate") {
          enqueued = request.mutation.action; commandId = enqueued.commandId; result = queue();
          if (permission) send({ type: "AGENT_PERMISSION_REQUEST", agentId: enqueued.payload.agentId, chatId: conversationId,
            permissionId: "fixture-permission", request: { sessionId: "execution", toolCall: { toolCallId: "fixture-tool" }, options: [] } });
        } else if (request.kind === "read") result = { commandId, conversationId, position: 1, state: receiptState,
          payload: null, executionId: "execution", generation: 1, resultCode: null, createdAt: "2026-10-12T00:00:00Z", updatedAt: "2026-10-12T00:00:00Z" };
      } else if (message.op === "cloudEvents.request") {
        result = request.kind === "replay" ? { streamId, head: 0, firstRetained: 0, cursor: 0, events: [] } : {
          cursor: { streamId, sequence: 0 }, snapshot: { conversationId, executionId: "execution", activeTurn: null, session: {}, messages: [], permissions: [], questions: [] } };
      } else if (message.op === "messages.window") result = { messages: [{ msgId: "fixture-msg", kind: "text", payload: "fixture response", createdAt: 123 }] };
      else throw new Error(`Unexpected fixture operation ${message.op}`);
      send({ type: "WORKSPACE_RESPONSE", requestId: message.id, op: message.op, result });
    });
  });
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe(`${origin}/v1/organizations/${configured.organizationId}/cloud-workspaces/${workspaceId}/runtime/admission`);
    expect(init?.redirect).toBe("error"); expect(init?.credentials).toBe("omit");
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    expect(JSON.parse(String(init?.body))).toEqual({ actorProtocolVersion: 2, directProviderVersion: 1 });
    const header = new Headers(init?.headers);
    expect(header.get("authorization")).toBe("Bearer fixture-access-token");
    const proof = { accountUserId: configured.accountId, deviceId: credential.deviceId, keyVersion: credential.keyVersion,
      action: "engine.connect", timestampMs: Number(header.get("x-zeros-device-timestamp")), nonce: header.get("x-zeros-device-nonce")!,
      payload: { organizationId: configured.organizationId, workspaceId } };
    expect(verify(null, cloudReplicaDeviceProofMessage(proof), createPublicKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: credential.publicKey } }),
      Buffer.from(header.get("x-zeros-device-signature")!, "base64url"))).toBe(true);
    return Response.json({ version: 2, audience: "zeros-cloud-workspace-engine-client-admission-v2", organizationId: configured.organizationId, workspaceId,
      generation, authorityEpoch: 1, engineInstanceId: randomUUID(), remotePort: 4242, grantToken: `zwa_${"a".repeat(43)}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), bridgeUrl: `${origin.replace("http:", "ws:")}/v1/cloud-workspaces/bridge` }, { status: 201 });
  });
  const api = { workspace: vi.fn(async () => workspace), grant: vi.fn(async () => randomUUID()), transport: new AlphaTransport(fetcher) } as unknown as ProductApi;
  const session = { fixture: async () => configured, device: async () => credential, accessToken: async () => "fixture-access-token", accountSessionKey: () => "fixture-session" };
  const handle: RunHandle = { run: { version: 1, runId: randomUUID(), fixtureSha256: "a".repeat(64), deviceId: credential.deviceId,
    createdAt: new Date().toISOString(), source: { revision: null, dirty: true }, lifecycle: [], prompts: [], evidence: [], deletionConfirmed: false }, save: vi.fn(async () => {}) };
  const environment: RuntimeClientEnvironment = { controlPlaneOrigin: origin, allowHttpLoopback: true, createWebSocket: (url, protocols) => new WebSocket(url, protocols) as never,
    resolveEnginePort: async () => { throw new Error("no local engine"); }, resolveEngineToken: async () => { throw new Error("no local token"); },
    invalidateEnginePort() {}, invalidateEngineToken() {}, getAuthAccessToken: () => { throw new Error("no account token to VM"); }, logger: { warn() {}, error() {} } };
  const connect = async (signal?: AbortSignal, onAdmissionEvent?: (event: AdmissionObservation) => void) => {
    const runtime = await ZerosDevRuntime.connect(session, api, handle.run, { environment, fetch: fetcher, signal, onAdmissionEvent });
    cleanups.push(() => runtime.dispose()); return runtime;
  };
  return { connect, handle, api, fetcher, seen, headers, workspace, setGeneration: (value: number) => { generation = value; },
    setRoot: (value: string) => { engineRoot = value; }, setReceipt: (value: string) => { receiptState = value; },
    setExit: (value: number | null) => { exitCode = value; }, requirePermission: () => { permission = true; receiptState = "dispatching"; }, enqueued: () => enqueued, wrote: () => wrote };
}

describe("zeros-dev shared admission, agent and terminal loopback", () => {
  it("can detach only device transport and retain actor authority until explicit cleanup", async () => {
    const f = await fixture(), runtime = await f.connect();
    runtime.detachTransport();
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(0);
    await expect(runtime.tail(randomUUID())).rejects.toMatchObject({ code: "receipt_missing" });
    await runtime.dispose();
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
  });
  it.each(["claude", "codex", "cursor"] as const)("uses %s's normal Auto mode only when the rehearsal explicitly requests it", async agent => {
    const f = await fixture(), runtime = await f.connect();
    const pending = await runtime.startPrompt(f.handle, { agent, model: "fixture-model", text: "Fixture edit.", permissionMode: "auto" });
    expect((await pending.completion).state).toBe("succeeded");
    expect(f.enqueued().payload.permissionMode).toBe(agent === "codex" ? "auto-edit" : "auto");
  });
  it.each([false, true])("preserves the typed first failure and each signed retry when terminal failure is %s", async terminal => {
    const f = await fixture(), events: AdmissionObservation[] = [];
    const code = "cloud_runtime_temporarily_unavailable", firstFailure = { status: 503, code, phase: "provider_endpoint", retryAfterMs: 1000 };
    f.fetcher.mockResolvedValueOnce(Response.json({ error: { code, phase: "provider_endpoint", retryable: true,
      message: "synthetic-private-admission" } }, { status: 503, headers: { "Retry-After": "1" } }));
    if (terminal) f.fetcher.mockResolvedValueOnce(Response.json({ error: { code: "internal", message: "synthetic-private-final" } }, { status: 500 }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const connected = f.connect(undefined, event => events.push(event)).then(value => ({ value }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(1000);
    const result = await connected;
    const connectionId = "value" in result ? result.value.transport().connectionId : result.error.transport.connectionId;
    const admission = { connectionId, sequence: 1, firstFailure, retryCount: 1, retries: [{ ...firstFailure, attempt: 2, delayMs: 1000 }] };
    expect(events).toEqual([{ connectionId, sequence: 1, firstFailure, retryCount: 0, retries: [] }, admission]);
    if (terminal) expect(result).toMatchObject({ error: { code: "runtime_unavailable", admission,
      runtime: { phase: "admission", class: "admission_unavailable", status: 500 } } });
    else expect(result).toMatchObject({ value: { admission } });
    const posts = f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(2);
    expect(new Set(posts.map(([, init]) => new Headers(init?.headers).get("x-zeros-device-nonce"))).size).toBe(2);
    expect(JSON.stringify(events)).not.toContain("synthetic-private");
  });

  it.each([
    [500, "internal", "admission_unavailable"],
    [503, "cloud_access_provider_unavailable", "admission_unavailable"],
    [403, "forbidden", "authority_rejected"],
    [409, "engine_client_admission_ineligible", "admission_refused"],
  ] as const)("retains admission %i as a closed cause without retrying or echoing the body", async (status, code, inner) => {
    const f = await fixture();
    f.fetcher.mockResolvedValueOnce(Response.json({ error: { code, message: "synthetic-private-admission" } }, { status }));
    const error = await f.connect().catch(error => error);
    expect(error).toMatchObject({ code: "runtime_unavailable", runtime: { phase: "admission", class: inner, status } });
    expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.seen).toHaveLength(0);
    expect(JSON.stringify(error)).not.toContain("synthetic-private");
  });

  it("classifies an invalid admission response without opening a socket", async () => {
    const f = await fixture(); f.fetcher.mockResolvedValueOnce(Response.json({ private: "synthetic-private-response" }, { status: 201 }));
    await expect(f.connect()).rejects.toMatchObject({ code: "runtime_unavailable", runtime: { phase: "admission", class: "bad_response", status: 201 } });
    expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.seen).toHaveLength(0);
  });

  it.each([["auth-wrong-account", "authority_rejected"], ["protocol-too-old", "handshake_rejected"]] as const)(
    "captures %s before disposal clears the shared client's rejection", async (reason, inner) => {
      const f = await fixture({ rejection: { reason, message: "synthetic-private-rejection" } });
      const error = await f.connect().catch(error => error);
      expect(error).toMatchObject({ code: "runtime_unavailable", runtime: { phase: "handshake", class: inner } });
      expect(JSON.stringify(error)).not.toContain("synthetic-private");
      expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
      expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
    });

  it("distinguishes malformed workspace.list from admission and keeps the first error through failed retirement", async () => {
    const f = await fixture({ listResult: { private: "synthetic-private-result" } });
    const fetcher = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation((url, init) => init?.method === "DELETE" ? Promise.reject(new Error("synthetic-private-cleanup")) : fetcher(url, init));
    await expect(f.connect()).rejects.toMatchObject({ code: "bad_response", runtime: { phase: "workspace_list", class: "bad_response" } });
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("names the expired workspace.list phase without sleeping or retrying", async () => {
    const controller = new AbortController();
    const f = await fixture({ onList: count => { if (count === 2) controller.abort(new DOMException("synthetic-private-timeout", "TimeoutError")); } });
    await expect(f.connect(controller.signal)).rejects.toMatchObject({ code: "deadline", runtime: { phase: "workspace_list", class: "request_timeout" } });
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("keeps unknown pre-admission failures explicitly unknown and value-free", async () => {
    const f = await fixture(); vi.mocked(f.api.workspace).mockRejectedValueOnce(new Error("synthetic-private-workspace"));
    const error = await f.connect().catch(error => error);
    expect(error).toMatchObject({ code: "runtime_unavailable", runtime: { phase: "workspace_read", class: "unknown" } });
    expect(JSON.stringify(error)).not.toContain("synthetic-private"); expect(f.fetcher).not.toHaveBeenCalled();
  });

  it.each(["claude", "codex", "cursor"] as const)("waits for %s's native receipt, then reads the same transcript", async agent => {
    const f = await fixture(), runtime = await f.connect(), id = randomUUID();
    const receipt = await runtime.prompt(f.handle, { id, agent, model: "fixture-model", text: "Reply with fixture output." });
    expect(receipt.state).toBe("succeeded"); expect(f.enqueued().payload.agentId).toBe(agent);
    expect(f.enqueued().payload.permissionMode).toBe(agent === "claude" ? "default" : agent === "codex" ? "ask" : "plan");
    expect(await runtime.tail(id)).toHaveLength(1);
    const count = f.seen.length; await runtime.prompt(f.handle, { id, agent, model: "fixture-model", text: "Reply with fixture output." });
    expect(f.seen).toHaveLength(count);
    await expect(runtime.prompt(f.handle, { id, agent, model: "fixture-model", text: "A different prompt." })).rejects.toThrow("zeros_dev_operation_conflict");
    expect(JSON.stringify(f.seen)).not.toContain("fixture-access-token"); expect(JSON.stringify(f.headers)).not.toContain("fixture-access-token");
    expect(f.seen[0]).toMatchObject({ type: "CONNECTED", source: "browser" });
    await runtime.dispose(); expect(f.fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true);
  });

  it.each(["stopped", "setting_up", "starting", "archived"])("does not acquire admission or wake for %s", async status => {
    const f = await fixture(); f.workspace.status = status;
    await expect(f.connect()).rejects.toThrow("zeros_dev_workspace_not_running"); expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("retires a wrong-generation admission without opening an engine socket", async () => {
    const f = await fixture(); f.setGeneration(2);
    await expect(f.connect()).rejects.toThrow("zeros_dev_runtime_changed"); expect(f.seen).toHaveLength(0);
    expect(f.fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true);
  });

  it("refuses an unconfirmed engine root", async () => {
    const f = await fixture(); f.setRoot("/home/user/../foreign");
    await expect(f.connect()).rejects.toThrow("zeros_dev_runtime_changed");
  });

  it("does not silently approve a provider permission request", async () => {
    const f = await fixture(), runtime = await f.connect(); f.requirePermission();
    await expect(runtime.prompt(f.handle, { agent: "codex", model: "fixture-model", text: "Fixture tool request." })).rejects.toThrow("zeros_dev_permission_required");
    expect(f.handle.run.prompts[0]?.state).toBe("uncertain");
    expect(f.seen.some(row => row.type === "AGENT_PERMISSION_RESPONSE")).toBe(false);
  });

  it("continues only this run's settled conversation after reconnecting",async()=>{
    const f=await fixture(),first=await f.connect();
    const original=await first.prompt(f.handle,{agent:"codex",model:"fixture-model",text:"Remember fixture state."});
    await first.dispose();const resumed=await f.connect();
    const next=await resumed.prompt(f.handle,{agent:"codex",model:"fixture-model",text:"Recall fixture state.",continueFrom:original.id});
    expect(next.conversationId).toBe(original.conversationId);
    expect(next.id).not.toBe(original.id);
    await expect(resumed.prompt(f.handle,{agent:"codex",model:"fixture-model",text:"Foreign.",continueFrom:randomUUID()})).rejects.toThrow("zeros_dev_receipt_missing");
  });

  it("uses real PTY messages, records the observed exit and refuses repeat script identities", async () => {
    const f = await fixture(), runtime = await f.connect(), id = randomUUID();
    expect(await runtime.terminal(f.handle, { id, script: "printf fixture" })).toEqual({ exitCode: 0, output: "synthetic output\n", truncated: false });
    expect(f.wrote()).toBe(true); expect(f.handle.run.terminals?.[0]).toMatchObject({ id, state: "succeeded", exitCode: 0 });
    expect(f.seen.find(row => row.type === "PTY_CREATE")).toMatchObject({ cwd: "/home/user/test-repo", ephemeral: true });
    await expect(runtime.terminal(f.handle, { id, script: "printf fixture" })).rejects.toThrow("zeros_dev_operation_conflict");
  });

  it("does not turn a killed PTY into successful execution", async () => {
    const f = await fixture(), runtime = await f.connect(); f.setExit(null);
    await expect(runtime.terminal(f.handle, { script: "printf fixture" })).rejects.toThrow("zeros_dev_command_uncertain");
    expect(f.handle.run.terminals?.[0]?.state).toBe("uncertain");
  });
});

it("keeps the admitted runtime alive when its completed connect-phase deadline expires during file work", async () => {
  const f = await fixture();
  const timeouts: Array<{ ms: number; controller: AbortController }> = [];
  const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controller = new AbortController(); timeouts.push({ ms, controller }); return controller.signal;
  });
  f.handle.run.hourly = { version: 1, workflowRunId: "17", attempt: 1, sourceSha: "b".repeat(40),
    credentials: [], histories: [], activeWindows: [], complete: false, infrastructure: initialInfrastructure() };
  const active = computerBuild(), target = { runtimeId: `r1-${"c".repeat(64)}`, baseImageId: "fixture-base" };
  let terminalSucceeded = false;
  const api = {
    assertFixtureEmpty: async () => {}, ensureRepository: async () => {},
    computerState: async () => ({ active }), readComputerRuntime: async () => ({ ...target, selected: target }),
    verifyComputerRuntime: async () => "confirmed", buildComputer: async () => {}, waitComputer: async () => active,
    createWorkspace: async () => {
      f.handle.run.create = { key: randomUUID(), body: { name: `zd-${f.handle.run.runId}`,
        repository: { forge: "github.com", owner: "test-owner", name: "test-repo", revision: "main", githubInstallationId: randomUUID() } },
        result: { id: f.workspace.id, createdBy: randomUUID(), createdAt: new Date().toISOString(), generation: 1 } };
    },
    waitWorkspace: async (_h: unknown, _state: unknown, _signal: unknown, observe?: (value: unknown) => void) => {
      observe?.({ attempt: 1, claimCount: 1, state: "succeeded", errorCode: null });
    },
    // End this review probe immediately after the first successful file check.
    lifecycle: async () => { throw new ZerosDevError("command_uncertain"); },
    cleanup: async () => { f.handle.run.deletionConfirmed = true; return { planned: 1, confirmed: 1 }; },
  };
  try {
    const result = await runInfrastructure({ handle: f.handle, api,
      evidence: new Evidence(f.handle.run.runId, () => {}),
      connect: async (_run: unknown, signal: AbortSignal) => {
        const connectPhase = timeouts.filter(row => row.ms === 30_000).at(-1)!;
        const runtime = await f.connect(signal);
        const terminal = runtime.terminal.bind(runtime);
        vi.spyOn(runtime, "terminal").mockImplementationOnce(async (handle, input, fileSignal) => {
          // The 30s connection has completed. Its deadline now expires while
          // the separate 60s file phase and overall run are still valid.
          expect(fileSignal!.aborted).toBe(false);
          connectPhase.controller.abort();
          expect(fileSignal!.aborted).toBe(false);
          const reply = await terminal(handle, input, fileSignal);
          terminalSucceeded = reply.exitCode === 0;
          return reply;
        });
        return runtime;
      },
      prepareDetachedAuth: async () => { throw new Error("must not reach native work"); },
      native: () => { throw new Error("must not reach native work"); },
    } as never).then(() => null, error => error);
    expect(result).toMatchObject({ code: "command_uncertain" });
    expect(terminalSucceeded).toBe(true);
  } finally { timeoutSpy.mockRestore(); }
});

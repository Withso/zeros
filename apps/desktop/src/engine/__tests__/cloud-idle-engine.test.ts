import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../cloud-idle-stop", async importOriginal => ({ ...await importOriginal<object>(), hasCloudUserProcesses: vi.fn(async () => false) }));
vi.mock("../pty/node-pty-spawn", () => ({ createNodePtyShell: vi.fn(), createTerminalMirror: vi.fn(), disposePtyHost: vi.fn() }));
import { hasCloudUserProcesses } from "../cloud-idle-stop";
import { ZerosEngine } from "../zeros-engine";
import { CloudOwnedWorkloadRegistry } from "../agents/containment/cloud-owned-workloads";
import type { CloudCheckpointDirective } from "../cloud-runtime-registration";
import type { CloudDurabilityAuthority } from "../cloud-durability-runtime";
import { CloudAgentConnection } from "../../renderer/platform/bridge/cloud-agent-connection";
import type { RuntimeClient } from "../../renderer/platform/bridge/ws-client";
import type { WireRecord } from "../../renderer/platform/bridge/cloud-runtime-wire";
const directive: CloudCheckpointDirective = { id: "idle-checkpoint", reason: "before_stop", deadlineAtMs: Date.now() + 60_000, idleStop: true };
const authority = {} as CloudDurabilityAuthority;
function fixture() {
  const state = {
    cloudWorker: {}, cloudWorkloads: new CloudOwnedWorkloadRegistry(), activePromptContexts: new Map(), promptSessions: new Set(), retiringCloudExecutions: new Set(),
    pendingPermissionRequests: new Map(), pendingQuestionRequests: new Map(), cloudWorkspaceIdleMaintenance: new Set(),
    running: true, cloudRuntimeCheckpointQuiescing: true, cloudRuntimeAuthorityStopping: false,
    cloudIdleReservation: (() => true) as (() => boolean) | null, cloudIdleCheckpoint: null,
    cloudRuntimeRegistration: { idleStopRequest: vi.fn(async () => directive) },
    cloudUserPresence: { active: () => false },
    cloudCommands: { hasActiveWork: () => false, pauseClaims: vi.fn(), resumeClaims: vi.fn() }, cloudGoals: { active: () => false },
    activePrompts: new Set(), sessionLoadResponses: new Map(), sessionAgent: new Map(), pty: { list: () => [], hasRecentInput: () => false },
    cloudDurabilityRuntime: { checkpoint: vi.fn(async () => undefined) }, cloudRecordRuntime: { synchronize: vi.fn(async () => undefined), flush: vi.fn(async () => undefined) },
    cloudHumanServices: { pause: vi.fn(async () => undefined), resume: vi.fn(), hasActiveWork: () => false },
    cloudLanguageServices: { pause: vi.fn(async () => undefined), resume: vi.fn(), idleProcessRoots: () => [] },
    cloud: { setHumanServicesPaused: vi.fn() }, cloudCheckpointScheduler: { pause: vi.fn(async () => undefined), resume: vi.fn() },
    globalDesignAuthorityStarts: new Set(), cloudWorkspaceMutations: new Set(), workspaceProcessStarts: new Map(),
    waitForWorkspaceProcessStartSnapshot: vi.fn(async () => undefined), setup: { stopAllAndProve: vi.fn(async () => undefined), hasRepositoryCodeAuthority: () => false },
    runs: { stopAllAndProve: vi.fn(async () => undefined), hasRepositoryCodeAuthority: () => false }, retireAllCodeAgentSessionsForTerritoryChange: vi.fn(async () => undefined), terminals: { clear: vi.fn(), visibleTo: () => [] },
  };
  Object.setPrototypeOf(state, ZerosEngine.prototype);
  return state as typeof state & {
    handleCloudCheckpointRequest(directive: CloudCheckpointDirective, authority: CloudDurabilityAuthority): Promise<void>;
    stopIdleCloudWorkspace(authority: CloudDurabilityAuthority, stillIdle: () => boolean): Promise<void>;
    cloudIdleBusy(includePresence?: boolean): boolean;
  };
}
beforeEach(() => { vi.mocked(hasCloudUserProcesses).mockReset().mockResolvedValue(false); });
describe("idle checkpoint execution", () => {
  it("keeps idle terminal registrations usable when presence cancels a capture", async () => {
    const state = fixture();
    state.cloudDurabilityRuntime.checkpoint.mockRejectedValue(new Error("Cloud workspace is no longer idle"));
    await expect(state.handleCloudCheckpointRequest(directive, authority)).rejects.toThrow("no longer idle");
    expect(state.terminals.clear).not.toHaveBeenCalled();
    expect(state.cloudRuntimeCheckpointQuiescing).toBe(false);
  });
  it("retries the same paused submission until a held checkpoint observes server cancellation", async () => {
    const state = fixture(), conversationId = "11111111-1111-4111-8111-111111111111";
    let release!: () => void, serverCancelled = false, paused = true, revision = 7, executions = 0;
    const held = new Promise<void>(resolve => { release = resolve; });
    state.cloudDurabilityRuntime.checkpoint.mockImplementation(async () => {
      await held;
      if (serverCancelled) throw new Error("checkpoint cancelled");
    });
    const capture = state.handleCloudCheckpointRequest(directive, authority);
    const cancelled = expect(capture).rejects.toThrow("checkpoint cancelled");
    await vi.waitFor(() => expect(state.cloudDurabilityRuntime.checkpoint).toHaveBeenCalledOnce());
    serverCancelled = true;
    expect(state.cloudRuntimeCheckpointQuiescing).toBe(true);
    const queue = () => ({ version: 1, conversationId, revision, paused, pending: [], receipts: [] });
    type Client = { send: (message: WireRecord) => void };
    const gate = (ZerosEngine.prototype as unknown as {
      handleWorkspaceMessage(this: unknown, message: WireRecord, client: Client): Promise<void>;
    }).handleWorkspaceMessage;
    const writes: WireRecord[] = [], responses: WireRecord[] = [];
    const engine = Object.assign(state, {
      handleWorkspaceMessage: async (message: WireRecord, client: Client, admitted = false) => {
        if (!admitted) return gate.call(state, message, client);
        const mutation = ((message.params as WireRecord).request as WireRecord).mutation as WireRecord;
        if ((mutation.action as WireRecord).kind === "resume") { paused = false; revision++; }
        else executions++;
        client.send({ type: "WORKSPACE_RESPONSE", result: queue() });
      },
    });
    const request = vi.fn(async (message: WireRecord): Promise<WireRecord> => {
      const input = (message.params as WireRecord).request as WireRecord | undefined;
      if (message.op === "cloudEvents.request") {
        expect(input).toEqual({ kind: "snapshot", conversationId });
        return { type: "WORKSPACE_RESPONSE", result: {
          cursor: { streamId: "33333333-3333-4333-8333-333333333333", sequence: 0 },
          snapshot: { conversationId, executionId: "execution", activeTurn: null, messages: [] },
        } };
      }
      if (input?.kind === "mutate") {
        writes.push(input.mutation as WireRecord);
        let response!: WireRecord;
        await engine.handleWorkspaceMessage(message, { send: value => { response = value; } });
        responses.push(response);
        return response;
      }
      const result = input?.kind === "snapshot" ? queue() : input?.kind === "read" ? {
        conversationId, commandId: input.commandId, position: 1, state: "succeeded", payload: null,
        executionId: "execution", generation: 1, resultCode: null,
        createdAt: "2026-09-26T00:00:00Z", updatedAt: "2026-09-26T00:00:00Z",
      } : { conversationId, modeRevision: 0 };
      return { type: "WORKSPACE_RESPONSE", result };
    });
    const connection = new CloudAgentConnection({ request, status: "connected" } as unknown as RuntimeClient,
      "local-main", async () => "22222222-2222-4222-8222-222222222222");
    connection.restoreAttachments([{ id: conversationId, agentId: "codex", model: "test-model", fast: false, modeRevision: 0 }]);
    vi.useFakeTimers();
    try {
      const message = { type: "AGENT_PROMPT", sessionId: `conversation:${conversationId}`, userMessageId: "held-capture", prompt: [] };
      let settled = false;
      const sending = connection.request(message).finally(() => { settled = true; });
      void sending.catch(() => {});
      const duplicate = connection.request(message);
      void duplicate.catch(() => {});
      await vi.waitFor(() => expect(writes.length).toBeGreaterThan(0));
      await vi.advanceTimersByTimeAsync(250);
      expect(responses[0]).toMatchObject({ type: "WORKSPACE_ERROR", code: "CLOUD_WORKSPACE_CHECKPOINTING" });
      expect(settled).toBe(false);
      expect(executions).toBe(0);
      release(); await cancelled;
      expect(state.cloudRuntimeCheckpointQuiescing).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(sending).resolves.toMatchObject({ type: "AGENT_PROMPT_COMPLETE" });
      await duplicate;
      const resumes = writes.filter(write => (write.action as WireRecord).kind === "resume");
      expect(resumes.length).toBeGreaterThan(1);
      expect(resumes.every(write => write.operationId === resumes[0].operationId && write.expectedRevision === 7)).toBe(true);
      expect(executions).toBe(1);
    } finally { release(); await cancelled; connection.dispose(); vi.useRealTimers(); }
  });
  it("keeps idle-stop presence while allowing the update snapshot to read it separately", () => {
    const state = fixture();
    state.cloudUserPresence.active = () => true;
    expect(state.cloudIdleBusy()).toBe(true);
    expect(state.cloudIdleBusy(false)).toBe(false);
    state.activePromptContexts.set("turn", {});
    expect(state.cloudIdleBusy(false)).toBe(true);
  });
  it("does not keep an idle VM awake for background PR metadata reconciliation", () => {
    const state = fixture(), maintenance = Promise.resolve(), write = Promise.resolve();
    state.cloudWorkspaceMutations.add(maintenance);
    state.cloudWorkspaceIdleMaintenance.add(maintenance);
    expect(state.cloudIdleBusy()).toBe(false);
    state.cloudWorkspaceMutations.add(write);
    expect(state.cloudIdleBusy()).toBe(true);
    state.cloudWorkspaceMutations.delete(write);
    expect(state.cloudIdleBusy()).toBe(false);
    // Maintenance still participates in the final checkpoint's existing drain.
    expect(state.cloudWorkspaceMutations.has(maintenance)).toBe(true);
  });
  it("deduplicates a heartbeat delivery racing the request response", async () => {
    const state = fixture();
    await Promise.all([state.handleCloudCheckpointRequest(directive, authority), state.handleCloudCheckpointRequest(directive, authority)]);
    await state.handleCloudCheckpointRequest(directive, authority);
    expect(state.cloudDurabilityRuntime.checkpoint).toHaveBeenCalledTimes(1);
    expect(state.cloudRuntimeCheckpointQuiescing).toBe(true);
    expect(state.cloudIdleReservation).toBeNull();
  });
  it("awaits a fresh record flush before permitting the final filesystem checkpoint", async () => {
    const state = fixture();
    let releaseFlush!: () => void, notifyFlush!: () => void;
    const heldFlush = new Promise<void>((resolve) => { releaseFlush = resolve; });
    const enteredFlush = new Promise<void>((resolve) => { notifyFlush = resolve; });
    state.cloudRecordRuntime.flush.mockImplementation(async () => {
      notifyFlush(); await heldFlush;
    });
    const capture = state.handleCloudCheckpointRequest(directive, authority);
    await enteredFlush;
    expect(state.retireAllCodeAgentSessionsForTerritoryChange).toHaveBeenCalledOnce();
    expect(state.cloudRecordRuntime.synchronize).not.toHaveBeenCalled();
    expect(state.cloudDurabilityRuntime.checkpoint).not.toHaveBeenCalled();
    releaseFlush(); await capture;
    expect(state.cloudRecordRuntime.flush).toHaveBeenCalledWith(authority);
    expect(state.cloudDurabilityRuntime.checkpoint).toHaveBeenCalledOnce();
  });
  it("cancels instead of killing newly observed background work", async () => {
    const state = fixture(); vi.mocked(hasCloudUserProcesses).mockResolvedValue(true);
    await expect(state.handleCloudCheckpointRequest(directive, authority)).rejects.toThrow("no longer idle");
    expect(state.cloudRuntimeRegistration.idleStopRequest).toHaveBeenCalledWith({ kind: "cancel", requestId: directive.id });
    expect(state.setup.stopAllAndProve).not.toHaveBeenCalled(); expect(state.terminals.clear).not.toHaveBeenCalled();
  });
  it("restores admission when a final checkpoint fails", async () => {
    const state = fixture(); state.cloudDurabilityRuntime.checkpoint.mockRejectedValue(new Error("checkpoint rejected"));
    await expect(state.handleCloudCheckpointRequest(directive, authority)).rejects.toThrow("checkpoint rejected");
    expect(state.cloudRuntimeRegistration.idleStopRequest).toHaveBeenCalledWith({ kind: "cancel", requestId: directive.id });
    expect(state.cloudRuntimeCheckpointQuiescing).toBe(false); expect(state.cloudHumanServices.resume).toHaveBeenCalled();
  });
  it("retains quiescence when a lost commit acknowledgement cannot be cancelled", async () => {
    const state = fixture();
    state.cloudDurabilityRuntime.checkpoint.mockRejectedValue(new Error("lost acknowledgement"));
    state.cloudRuntimeRegistration.idleStopRequest.mockRejectedValue(new Error("checkpoint already committed"));
    await expect(state.handleCloudCheckpointRequest(directive, authority)).rejects.toThrow("lost acknowledgement");
    expect(state.cloudRuntimeCheckpointQuiescing).toBe(true);
    expect(state.cloudHumanServices.resume).not.toHaveBeenCalled();
  });
  it("retains an explicit stop fence when its commit response and cancellation acknowledgement are lost", async () => {
    const state = fixture(); state.cloudRuntimeCheckpointQuiescing = false; state.cloudIdleReservation = null;
    state.cloudDurabilityRuntime.checkpoint.mockRejectedValue(new Error("lost acknowledgement"));
    state.cloudRuntimeRegistration.idleStopRequest.mockRejectedValue(new Error("already committed"));
    await expect(state.handleCloudCheckpointRequest({ id: "explicit-stop", reason: "before_stop", deadlineAtMs: Date.now() + 60_000 }, authority)).rejects.toThrow("lost acknowledgement");
    expect(state.cloudRuntimeCheckpointQuiescing).toBe(true);
    expect(state.cloudHumanServices.resume).not.toHaveBeenCalled();
  });
  it.each([true, false])("reconciles a lost cancellation acknowledgement on redelivery (idle: %s)", async idleStop => {
    const state = fixture();
    if (!idleStop) { state.cloudRuntimeCheckpointQuiescing = false; state.cloudIdleReservation = null; }
    const capture = { ...directive, idleStop: idleStop ? true as const : undefined };
    state.cloudDurabilityRuntime.checkpoint.mockRejectedValue(new Error("temporary network outage"));
    state.cloudRuntimeRegistration.idleStopRequest.mockRejectedValueOnce(new Error("temporary network outage")).mockResolvedValue(directive);
    await expect(state.handleCloudCheckpointRequest(capture, authority)).rejects.toThrow("network outage");
    expect(state.cloudRuntimeCheckpointQuiescing).toBe(true);
    await state.handleCloudCheckpointRequest(capture, authority).catch(() => undefined);
    expect(state.cloudRuntimeRegistration.idleStopRequest).toHaveBeenCalledTimes(2);
    expect(state.cloudRuntimeCheckpointQuiescing).toBe(false);
    expect(state.cloudHumanServices.resume).toHaveBeenCalledTimes(1);
    expect(state.cloudLanguageServices.resume).toHaveBeenCalledTimes(1);
    expect(state.cloudCheckpointScheduler.resume).toHaveBeenCalledTimes(1);
    expect(state.cloudDurabilityRuntime.checkpoint).toHaveBeenCalledTimes(1);
  });
  it.each([true, false])("retains an unresolved final fence across redelivery if commit won (idle: %s)", async idleStop => {
    const state = fixture();
    if (!idleStop) { state.cloudRuntimeCheckpointQuiescing = false; state.cloudIdleReservation = null; }
    const capture = { ...directive, idleStop: idleStop ? true as const : undefined };
    state.cloudDurabilityRuntime.checkpoint.mockRejectedValue(new Error("lost commit response"));
    state.cloudRuntimeRegistration.idleStopRequest.mockRejectedValueOnce(new Error("network outage")).mockRejectedValue(new Error("already committed"));
    await state.handleCloudCheckpointRequest(capture, authority).catch(() => undefined);
    await state.handleCloudCheckpointRequest(capture, authority).catch(() => undefined);
    expect(state.cloudRuntimeRegistration.idleStopRequest).toHaveBeenCalledTimes(2);
    expect(state.cloudRuntimeCheckpointQuiescing).toBe(true);
    expect(state.cloudHumanServices.resume).not.toHaveBeenCalled();
    expect(state.cloudDurabilityRuntime.checkpoint).toHaveBeenCalledTimes(1);
  });
  it.each([true, false])("reconciles a lost cancel reply even without checkpoint redelivery (idle: %s)", async idleStop => {
    vi.useFakeTimers();
    try {
      const state = fixture();
      if (!idleStop) { state.cloudRuntimeCheckpointQuiescing = false; state.cloudIdleReservation = null; }
      const capture = { ...directive, idleStop: idleStop ? true as const : undefined };
      state.cloudDurabilityRuntime.checkpoint.mockRejectedValue(new Error("network outage"));
      state.cloudRuntimeRegistration.idleStopRequest.mockRejectedValueOnce(new Error("cancel reply lost")).mockResolvedValue(directive);
      await state.handleCloudCheckpointRequest(capture, authority).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(state.cloudRuntimeRegistration.idleStopRequest).toHaveBeenCalledTimes(2);
      expect(state.cloudRuntimeCheckpointQuiescing).toBe(false);
      expect(state.cloudHumanServices.resume).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(state.cloudRuntimeRegistration.idleStopRequest).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it("keeps committed checkpoints quiesced during bounded retries and stops retrying after shutdown", async () => {
    vi.useFakeTimers();
    try {
      const state = fixture();
      state.cloudDurabilityRuntime.checkpoint.mockRejectedValue(new Error("commit response lost"));
      state.cloudRuntimeRegistration.idleStopRequest.mockRejectedValue(new Error("already committed"));
      await state.handleCloudCheckpointRequest(directive, authority).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(state.cloudRuntimeRegistration.idleStopRequest).toHaveBeenCalledTimes(3);
      expect(state.cloudRuntimeCheckpointQuiescing).toBe(true);
      expect(state.cloudHumanServices.resume).not.toHaveBeenCalled();
      state.running = false;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(state.cloudRuntimeRegistration.idleStopRequest).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });
  it("never releases an unresolved fence for a different checkpoint", async () => {
    const state = fixture();
    state.cloudDurabilityRuntime.checkpoint.mockRejectedValue(new Error("network outage"));
    state.cloudRuntimeRegistration.idleStopRequest.mockRejectedValueOnce(new Error("network outage")).mockResolvedValue(directive);
    await state.handleCloudCheckpointRequest(directive, authority).catch(() => undefined);
    await state.handleCloudCheckpointRequest({ ...directive, id: "other-checkpoint" }, authority).catch(() => undefined);
    expect(state.cloudRuntimeCheckpointQuiescing).toBe(true);
    expect(state.cloudHumanServices.resume).not.toHaveBeenCalled();
  });
  it("withdraws the reservation if activity arrives while language services are pausing", async () => {
    const state = fixture(); state.cloudRuntimeCheckpointQuiescing = false; state.cloudIdleReservation = null;
    let idle = true;
    state.cloudLanguageServices.pause.mockImplementation(async () => { idle = false; });
    await state.stopIdleCloudWorkspace(authority, () => idle);
    expect(state.cloudRuntimeRegistration.idleStopRequest).not.toHaveBeenCalled();
    expect(state.cloudRuntimeCheckpointQuiescing).toBe(false); expect(state.cloudLanguageServices.resume).toHaveBeenCalled();
  });
});

describe("original outer idle ticket through checkpoint cancellation", () => {
  function outer() {
    const state = fixture();
    state.cloudRuntimeCheckpointQuiescing = false;
    state.cloudIdleReservation = null;
    state.cloudDurabilityRuntime.checkpoint.mockRejectedValue(new Error("checkpoint cancelled"));
    return state;
  }
  it("reopens original workload admission after an acknowledged idle-capture cancellation", async () => {
    const state = outer();
    await expect(state.stopIdleCloudWorkspace(authority, () => true)).rejects.toThrow("checkpoint cancelled");
    expect(state.cloudRuntimeRegistration.idleStopRequest).toHaveBeenCalledWith({kind:"cancel",requestId:directive.id});
    expect(state.cloudRuntimeCheckpointQuiescing).toBe(false);
    expect(state.cloudWorkloads.snapshot().scopes).toEqual([]);
    expect(() => state.cloudWorkloads.assertAccepting()).not.toThrow();
  });
  it("reopens after reconciliation acknowledges a previously lost cancellation reply", async () => {
    const state = outer();
    state.cloudRuntimeRegistration.idleStopRequest.mockResolvedValueOnce(directive).mockRejectedValueOnce(new Error("lost cancel reply")).mockResolvedValue(directive);
    await expect(state.stopIdleCloudWorkspace(authority, () => true)).rejects.toThrow("checkpoint cancelled");
    expect(() => state.cloudWorkloads.assertAccepting()).toThrow();
    await expect(state.handleCloudCheckpointRequest(directive, authority)).rejects.toThrow("final checkpoint cancelled");
    expect(state.cloudRuntimeCheckpointQuiescing).toBe(false);
    expect(() => state.cloudWorkloads.assertAccepting()).not.toThrow();
  });
  it("keeps an unresolved checkpoint fenced when cancellation is not acknowledged", async () => {
    const state = outer();
    state.cloudRuntimeRegistration.idleStopRequest.mockResolvedValueOnce(directive).mockRejectedValue(new Error("already committed"));
    await expect(state.stopIdleCloudWorkspace(authority, () => true)).rejects.toThrow("checkpoint cancelled");
    expect(state.cloudRuntimeCheckpointQuiescing).toBe(true);
    expect(() => state.cloudWorkloads.assertAccepting()).toThrow();
  });
  it("does not release an independent seal ticket on idle cancellation", async () => {
    const state = outer(), seal = state.cloudWorkloads.fence();
    await state.cloudWorkloads.drain(seal);
    await expect(state.stopIdleCloudWorkspace(authority, () => true)).rejects.toThrow("checkpoint cancelled");
    expect(() => state.cloudWorkloads.assertAccepting()).toThrow();
  });
});

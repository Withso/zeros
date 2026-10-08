import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { TurnEvidence, selectProviders, safeTrace, runWithDeadline, diagnoseHarnessFailure } from "../cloud-workspace-validation/cloud-agent-e2e/assertions";
import { z } from "zod";
import { authenticateEngine, driveTurn, enqueueRequest, readCommand, cancelAfterToolStart } from "../cloud-workspace-validation/cloud-agent-e2e/driver";
import { freshNativeArtifacts, fixtureFileMatches } from "../cloud-workspace-validation/cloud-agent-e2e/artifacts";
import { selectEngineWorkspace, commandRequest, keepActorAlive } from "../cloud-workspace-validation/cloud-agent-e2e/driver";
import { CLOUD_REPLAY_EVENT_TYPES } from "@zeros/protocol/cloud-events";

const owner = { provider: "claude" as const, conversationId: "fixture-chat", commandId: randomUUID() };
const fixtureStreamId = randomUUID();
const delta = (text = "hello") => ({ type: "AGENT_SESSION_UPDATE", agentId: owner.provider,
  chatId: owner.conversationId, executionId: "fixture-execution", notification: { sessionId: "native-session",
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } }, cloudStream: { streamId: fixtureStreamId, sequence: 1 } });
const terminal = () => ({ type: "AGENT_PROMPT_COMPLETE", agentId: owner.provider, requestId: owner.commandId,
  sessionId: "native-session", executionId: "fixture-execution", stopReason: "end_turn", response: { stopReason: "end_turn" }, cloudStream: { streamId: fixtureStreamId, sequence: 2 } });
const receipt = (state = "succeeded", resultCode: string | null = null) => ({ commandId: owner.commandId,
  executionId: "fixture-execution", state, resultCode });

describe("source-mode cloud agent evidence", () => {
  it.each(["fixture_terminal_missing", "fixture_terminal_conflict", "fixture_receipt_not_terminal", "fixture_settlement_conflict"])
    ("retains closed fixture verification failure %s without raw error text", code => {
      expect(diagnoseHarnessFailure(new Error(code))).toEqual({ code });
      expect(diagnoseHarnessFailure(new Error(`${code}: private provider text`))).toEqual({ code });
    });
  const streamId = randomUUID();
  const sequenced = (frame: Record<string, unknown>, sequence: number) => ({ ...frame, cloudStream: { streamId, sequence } });
  const current = () => [sequenced(delta("new-a"), 10), sequenced(delta("new-b"), 11), sequenced(terminal(), 12)];
  it.each([
    ["prior turn with reused execution", () => [sequenced(delta("old-turn"), 2), sequenced(terminal(), 12)]],
    ["same-length changed current chunks", () => [sequenced(delta("bad-a"), 10), sequenced(delta("bad-b"), 11), sequenced(terminal(), 12)]],
    ["missing current chunk", () => [sequenced(delta("new-a"), 10), sequenced(terminal(), 12)]],
  ])("refuses replay of %s despite a matching success terminal/receipt", (_name, replay) => {
    const evidence = new TurnEvidence(owner);
    for (const frame of current()) evidence.observe(frame, "live");
    for (const frame of replay()) evidence.observe(frame, "replay");
    expect(() => evidence.finish(receipt(), "success")).toThrow("replay_content_mismatch");
    expect(JSON.stringify(evidence)).not.toMatch(/new-a|new-b|old-turn|bad-a|bad-b/);
  });
  it("accepts exact current sequenced chunks and terminal in authenticated replay", () => {
    const evidence = new TurnEvidence(owner);
    for (const frame of current()) evidence.observe(frame, "live");
    for (const frame of current()) evidence.observe(frame, "replay");
    expect(evidence.finish(receipt(), "success")).toMatchObject({ outcome: "passed", liveDeltaBytes: 10, replayDeltaBytes: 10 });
    expect(JSON.stringify(evidence)).not.toMatch(/new-a|new-b/);
  });
  it("retains closed current replay mismatch sequences and terminal presence without provider text", () => {
    const evidence = new TurnEvidence(owner);
    for (const frame of current()) evidence.observe(frame, "live");
    for (const frame of [sequenced(delta("bad-a"), 10), sequenced(terminal(), 12)]) evidence.observe(frame, "replay");
    let failure: unknown;
    try { evidence.finish(receipt(), "success"); } catch (error) { failure = error; }
    expect(diagnoseHarnessFailure(failure)).toMatchObject({ code: "replay_content_mismatch", replay: {
      liveSequences: [10, 11, 12], replaySequences: [10, 12], changedSequences: [10],
      liveTerminal: true, replayTerminal: true, invalidStream: false,
    } });
    expect(JSON.stringify(diagnoseHarnessFailure(failure))).not.toMatch(/new-a|new-b|bad-a/);
  });
  it("ignores the real owned unjournaled native exit while requiring exact current transcript replay", () => {
    const evidence = new TurnEvidence(owner);
    for (const frame of current()) evidence.observe(frame, "live");
    const exited = { type: "AGENT_AGENT_EXITED", source: "engine", agentId: owner.provider, executionId: "fixture-execution",
      sessionId: "fixture-execution", chatId: owner.conversationId, code: 1, signal: null };
    expect(CLOUD_REPLAY_EVENT_TYPES.has(exited.type)).toBe(false);
    expect(exited).not.toHaveProperty("cloudStream");
    evidence.observe(exited, "live");
    for (const frame of current()) evidence.observe(frame, "replay");
    expect(evidence.finish(receipt(), "success")).toMatchObject({ outcome: "passed", liveDeltaBytes: 10, replayDeltaBytes: 10 });
    const isolated = new TurnEvidence(owner);
    isolated.observe(exited, "live");
    expect(() => isolated.finish(receipt(), "success")).toThrow("missing_terminal");
  });
  it("still refuses a journaled text frame lacking its stream annotation", () => {
    const evidence = new TurnEvidence(owner);
    for (const frame of current()) evidence.observe(frame, "live");
    const { cloudStream: _annotation, ...unannotated } = delta("private text");
    evidence.observe(unannotated, "live");
    for (const frame of current()) evidence.observe(frame, "replay");
    expect(() => evidence.finish(receipt(), "success")).toThrow("replay_content_mismatch");
  });
  it("rejects a foreign stream or changed terminal sequence in otherwise exact replay", () => {
    for (const replay of [current().map(frame => ({ ...frame, cloudStream: { ...frame.cloudStream, streamId: randomUUID() } })),
      [sequenced(delta("new-a"), 10), sequenced(delta("new-b"), 11), sequenced(terminal(), 13)]]) {
      const evidence = new TurnEvidence(owner);
      for (const frame of current()) evidence.observe(frame, "live");
      for (const frame of replay) evidence.observe(frame, "replay");
      expect(() => evidence.finish(receipt(), "success")).toThrow();
    }
  });
  it("ignores a pre-enqueue prefix even when the execution identity is reused", () => {
    const evidence = new TurnEvidence(owner); evidence.begin({ streamId, sequence: 9 });
    evidence.observe(sequenced(delta("old-turn"), 2), "live"); evidence.observe(sequenced(delta("old-turn"), 2), "replay");
    for (const frame of current()) evidence.observe(frame, "live");
    for (const frame of current()) evidence.observe(frame, "replay");
    expect(evidence.finish(receipt(), "success")).toMatchObject({ liveDeltaBytes: 10, replayDeltaBytes: 10 });
  });
  it("retains closed wire issue fields and typed bridge codes without error values", () => {
    const parsed = z.object({ state: z.enum(["failed", "succeeded"]) }).strict().safeParse({ state: "secret-value", "secret-field": "Bearer private" });
    if (parsed.success) throw new Error("fixture should fail");
    expect(diagnoseHarnessFailure(parsed.error)).toEqual({ code: "wire_schema_invalid", issues: [
      { code: "invalid_value", field: "state" }, { code: "unrecognized_keys", field: "root" } ] });
    expect(diagnoseHarnessFailure(new Error("cloud_actor_authority_rejected: Bearer private"))).toEqual({ code: "cloud_actor_authority_rejected" });
    expect(JSON.stringify(diagnoseHarnessFailure(parsed.error))).not.toMatch(/secret|Bearer|private/);
    expect(diagnoseHarnessFailure(new Error("private provider prose"))).toEqual({ code: "fixture_contract_invalid" });
  });
  it("refuses empty success even when the receipt and terminal say success", () => {
    const evidence = new TurnEvidence(owner);
    evidence.observe(terminal(), "live");
    expect(() => evidence.finish(receipt(), "success")).toThrow("empty_success");
  });
  it("requires a live nonempty delta before terminal, rather than replay-only output", () => {
    const evidence = new TurnEvidence(owner);
    evidence.observe(delta(), "replay"); evidence.observe(terminal(), "live");
    expect(() => evidence.finish(receipt(), "success")).toThrow("missing_live_delta");
  });
  it("refuses a delta that only arrives after the terminal", () => {
    const evidence = new TurnEvidence(owner);
    evidence.observe(terminal(), "live"); evidence.observe(delta(), "live");
    expect(() => evidence.finish(receipt(), "success")).toThrow("delta_after_terminal");
  });
  it("accepts real live streaming plus matching persisted replay", () => {
    const evidence = new TurnEvidence(owner);
    evidence.observe(delta(), "live"); evidence.observe(terminal(), "live");
    evidence.observe(delta(), "replay"); evidence.observe(terminal(), "replay");
    expect(evidence.finish(receipt(), "success")).toMatchObject({ outcome: "passed", liveDeltaBytes: 5, replayDeltaBytes: 5 });
  });
  it("refuses a failed terminal paired with a succeeded receipt", () => {
    const evidence = new TurnEvidence(owner); evidence.observe(delta(), "live"); evidence.observe(delta(), "replay");
    const failed = { ...terminal(), type: "AGENT_PROMPT_FAILED", error: "cloud_provider_prompt_auth_required", failure: { kind: "auth-required" } };
    evidence.observe(failed, "live"); evidence.observe(failed, "replay");
    expect(() => evidence.finish(receipt(), "success")).toThrow("terminal_receipt_mismatch");
  });
  it("refuses auth-coded receipt when the live failure has a different typed cause", () => {
    const evidence = new TurnEvidence(owner);
    evidence.observe({ ...terminal(), type: "AGENT_PROMPT_FAILED", error: "cloud_provider_prompt_timeout", failure: { kind: "timeout" } }, "live");
    expect(() => evidence.finish(receipt("failed", "cloud_provider_prompt_auth_required"), "auth-failure")).toThrow("terminal_receipt_mismatch");
  });
  it("refuses a cancelled native terminal paired with a success receipt", () => {
    const evidence = new TurnEvidence(owner); evidence.observe(delta(), "live"); evidence.observe(delta(), "replay");
    const cancelled = { ...terminal(), stopReason: "cancelled" }; evidence.observe(cancelled, "live"); evidence.observe(cancelled, "replay");
    expect(() => evidence.finish(receipt(), "success")).toThrow("terminal_receipt_mismatch");
  });
  it("does not count another conversation or command's frames", () => {
    const evidence = new TurnEvidence(owner);
    evidence.observe({ ...delta(), chatId: "another-chat" }, "live");
    evidence.observe({ ...terminal(), requestId: randomUUID() }, "live");
    expect(() => evidence.finish(receipt(), "success")).toThrow("missing_terminal");
  });
  it("refuses generic rejected failures when auth was expected", () => {
    const evidence = new TurnEvidence(owner);
    expect(() => evidence.finish(receipt("failed", "cloud_provider_prompt_rejected"), "auth-failure")).toThrow("expected_auth_failure");
  });
  it("retains the original unexpected containment receipt and authenticated frame counts without accepting the case", () => {
    const evidence = new TurnEvidence(owner);
    const resultCode = "cloud_provider_start_design_protection_failed";
    const failed = { ...terminal(), type: "AGENT_PROMPT_FAILED", error: resultCode, failure: { kind: "protocol-error" } };
    evidence.observe(failed, "live"); evidence.observe(failed, "replay");
    let error: unknown;
    try { evidence.finish(receipt("failed", resultCode), "admission-failure"); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect(diagnoseHarnessFailure(error)).toMatchObject({ code: resultCode, assertionCode: "expected_admission_failure",
      observation: { outcome: "failed", state: "failed", resultCode, liveDeltaBytes: 0, replayDeltaBytes: 0,
        liveTerminal: true, replayTerminal: true, frames: 2 } });
    expect(JSON.stringify(diagnoseHarnessFailure(error))).not.toMatch(/native-session|fixture-execution|fixture-chat/);
  });
  it("records invalid auth only as pre-auth proof, with the closed stage/category", () => {
    const evidence = new TurnEvidence(owner);
    const failed = { ...terminal(), type: "AGENT_PROMPT_FAILED", error: "cloud_provider_prompt_auth_required", failure: { kind: "auth-required" } };
    evidence.observe(failed, "live"); evidence.observe(failed, "replay");
    expect(evidence.finish(receipt("failed", "cloud_provider_prompt_auth_required"), "auth-failure"))
      .toMatchObject({ outcome: "pre_auth_only", cause: { stage: "provider_prompt", category: "auth_required" } });
  });
  it("refuses auth receipt-only or missing authenticated terminal replay", () => {
    const authReceipt = receipt("failed", "cloud_provider_prompt_auth_required");
    expect(() => new TurnEvidence(owner).finish(authReceipt, "auth-failure")).toThrow("missing_terminal");
    const evidence = new TurnEvidence(owner);
    evidence.observe({ ...terminal(), type: "AGENT_PROMPT_FAILED", error: authReceipt.resultCode, failure: { kind: "auth-required" } }, "live");
    expect(() => evidence.finish(authReceipt, "auth-failure")).toThrow("missing_replay");
  });
  it("accepts an exact legacy typed admission code without inventing a provider failure kind", () => {
    const evidence = new TurnEvidence(owner);
    const failed = { ...terminal(), type: "AGENT_PROMPT_FAILED", error: "cloud_agent_credential_required", failure: { kind: "cloud-credentials-unavailable" } };
    evidence.observe(failed, "live"); evidence.observe(failed, "replay");
    expect(evidence.finish(receipt("failed", "cloud_agent_credential_required"), "admission-failure")).toMatchObject({ outcome: "pre_auth_only" });
  });
  it("refuses a replay terminal whose state/code differs from the persisted receipt", () => {
    const evidence = new TurnEvidence(owner);
    evidence.observe(delta(), "live"); evidence.observe(terminal(), "live"); evidence.observe(delta(), "replay");
    evidence.observe({ ...terminal(), type: "AGENT_PROMPT_FAILED", error: "cloud_provider_prompt_auth_required" }, "replay");
    expect(() => evidence.finish(receipt(), "success")).toThrow("terminal_receipt_mismatch");
  });
  it("does not call a cancelled receipt auth or success", () => {
    expect(() => new TurnEvidence(owner).finish(receipt("cancelled"), "auth-failure")).toThrow("expected_auth_failure");
  });
  it("requires an explicit provider and refuses an all-skipped run", () => {
    expect(() => selectProviders([])).toThrow("no_providers");
    expect(() => selectProviders(["unknown"])).toThrow("invalid_provider");
    expect(selectProviders(["cursor", "claude", "codex", "claude"])).toEqual(["claude", "codex", "cursor"]);
  });
  it("bounds output accounting without retaining provider text", () => {
    const evidence = new TurnEvidence(owner, { maxBytes: 5 });
    evidence.observe(delta("secret-provider-content"), "live");
    expect(() => evidence.finish(receipt(), "success")).toThrow("evidence_limit");
    expect(JSON.stringify(evidence)).not.toContain("secret-provider-content");
  });
  it("traces only closed fields and never raw errors, prompts, bearer or argv", () => {
    const trace = safeTrace({ stage: "admission", status: "failed", provider: "claude", code: "cloud_admission_auth_required",
      elapsedMs: 12, prompt: "private", token: "secret", error: "Bearer private", argv: ["secret"] });
    expect(trace).toEqual({ stage: "admission", status: "failed", provider: "claude", code: "cloud_admission_auth_required", elapsedMs: 12 });
    expect(() => safeTrace({ stage: "secret", status: "failed" })).toThrow("invalid_trace");
    expect(() => safeTrace({ stage: "admission", status: "failed", code: "Bearer secret" })).toThrow("invalid_trace");
  });
  it("times out, aborts work and awaits cleanup even when work ignores abort", async () => {
    const cleanup = vi.fn(async () => {}); let signal: AbortSignal | undefined;
    await expect(runWithDeadline(async (value) => { signal = value; return new Promise(() => {}); }, cleanup, 15)).rejects.toThrow("turn_timeout");
    expect(signal?.aborted).toBe(true); expect(cleanup).toHaveBeenCalledOnce();
  });
  it("runs cleanup after an early failure and refuses failed cleanup", async () => {
    const cleanup = vi.fn(async () => {});
    await expect(runWithDeadline(async () => { throw new Error("private provider prose"); }, cleanup, 100)).rejects.toThrow("private provider prose");
    expect(cleanup).toHaveBeenCalledOnce();
    await expect(runWithDeadline(async () => 1, async () => { throw new Error("secret"); }, 100)).rejects.toThrow("cleanup_unconfirmed");
  });
  it("bounds cleanup that never settles, rather than hanging past the turn deadline", async () => {
    await expect(runWithDeadline(async () => 1, () => new Promise(() => {}), 100, 10)).rejects.toThrow("cleanup_unconfirmed");
  });
});

describe("renderer-shaped durable command driver", () => {
  it("captures the authenticated pre-enqueue cursor and replays only the current turn prefix", async () => {
    let listener: (frame: Record<string, unknown> & { type: string }) => void = () => {};
    let enqueued = false;
    const cursors: number[] = [];
    const frames = [{ ...delta("new-a"), cloudStream: { streamId: fixtureStreamId, sequence: 10 } },
      { ...delta("new-b"), cloudStream: { streamId: fixtureStreamId, sequence: 11 } },
      { ...terminal(), cloudStream: { streamId: fixtureStreamId, sequence: 12 } }];
    const entry = { ...receipt(), conversationId: owner.conversationId, position: 0, payload: null, generation: 1,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const client = { connect: async () => {}, close: vi.fn(), onMessage: (callback: typeof listener) => { listener = callback; return vi.fn(); },
      request: async (op: string, params: Record<string, unknown> = {}) => {
        if (op === "cloudCommands.createConversation") return {};
        if (op === "cloudCommands.conversation") return { modeRevision: 0 };
        const request = params.request as { kind: string; cursor?: { sequence: number } };
        if (op === "cloudEvents.request") {
          if (request.kind === "snapshot") return { cursor: { streamId: fixtureStreamId, sequence: enqueued ? 12 : 9 } };
          cursors.push(request.cursor!.sequence);
          return { streamId: fixtureStreamId, head: 12, firstRetained: 1, cursor: 12,
            events: frames.map(frame => ({ sequence: frame.cloudStream.sequence, frame })) };
        }
        if (request.kind === "snapshot") return { version: 1, conversationId: owner.conversationId, revision: 0, paused: false, pending: [], receipts: [] };
        if (request.kind === "mutate") { enqueued = true; listener(delta("old-turn")); for (const frame of frames) listener(frame); return {}; }
        if (request.kind === "read") return entry;
        return {};
      } };
    const result = await driveTurn(client, { ...owner, workspaceId: randomUUID(), model: "claude-sonnet-4-6", grantId: randomUUID(),
      permissionMode: "default", prompt: "fixture", expected: "success" });
    expect(cursors).toEqual([9]);
    expect(result).toMatchObject({ outcome: "passed", liveDeltaBytes: 10, replayDeltaBytes: 10 });
  });
  it("negotiates exact native-terminal receipts only when cloud turn protocol1 was advertised", () => {
    const request = { kind: "read", commandId: owner.commandId };
    expect(commandRequest(request, 1)).toEqual({ nativeCommandsVersion: 1, cloudTurnProtocolVersion: 1, request });
    expect(commandRequest(request)).toEqual({ nativeCommandsVersion: 1, request });
  });
  it("sends renderer HEARTBEAT frames while attached and stops the timer at cleanup", () => {
    vi.useFakeTimers();
    try {
      const client = { sendMessage: vi.fn() }; const stop = keepActorAlive(client);
      vi.advanceTimersByTime(15_000);
      expect(client.sendMessage).toHaveBeenCalledTimes(3);
      expect(client.sendMessage).toHaveBeenLastCalledWith({ type: "HEARTBEAT" });
      stop(); vi.advanceTimersByTime(15_000); expect(client.sendMessage).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });
  it("selects the native local-main identity from real workspace.list instead of the CP workspace UUID", () => {
    const identity = { workspaceId: randomUUID(), organizationId: randomUUID() };
    const workspace = { id: "local-main", canonicalId: identity.workspaceId, organizationId: identity.organizationId,
      placement: "cloud", path: "/srv/zeros/workspace" };
    expect(selectEngineWorkspace({ workspaces: [workspace] }, identity)).toBe("local-main");
    expect(() => selectEngineWorkspace({ workspaces: [{ ...workspace, organizationId: randomUUID() }] }, identity)).toThrow("fixture_contract_invalid");
    expect(() => selectEngineWorkspace({ workspaces: [{ ...workspace, path: "/foreign" }] }, identity)).toThrow("fixture_contract_invalid");
    expect(() => selectEngineWorkspace({ workspaces: [workspace, workspace] }, identity)).toThrow("fixture_contract_invalid");
  });
  it("never re-enqueues a lost acknowledgement and requests Stop for potentially executed work", async () => {
    const mutations: string[] = []; const versions: unknown[] = [];
    const client = { onMessage: () => vi.fn(), connect: async () => {}, close: vi.fn(), request: async (op: string, params: Record<string, unknown> = {}) => {
      if (op === "cloudCommands.createConversation") return {};
      if (op === "cloudCommands.conversation") return { modeRevision: 0, cloudTurnProtocolVersion: 1 };
      if (op === "cloudEvents.request") return { cursor: { streamId: fixtureStreamId, sequence: 0 } };
      versions.push(params.cloudTurnProtocolVersion);
      const request = params.request as { kind: string };
      if (request.kind === "snapshot") return { version: 1, conversationId: owner.conversationId, revision: 0, paused: false, pending: [], receipts: [] };
      mutations.push(request.kind);
      if (request.kind === "mutate") throw new Error("acknowledgement lost after enqueue");
      return {};
    } };
    await expect(driveTurn(client, { workspaceId: randomUUID(), ...owner, model: "claude-sonnet-4-6", grantId: randomUUID(),
      permissionMode: "default", prompt: "fixture", expected: "success" })).rejects.toThrow("acknowledgement lost");
    expect(mutations).toEqual(["mutate", "stop"]);
    expect(versions).toEqual([1, 1, 1]);
  });
  it("does not accept another provider's stale output or Stop-start marker", () => {
    const claude = freshNativeArtifacts(), codex = freshNativeArtifacts();
    expect(fixtureFileMatches({ sha256: claude.outputHash }, codex.outputHash)).toBe(false);
    expect(fixtureFileMatches({ sha256: claude.startHash }, codex.startHash)).toBe(false);
    expect(fixtureFileMatches(null, codex.startHash)).toBe(false);
    expect(fixtureFileMatches({ sha256: codex.startHash }, codex.startHash)).toBe(true);
    expect(fixtureFileMatches({ sha256: claude.shellHash }, codex.shellHash)).toBe(false);
    expect(claude.output).toContain(claude.input);
    expect(codex.output).toContain(codex.input);
    expect(claude.input).not.toBe(codex.input);
  });
  it("waits for the independent shell start marker before Stop, rather than tool announcement", async () => {
    const events: string[] = []; let probes = 0;
    await cancelAfterToolStart(async () => { events.push("probe"); return ++probes >= 3; }, async () => { events.push("stop"); }, 100, 1);
    expect(events).toEqual(["probe", "probe", "probe", "stop"]);
  });
  it("does not call Stop or pass mid-tool evidence when the shell never started", async () => {
    const stop = vi.fn(async () => {});
    await expect(cancelAfterToolStart(async () => false, stop, 5, 1)).rejects.toThrow("stop_evidence_missing");
    expect(stop).not.toHaveBeenCalled();
  });
  it("accepts the exact read wire shape with conversationId and rejects foreign command ownership", () => {
    const entry = { ...receipt(), conversationId: owner.conversationId, position: 0, payload: null, generation: 1,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    expect(readCommand(entry, owner)).toMatchObject(entry);
    expect(() => readCommand({ ...entry, conversationId: "foreign" }, owner)).toThrow("receipt_mismatch");
    expect(() => readCommand({ ...entry, commandId: randomUUID() }, owner)).toThrow("receipt_mismatch");
  });
  it("refuses populated fixture inspection when the authenticated bridge replay is empty", async () => {
    let listener: (frame: Record<string, unknown> & { type: string }) => void = () => {};
    const streamId = fixtureStreamId; let snapshots = 0;
    const entry = { ...receipt(), conversationId: owner.conversationId, position: 0, payload: null, generation: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const client = { onMessage: (callback: typeof listener) => { listener = callback; return vi.fn(); }, connect: async () => {}, close: vi.fn(),
      request: async (op: string, params: Record<string, unknown> = {}) => {
        if (op === "cloudCommands.conversation") return { modeRevision: 0 };
        if (op === "cloudCommands.createConversation") return {};
        const request = params.request as { kind: string };
        if (op === "cloudEvents.request") return request.kind === "snapshot" ? { cursor: { streamId, sequence: snapshots++ ? 2 : 0 } }
          : { streamId, head: 2, firstRetained: 1, cursor: 2, events: [] };
        if (request.kind === "snapshot") return { version: 1, conversationId: owner.conversationId, revision: 0, paused: false, pending: [], receipts: [] };
        if (request.kind === "mutate") { listener(delta()); listener(terminal()); return {}; }
        if (request.kind === "read") return entry;
        return {};
      } };
    await expect(driveTurn(client, { workspaceId: randomUUID(), ...owner, model: "claude-sonnet-4-6", grantId: randomUUID(),
      permissionMode: "default", prompt: "fixture", expected: "success", replayEvents: () => [{ sequence: 1, frame: delta() }, { sequence: 2, frame: terminal() }] }))
      .rejects.toThrow("missing_replay");
  });
  it("subscribes before connect so an early ENGINE_READY is observed, then proves account readiness with an RPC", async () => {
    let listener: (frame: Record<string, unknown> & { type: string }) => void = () => {}; const order: string[] = [];
    const client = { onMessage: (callback: typeof listener) => { order.push("observe"); listener = callback; return vi.fn(); },
      connect: async () => { listener({ type: "ENGINE_READY" }); order.push("connected"); },
      request: async (op: string) => { order.push(op); return []; }, close: vi.fn() };
    await authenticateEngine(client, () => order.push("early-ready"));
    expect(order).toEqual(["observe", "early-ready", "connected", "workspace.list"]);
  });
  it("does not turn an early ENGINE_READY plus rejected CONNECTED into authenticated success", async () => {
    const close = vi.fn();
    const client = { onMessage: () => vi.fn(), connect: async () => {}, request: async () => { throw new Error("ACCOUNT_AUTH_REQUIRED"); }, close };
    await expect(authenticateEngine(client, () => {})).rejects.toThrow("engine_authentication_failed");
    expect(close).toHaveBeenCalledOnce();
  });
  it("pins grant, model, mode revision and command identity exactly like CloudAgentConnection", () => {
    const commandId = randomUUID(), grant = randomUUID();
    const params = enqueueRequest({ conversationId: "fixture-chat", commandId, provider: "claude", model: "claude-sonnet-4-6",
      grantId: grant, revision: 2, modeRevision: 3, permissionMode: "default", prompt: "say hello" });
    expect(params).toEqual({ nativeCommandsVersion: 1, request: { kind: "mutate", mutation: { conversationId: "fixture-chat", operationId: commandId,
      expectedRevision: 2, action: { kind: "enqueue", commandId, payload: { agentId: "claude", userMessageId: commandId,
        agentCredentialGrantId: grant, modeRevision: 3, model: "claude-sonnet-4-6", permissionMode: "default", prompt: [{ type: "text", text: "say hello" }] } } } } });
  });
});

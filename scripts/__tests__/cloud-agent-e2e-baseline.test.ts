// Orchestration fixtures only: a controlled turn producer plus real private
// HTTPS prepare/counters. These cases make no native/provider timing claim.
import { randomUUID } from "node:crypto";
import { request } from "node:https";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createFixtureControlPlane, type FixtureControlPlane } from "../cloud-workspace-validation/cloud-agent-e2e/fixture-control-plane/server";
import { createFixtureTls } from "../cloud-workspace-validation/cloud-agent-e2e/runtime";
import { driveRendererTurn } from "../cloud-workspace-validation/cloud-agent-e2e/renderer-turn";
import { measureCurrentTurn, measureBootOwnerTurn } from "../cloud-workspace-validation/cloud-agent-e2e/baseline";
import { mirrorProofSha256 as hash } from "../cloud-workspace-validation/cloud-agent-e2e/local-mirror-proof";
import { CloudAgentBootConversationSchema } from "@zeros/protocol/cloud-agent-bootstrap";
import { summarizeTurnTimings } from "../cloud-workspace-validation/cloud-agent-e2e/measurement";
import { decodeCloudCommandFailure } from "@zeros/protocol/cloud-commands";

vi.mock("../cloud-workspace-validation/cloud-agent-e2e/renderer-turn", () => ({ driveRendererTurn: vi.fn() }));
const fixtures: FixtureControlPlane[] = [];
let root: string, tls: Awaited<ReturnType<typeof createFixtureTls>>, ca: Buffer;
beforeAll(async () => {
  const parent = path.join(process.cwd(), ".context/agents-fix/scratch/W5/p3");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  root = await mkdtemp(path.join(parent, "baseline-tls-"));
  tls = await createFixtureTls(root); ca = await readFile(tls.ca);
});
afterEach(async () => { vi.resetAllMocks(); await Promise.all(fixtures.splice(0).map(cp => cp.close())); });
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

function post(url: string, body: unknown, bearerToken = "fixture-absent-authority"): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { method: "POST", ca, headers: { "content-type": "application/json", authorization: "Bearer " + bearerToken } }, response => {
      response.resume(); response.on("end", () => resolve(response.statusCode ?? 0));
    });
    outgoing.on("error", reject); outgoing.end(JSON.stringify(body));
  });
}
async function setup() {
  const cp = createFixtureControlPlane({ tls, allowedModels: { codex: ["fixture-model"] } }); fixtures.push(cp);
  const runtime = { profile: "zeros-cloud-worker-v4" as const, manifestSha256: "a".repeat(64), runtimeId: `r1-${"a".repeat(64)}`,
    baseCompatibilityId: `bc1-${"b".repeat(64)}`, installerReceiptSha256: "c".repeat(64), bootId: randomUUID(), supervisorSessionId: randomUUID() };
  cp.configureRuntime(runtime); const { baseUrl } = await cp.start();
  expect(await post(baseUrl + "/internal/v1/cloud-workspaces/engine/register", { ...cp.identity,
    actorProtocolVersion: 2, agentCustomizationVersion: 3, agentRuntime: runtime }, cp.runtimeTokens.registrationToken)).toBe(200);
  const verify = vi.fn(async (_id: string) => {});
  const fixture = { identity: cp.identity, rendererAuthority: () => cp.rendererAuthority(), measurementCheckpoint: () => cp.measurementCheckpoint(),
    measurementWindow: (...args: Parameters<typeof cp.measurementWindow>) => cp.measurementWindow(...args),
    assertTerminalConsistency: verify, readEvents: () => [] };
  const bridge = {} as Parameters<typeof driveRendererTurn>[0];
  const input = { engineWorkspaceId: "local-main", conversationId: randomUUID(), userMessageId: randomUUID(),
    provider: "codex" as const, model: "fixture-model", prompt: "private-baseline-prompt", expected: "auth-failure" as const,
    baseUrl, ca, fixture, timeoutMs: 1000 };
  const commandId = randomUUID(), executionId = "controlled-execution";
  const entry = { commandId, position: 1, state: "failed" as const, payload: null, executionId, generation: cp.identity.generation,
    resultCode: "cloud_provider_prompt_auth_required", createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z" };
  const settings = { stage: "typed_auth_failure", invalidTiming: false, missingEngine: false, inspectTraffic: true };
  vi.mocked(driveRendererTurn).mockImplementation(async (_bridge, turn) => {
    turn.onSend?.(); const sentAtMs = performance.now();
    if (turn.mode !== "boot-owner-v1") {
      const grant = await turn.grant("codex", "fixture-model");
      expect(grant).toBe(cp.delegationId("codex"));
    }
    const receivedAtMs = performance.now();
    await post(baseUrl + "/unrelated-fixture-request", {});
    const observedAtMs = performance.now();
    await new Promise(resolve => setTimeout(resolve, 5));
    const settledAtMs = performance.now(); turn.onRendererSettled?.();
    if (turn.mode === "boot-owner-v1") await turn.verifyTerminal(commandId, { ...entry, conversationId: turn.conversationId }, new AbortController().signal);
    else await turn.verifyTerminal(commandId);
    if (settings.inspectTraffic) await post(baseUrl + "/post-result-fixture-verification", {});
    const clockId = randomUUID(), sampledAtMs = performance.now();
    const owned = { commandId, conversationId: turn.conversationId, turnId: turn.userMessageId, executionId, provider: turn.provider };
    const { organizationId, workspaceId, generation, engineInstanceId } = cp.identity;
    const boot = turn.mode === "boot-owner-v1" ? CloudAgentBootConversationSchema.parse(turn.bootBinding) : undefined;
    const scope = { organizationId, workspaceId, generation, engineInstanceId, conversationId: turn.conversationId,
      mode: boot ? "boot-owner-v1" as const : "legacy" as const, bootId: boot?.bootId ?? null, writerEpoch: boot?.writerEpoch ?? null };
    const stages = [{ stage: "engine_received", atMs: receivedAtMs }, { stage: "dispatch_committed", atMs: receivedAtMs },
      ...(!settings.invalidTiming ? [{ stage: settings.stage, atMs: observedAtMs }] : []), { stage: "terminal_committed", atMs: settledAtMs }];
    const timing = summarizeTurnTimings({ version: 1, ...scope, clockId: randomUUID(), sampledAtMs,
      coverage: { truncated: false, retired: false, unknown: false }, records: stages.map((row, i) => ({ ...owned, ...row, sequence: i + 1 })) },
    { ...scope, ...owned }, { clientClockId: clockId, sendAtMs: sentAtMs, beforeAtMs: sampledAtMs, afterAtMs: sampledAtMs });
    if (settings.missingEngine) timing.sendToEngineMs = null;
    return { commandId, turnId: turn.userMessageId, executionId, state: "failed", resultCode: "cloud_provider_prompt_auth_required",
      cause: decodeCloudCommandFailure("cloud_provider_prompt_auth_required"),
      toolCalls: 0, toolKinds: [], liveDeltaBytes: 0, replayDeltaBytes: 0, frames: 2, outcome: "pre_auth_only",
      clientTiming: { clockId, sentAtMs, settledAtMs }, rendererSendToResultMs: settledAtMs - sentAtMs, timing,
    };
  });
  return { cp, fixture, bridge, input, commandId, entry, verify, settings };
}

describe("CURRENT baseline orchestration", () => {
  it("performs real public prepare inside Send and binds the actual turn identities", async () => {
    const f = await setup(); const result = await measureCurrentTurn(f.bridge, f.input);
    expect(result.turn).toMatchObject({ commandId: f.commandId, turnId: f.input.userMessageId, outcome: "pre_auth_only" });
    expect(result.sendWindow.operationArrivalCounts["renderer.prepare"]).toBe(1);
    expect(result.ingress.interval.arrivalCount).toEqual({ min: 1, max: 1 });
    expect(f.verify).toHaveBeenCalledExactlyOnceWith(f.commandId);
    expect(vi.mocked(driveRendererTurn).mock.calls[0][1].scope).toEqual({ organizationId: f.cp.identity.organizationId,
      workspaceId: f.cp.identity.workspaceId, generation: f.cp.identity.generation, engineInstanceId: f.cp.identity.engineInstanceId });
  });
  it("separates Send/result counts from post-result verification traffic", async () => {
    const f = await setup(); const result = await measureCurrentTurn(f.bridge, f.input);
    expect(result.sendWindow.ingressCount).toBe(2);
    expect(result.ingress.fullWindow.ingressCount).toBe(3);
    expect(result.ingress.interval.arrivalCount.max).toBe(1);
    expect(result.observationWindowIncludesSetupAndVerification).toBe(true);
  });
  it("counts public prepare before engine receipt in the separate Send-to-native-write interval", async () => {
    const f = await setup(); f.settings.stage = "native_write";
    const result = await measureCurrentTurn(f.bridge, f.input);
    expect(result.observedIntervals.native_write?.interval.arrivalCount).toEqual({ min: 1, max: 1 });
    expect(result.sendToNativeWriteIngress?.interval.arrivalCount).toEqual({ min: 2, max: 2 });
    expect(result.sendToNativeWriteIngress?.interval.throughStage).toBe("native_write");
    expect(result.sendWindow.ingressCount).toBe(2);
    expect(result.ingress.fullWindow.ingressCount).toBe(3);
  });
  it("retains actual closed per-request rows separately for Send and engine receipt prefixes", async () => {
    const f = await setup(); f.settings.stage = "native_write";
    const result = await measureCurrentTurn(f.bridge, f.input);
    expect(result.sendToNativeWriteIngress?.requests.filter(row => row.arrivalInInterval !== "outside")
      .map(row => row.operation)).toEqual(["renderer.prepare", "unknown"]);
    expect(result.observedIntervals.native_write?.requests.filter(row => row.arrivalInInterval !== "outside")
      .map(row => row.operation)).toEqual(["unknown"]);
    expect(result.sendToNativeWriteIngress?.requests.every(row => row.origin === "unverified" && row.spanId === null && row.waitId === null)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(f.cp.rendererAuthority().bearerToken);
  });
  it.each(["native_acceptance_ack", "sdk_run_created", "typed_auth_failure"])("does not substitute %s for a missing Send-to-native-write count", async stage => {
    const f = await setup(); f.settings.stage = stage;
    const result = await measureCurrentTurn(f.bridge, f.input);
    expect(result.sendToNativeWriteIngress).toBeNull();
    expect(result.observedIntervals.native_write).toBeNull();
  });
  it.each(["native_write", "native_acceptance_ack", "sdk_run_created", "typed_auth_failure"])("keeps %s distinct", async stage => {
    const f = await setup(); f.settings.stage = stage;
    const result = await measureCurrentTurn(f.bridge, f.input);
    expect(result.ingress.interval.throughStage).toBe(stage);
  });
  it("never manufactures causal, production SQL or relay zero from fixture requests", async () => {
    const f = await setup(); const result = await measureCurrentTurn(f.bridge, f.input);
    expect(result).toMatchObject({ mode: "legacy", causalCoverage: "unavailable", foregroundCpRequests: null,
      backgroundCpRequests: null, productionSql: { exercised: false, writeStatements: null, rows: null, encodedBytes: null, transactions: null },
      controlPlaneRelay: { exercised: false, clientToEngineBytes: null, engineToClientBytes: null, subscribers: null } });
  });
  it("refuses missing native/write/SDK/auth timing rather than counting queue acknowledgement", async () => {
    const f = await setup(); f.settings.invalidTiming = true;
    await expect(measureCurrentTurn(f.bridge, f.input)).rejects.toThrow("timing_stage_missing");
  });
  it("retains a closed refusal when the receive boundary is absent", async () => {
    const f = await setup(); f.settings.missingEngine = true;
    await expect(measureCurrentTurn(f.bridge, f.input)).rejects.toThrow("timing_stage_missing");
  });
  it("refuses incomplete fixture coverage after an otherwise passing controlled turn", async () => {
    const f = await setup(); const window = f.fixture.measurementWindow;
    f.fixture.measurementWindow = (...args) => ({ ...window(...args), detailsComplete: false });
    await expect(measureCurrentTurn(f.bridge, f.input)).rejects.toThrow("ingress_details_incomplete");
  });
  it("refuses a foreign fixture clock without accepting its request totals", async () => {
    const f = await setup(); const window = f.fixture.measurementWindow;
    f.fixture.measurementWindow = (...args) => ({ ...window(...args), clockDomainId: randomUUID() });
    await expect(measureCurrentTurn(f.bridge, f.input)).rejects.toThrow("ingress_calibration_invalid");
  });
  it("keeps private authority and prompt values out of retained baseline evidence", async () => {
    const f = await setup(); const result = JSON.stringify(await measureCurrentTurn(f.bridge, f.input));
    expect(result).not.toContain(f.cp.rendererAuthority().bearerToken);
    expect(result).not.toContain(f.cp.actorGrantToken);
    expect(result).not.toContain(f.cp.delegationId("codex"));
    expect(result).not.toContain(f.input.prompt);
  });
  it("never calls a turn producer when public renderer authority is invalid", async () => {
    const f = await setup(); f.fixture.rendererAuthority = () => ({ userId: f.cp.actor.userId, bearerToken: "bad" });
    await expect(measureCurrentTurn(f.bridge, f.input)).rejects.toThrow("renderer_grant_identity_invalid");
    expect(driveRendererTurn).not.toHaveBeenCalled();
  });
});

// Controlled turn producer/activation ports only; genuine boot negotiation and
// engine emission must pass the separate actual operator/native run.
async function bootSetup() {
  const f = await setup(), { organizationId, workspaceId, generation, engineInstanceId } = f.cp.identity;
  const binding = CloudAgentBootConversationSchema.parse({ organizationId, workspaceId, generation, engineInstanceId, version: 1, mode: "boot-owner-v1",
    fundingScope: "workspace-roles-v1", bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: f.cp.actor.userId,
    fundingOwnerEpoch: 1, authorityEpoch: 1, cacheRevision: 1, desiredCacheRevision: 1,
    initialAdoptions: ["claude", "codex", "cursor"].map(provider => ({ provider, status: "unknown" })) });
  const { version: _v, mode: _m, fundingScope: _f, authorityEpoch: _a, cacheRevision: _c, desiredCacheRevision: _d, initialAdoptions: _i, ...scope } = binding;
  const audit = { restoreRevision: 1, recordSequence: 1, eventSequence: 2, incompleteReason: "capture_unavailable" };
  const head = { originWriterEpoch: scope.writerEpoch, source: { kind: "command", commandId: f.commandId, executionId: f.entry.executionId,
    intent: { agentId: "codex", userMessageId: f.input.userMessageId }, nativeResultSha256: null }, deleted: false, history: audit };
  const privateFixture = { identity: f.cp.identity, measurementCheckpoint: () => f.cp.measurementCheckpoint(),
    measurementWindow: (...args: Parameters<typeof f.cp.measurementWindow>) => f.cp.measurementWindow(...args),
    activeBootScope: () => scope, inspect: () => ({ boot: { negotiated: true, activated: true } }),
    readMirrorCommand: vi.fn(() => ({ conversationId: f.input.conversationId, entry: f.entry, history: audit })),
    readMirrorHistory: vi.fn(() => ({ complete: false, historyHead: head, records: [] })), assertMirrorTerminalConsistency: vi.fn(),
    rendererAuthority: vi.fn(() => { throw new Error("unexpected_prepare_authority"); }), readEvents: vi.fn(() => { throw new Error("unexpected_cp_delta_replay"); }) };
  const localProof = vi.fn(async () => ({ version: 1, commandId: f.commandId, conversationId: f.input.conversationId,
    scopeSha256: hash(scope), receiptSha256: hash(f.entry), auditSha256: hash(audit), headSha256: hash(head), history: "incomplete",
    incompleteReason: "capture_unavailable", recordCount: 0, recordBytes: 0, recordsSha256: null, outboxPending: false }));
  return { ...f, binding, privateFixture, localProof, after: { ...f.input, fixture: privateFixture, localProof,
    engineReady: { type: "ENGINE_READY", source: "engine", capabilities: ["cloud.localCommands.v1", "cloud.turnTimings.v1"], cloudLocalCommands: binding } } };
}
describe("boot-owner after-baseline", () => {
  it("counts genuine Send-to-native-write arrivals separately from later final-state verification", async () => {
    const f = await bootSetup(); f.settings.stage = "native_write";
    const result = await measureBootOwnerTurn(f.bridge, f.after);
    expect(result.sendToNativeWriteIngress?.interval.arrivalCount).toEqual({ min: 1, max: 1 });
    expect(result.sendToNativeWriteIngress?.interval.throughStage).toBe("native_write");
    expect(result.observedIntervals.native_write?.interval.arrivalCount).toEqual({ min: 1, max: 1 });
    expect(result.sendWindow.ingressCount).toBe(1);
    expect(result.ingress.fullWindow.ingressCount).toBe(2);
    expect(f.privateFixture.rendererAuthority).not.toHaveBeenCalled();
  });
  it("uses genuine selected metadata without prepare or CP delta substitution and awaits independent compact final", async () => {
    const f = await bootSetup(), result = await measureBootOwnerTurn(f.bridge, f.after);
    expect(result).toMatchObject({ mode: "boot-owner-v1", compactFinal: { receiptMatchesVM: true, currentHeadMatchesVM: true,
      historyCoverage: "incomplete", canonicalRecordsCompared: false } });
    expect(result.sendWindow.operationArrivalCounts["renderer.prepare"] ?? 0).toBe(0);
    expect(f.privateFixture.rendererAuthority).not.toHaveBeenCalled(); expect(f.privateFixture.readEvents).not.toHaveBeenCalled();
    expect(f.privateFixture.assertMirrorTerminalConsistency).toHaveBeenCalledExactlyOnceWith(f.commandId, { conversationId: f.input.conversationId, entry: f.entry });
    const turn = vi.mocked(driveRendererTurn).mock.calls[0]![1];
    expect(turn.mode).toBe("boot-owner-v1"); expect(turn.fixtureEvents).toBeUndefined();
    await expect(turn.grant("codex", "fixture-model")).rejects.toThrow("fixture_contract_invalid");
    expect(result).toMatchObject({ causalCoverage: "unavailable", productionSql: { exercised: false }, controlPlaneRelay: { exercised: false } });
  });
  it.each(["cp-ack", "activation", "ready-cap", "foreign-writer"])("refuses %s without falling back to legacy", async kind => {
    const f = await bootSetup();
    if (kind === "cp-ack") f.privateFixture.inspect = () => ({ boot: { negotiated: false, activated: true } });
    if (kind === "activation") f.privateFixture.inspect = () => ({ boot: { negotiated: true, activated: false } });
    if (kind === "ready-cap") f.after.engineReady.capabilities = ["cloud.turnTimings.v1"];
    if (kind === "foreign-writer") f.after.engineReady.cloudLocalCommands = { ...f.binding, writerEpoch: randomUUID() };
    await expect(measureBootOwnerTurn(f.bridge, f.after)).rejects.toThrow("fixture_contract_invalid");
    expect(driveRendererTurn).not.toHaveBeenCalled();
  });
  it("refuses a mismatching compact head after the renderer terminal passes", async () => {
    const f = await bootSetup(), proof = await f.localProof();
    f.localProof.mockResolvedValueOnce({ ...proof, headSha256: "c".repeat(64) });
    await expect(measureBootOwnerTurn(f.bridge, f.after)).rejects.toThrow("receipt_mismatch");
  });
  it("keeps legacy measurement explicit and refuses an unexpected local mode", async () => {
    const f = await setup();
    await expect(measureCurrentTurn(f.bridge, { ...f.input, mode: "boot-owner-v1" })).rejects.toThrow("fixture_contract_invalid");
    expect(driveRendererTurn).not.toHaveBeenCalled();
  });
});

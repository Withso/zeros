import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { releaseCanaryAdapter, fixedCanaryOutcome } from "./worker-canary";
import { releaseCanaryBroker, releaseCanaryConnections, ReleaseCanaryPrelaunchError } from "./worker-broker";
import { SMOKE_MODELS } from "./worker-profile";
import { workerEnvironment, workerConnections } from "./worker-test-fixtures";
import { workerExecutionConfig } from "./worker-config";
import { PromotionError } from "./contracts";
import { qualificationRateLimited } from "../dev-environment/native-agent-canary.mjs";
import { newHostedGeneration, openReceipt, sealReceipt } from "../dev-environment/hosted-state.mjs";

const image = { snapshotId: "worker-test", sourceCommit: "a".repeat(40), buildSha256: "b".repeat(64), architecture: "linux/amd64" as const, storageMiB: 4096 };
const targetFor = () => ({ id: "bx_test", attempt: randomUUID(), snapshotId: image.snapshotId, sourceCommit: image.sourceCommit, buildSha256: image.buildSha256 });
const environment = workerEnvironment;
const connectionsFor = (profile: "smoke" | "full" = "smoke") => releaseCanaryConnections(workerConnections(), profile);
const leaseFor = () => ({ state: { resources: { images: [] as any[] } }, save: vi.fn(async () => {}), fence: vi.fn(async () => {}) });
const runFor = () => ({ runId: "123", canaries: [] });
const diagnosticReport = () => ({ phase: "native-mcp-tool-evidence", failure: "runtime", failureCode: "EACCES",
  failureName: "AgentFailureError", failureKind: "transport-closed", failureStage: "prompt", failureExitCode: 1,
  failureMessageSha256: "ab".repeat(8), activity: { permissions: 1, rejectedPermissions: 0, questions: 0, messageChunks: 2, toolEvents: 3 } });
const expectedDiagnostics = () => ({ phase: "native-mcp-tool-evidence", failure: "runtime", code: "EACCES",
  name: "AgentFailureError", kind: "transport-closed", stage: "prompt", exitCode: 1, messageSha256: "ab".repeat(8),
  activity: { permissions: 1, rejectedPermissions: 0, questions: 0, messageChunks: 2, toolEvents: 3 } });
const initialMcpToolEvidence = () => ({ version: 1, events: 4, overflowed: false, uniqueRows: 2,
  matched: { rows: 1, completed: 0, failed: 1, pending: 0, unknownStatus: 0, nativeId: 1, missingNativeId: 0, successful: 0 } });
const questionEvidence = () => ({ version: 1, requests: 1, overflowed: false,
  sources: { native_dialog: 0, native_rpc: 1, inferred_from_text: 0, unknown: 0 },
  blocking: { yes: 1, no: 0, unknown: 0 }, elicitation: { mcp: 1, notIndicated: 0, unknown: 0 } });
const eventEvidence = () => ({ initialMcpToolEvidence: initialMcpToolEvidence(), questionEvidence: questionEvidence() });

describe("protected metadata-only release canary broker", () => {
  it("reports only allowlisted missing/ambiguous kinds and withholds every other server diagnostic", async () => {
    const env = environment(), config = workerExecutionConfig(env).config;
    for (const message of ["Release canary designation missing for codex-chatgpt", "Release canary designation ambiguous for cursor-api-key"]) {
      const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { code: "release_canary_unavailable", message } }), { status: 409 }));
      await expect(releaseCanaryBroker(config, env, "smoke", fetcher as any).preflight()).rejects.toThrow(message);
      expect(fetcher).toHaveBeenCalledOnce();
    }
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { code: "release_canary_unavailable", message: "synthetic-private-diagnostic" } }), { status: 500 }));
    await expect(releaseCanaryBroker(config, env, "smoke", fetcher as any).preflight()).rejects.toThrow("unconfirmed");
  });
  it("refuses discovery for another actor, source or recorded run attempt before dispatch", async () => {
    const env = environment(), config = workerExecutionConfig(env).config;
    for (const changed of [{ ownerUserId: workerConnections()[0]!.credentialId }, { sourceSha: "b".repeat(40) }, { runAttempt: "2" }, { material: "synthetic-never-accepted" }]) {
      const fetcher = vi.fn(async (_url: any, options: any) => new Response(JSON.stringify({ ...JSON.parse(options.body), ready: true, connections: workerConnections(), ...changed })));
      const broker = releaseCanaryBroker(config, env, "smoke", fetcher as any);
      await expect(broker.preflight()).rejects.toThrow("exact API and run");
      await expect(broker.start({ attempt: randomUUID() }, "codex-chatgpt")).rejects.toThrow("discovery is required");
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });
  it("requires exactly the opted-in three kinds and never loads provider secrets", () => {
    const connections = connectionsFor();
    expect([...connections.keys()]).toEqual(["claude-setup-token", "codex-chatgpt", "cursor-api-key"]);
    expect(connections.get("codex-chatgpt")).not.toHaveProperty("material");
    const document = workerConnections();
    for (const connections of [document.slice(1), [...document, { ...document[0], kind: "claude-api-key" }],
      document.map(row => ({ ...row, material: { accessToken: "synthetic-never-accepted" } }))]) {
      expect(() => releaseCanaryConnections(connections, "smoke")).toThrow();
    }
    const env = environment();
    expect(() => releaseCanaryBroker(workerExecutionConfig(env).config, { ...env, WORKER_CANARY_ADMISSION_TOKEN: "" }, "smoke")).toThrow("authority");
  });
  it("binds preflight and dispatch to the new channel API and sends no account material to CI", async () => {
    const env = environment(), config = workerExecutionConfig(env).config, calls: any[] = [];
    const fetcher = vi.fn(async (url: any, options: any) => {
      calls.push({ url, ...JSON.parse(options.body) });
      expect(options.redirect).toBe("error");
      return new Response(JSON.stringify(url.endsWith("preflight") ? { ready: true, ...JSON.parse(options.body), connections: workerConnections() } : { started: true }));
    });
    const broker = releaseCanaryBroker(config, env, "smoke", fetcher as any);
    await broker.preflight(); await broker.start(targetFor(), "codex-chatgpt");
    expect(calls).toHaveLength(2); expect(calls[1]).toMatchObject({ kind: "codex-chatgpt", runId: "123", runAttempt: "1", sourceSha: image.sourceCommit });
    expect(JSON.stringify(calls)).not.toContain(env.WORKER_CANARY_ADMISSION_TOKEN);
    expect(calls[1]).not.toHaveProperty("material");
    expect(calls[0]).not.toHaveProperty("connections");
    expect(calls[1]).toMatchObject({ credentialId: workerConnections()[1]!.credentialId, credentialRevision: 1, designationId: "41" });
  });
  it("does not retry lost admission responses or expose provider/token text", async () => {
    const env = environment(), fetcher = vi.fn(async (_url: any, options: any) => {
      if (fetcher.mock.calls.length === 1) return new Response(JSON.stringify({ ready: true, ...JSON.parse(options.body), connections: workerConnections() }));
      throw new Error("synthetic-private-response");
    });
    const broker = releaseCanaryBroker(workerExecutionConfig(env).config, env, "smoke", fetcher as any);
    await broker.preflight();
    await expect(broker.start(targetFor(), "codex-chatgpt")).rejects.toThrow("reconcile");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("retains only fixed allowlisted proof, not provider output or credential-shaped fields", () => {
    const privateText = "syntheticPrivateProviderText";
    const result = fixedCanaryOutcome({ code: 1, retirement: 0, stdout: privateText, renewal: { privateText },
      report: { checks: ["nativeTurn", privateText], authority: privateText, executionProfile: privateText,
        identity: { kind: privateText, model: privateText }, failureKind: "rate-limited", failureMessage: privateText } }, { kind: "cursor-api-key", model: SMOKE_MODELS.cursor, image });
    expect(JSON.stringify(result)).not.toContain(privateText);
    expect(result.report.checks).toEqual(["nativeTurn"]); expect(result.report.failureKind).toBe("rate-limited");
  });
});

describe("release native diagnostic boundary", () => {
  it("allowlists complete bounded initial-tool and canonical-question summaries with no private nested fields", () => {
    const privateText = "synthetic private native payload".repeat(4096), bounded = eventEvidence();
    const result = fixedCanaryOutcome({ code: 1, retirement: 0, report: { ...diagnosticReport(),
      initialMcpToolEvidence: { ...bounded.initialMcpToolEvidence, title: privateText, rawInput: { privateText },
        matched: { ...bounded.initialMcpToolEvidence.matched, toolCallId: privateText, provider: { privateText } } },
      questionEvidence: { ...bounded.questionEvidence, questionId: privateText, questions: [{ prompt: privateText }],
        sources: { ...bounded.questionEvidence.sources, [privateText]: privateText },
        elicitation: { ...bounded.questionEvidence.elicitation, labels: [privateText] } },
    } });
    expect(result.report).toHaveProperty("diagnostics", { ...expectedDiagnostics(), ...bounded });
    expect(result.code).toBe(1); expect(result.report.qualified).toBe(false);
    expect(result.report).not.toHaveProperty("initialMcpToolEvidence");
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result).length).toBeLessThan(2048);
  });
  it.each([NaN, Infinity, -1, 1.5, 2049, "1", { private: "synthetic private count" }])(
    "drops malformed nested counts without fabricating a zero summary", value => {
      const bounded = eventEvidence();
      const result = fixedCanaryOutcome({ report: { phase: "native-mcp-tool-evidence",
        initialMcpToolEvidence: { ...bounded.initialMcpToolEvidence, matched: { ...bounded.initialMcpToolEvidence.matched, failed: value } },
        questionEvidence: { ...bounded.questionEvidence, sources: { ...bounded.questionEvidence.sources, native_rpc: value } },
      } });
      expect(result.report).toHaveProperty("diagnostics", { phase: "native-mcp-tool-evidence" });
      expect(JSON.stringify(result)).not.toContain("private");
    });
  it("rejects missing, incompatible or incoherent new summaries independently and keeps old flat reports", () => {
    const bounded = eventEvidence();
    for (const malformed of [undefined, null, [], "private", {}, { ...bounded.initialMcpToolEvidence, version: 2 },
      { ...bounded.initialMcpToolEvidence, overflowed: "true" }, { ...bounded.initialMcpToolEvidence, uniqueRows: 5 },
      { ...bounded.initialMcpToolEvidence, matched: { ...bounded.initialMcpToolEvidence.matched, rows: 3 } },
      { ...bounded.initialMcpToolEvidence, matched: { ...bounded.initialMcpToolEvidence.matched, successful: 1 } }]) {
      const result = fixedCanaryOutcome({ report: { ...diagnosticReport(), initialMcpToolEvidence: malformed, questionEvidence: bounded.questionEvidence } });
      expect(result.report).toHaveProperty("diagnostics", { ...expectedDiagnostics(), questionEvidence: bounded.questionEvidence });
    }
    for (const malformed of [undefined, null, [], "private", {}, { ...bounded.questionEvidence, version: 2 },
      { ...bounded.questionEvidence, overflowed: "true" }, { ...bounded.questionEvidence, requests: 2 },
      { ...bounded.questionEvidence, blocking: { yes: 0, no: 1, unknown: 0 } }]) {
      const result = fixedCanaryOutcome({ report: { ...diagnosticReport(), initialMcpToolEvidence: bounded.initialMcpToolEvidence, questionEvidence: malformed } });
      expect(result.report).toHaveProperty("diagnostics", { ...expectedDiagnostics(), initialMcpToolEvidence: bounded.initialMcpToolEvidence });
    }
    expect(fixedCanaryOutcome({ report: diagnosticReport() }).report).toHaveProperty("diagnostics", expectedDiagnostics());
    expect(fixedCanaryOutcome({ report: { diagnostics: { ...expectedDiagnostics(), ...bounded } } }).report).not.toHaveProperty("diagnostics");
  });
  it.each([0, 2048])("retains measured endpoints and explicitly saturated counters: %s", count => {
    const bounded = { initialMcpToolEvidence: { version: 1, events: count, overflowed: count === 2048, uniqueRows: count,
      matched: { rows: count, completed: 0, failed: 0, pending: count, unknownStatus: 0, nativeId: 0, missingNativeId: count, successful: 0 } },
    questionEvidence: { version: 1, requests: count, overflowed: count === 2048,
      sources: { native_dialog: 0, native_rpc: count, inferred_from_text: 0, unknown: 0 },
      blocking: { yes: count, no: 0, unknown: 0 }, elicitation: { mcp: count, notIndicated: 0, unknown: 0 } } };
    expect(fixedCanaryOutcome({ report: bounded }).report).toHaveProperty("diagnostics", bounded);
  });
  it.each([
    { failure: "timeout", failureName: "QualificationDeadline", diagnostics: { failure: "timeout", name: "QualificationDeadline" } },
    { failure: "assertion", failureName: "AssertionError", failureCode: "ERR_ASSERTION", diagnostics: { failure: "assertion", name: "AssertionError", code: "ERR_ASSERTION" } },
  ])("keeps the fixed $failure category and class without raw text", ({ diagnostics, ...report }) => {
    expect(fixedCanaryOutcome({ report }).report).toHaveProperty("diagnostics", diagnostics);
  });
  it("retains the producer's bounded phase, signature and observed counters", () => {
    const result = fixedCanaryOutcome({ code: 1, retirement: 0, report: { ...diagnosticReport(), qualified: false } });
    expect(result.report).toHaveProperty("diagnostics", expectedDiagnostics());
    expect(result.report.failureKind).toBeUndefined();
    expect(result.report).not.toHaveProperty("toolEvidence");
  });
  it("keeps real camel-cased engine stages rather than arbitrary regex-shaped labels", () => {
    for (const stage of ["initialize", "newSession", "loadSession", "forkSession", "prompt", "cancel", "stopBackgroundTask", "setMode"]) {
      expect(fixedCanaryOutcome({ report: { failureStage: stage } }).report).toHaveProperty("diagnostics.stage", stage);
    }
    const result = fixedCanaryOutcome({ report: { phase: "private-token-phase", failure: "private-runtime",
      failureCode: "PRIVATE_CREDENTIAL_CODE", failureName: "PrivateCredentialError", failureKind: "private-token", failureStage: "private-path",
      failureMessageSha256: "private-digest", failureExitCode: "1", activity: "private activity", message: "private message", stack: "private stack" } });
    expect(result.report).not.toHaveProperty("diagnostics");
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
  it("drops malformed and unbounded fields independently without inventing observations", () => {
    const result = fixedCanaryOutcome({ report: { phase: "native-mcp-proof", failure: {}, failureCode: ["EACCES"],
      failureName: { name: "Error" }, failureKind: true, failureStage: null, failureExitCode: 257,
      failureMessageSha256: "ab".repeat(9), activity: { permissions: -1, rejectedPermissions: "0", questions: 1.5,
        messageChunks: 65_537, toolEvents: 2049, privateField: "sk-synthetic-private-field" },
      toolEvidence: { privateOutput: "private tool output" }, stdout: "private stdout" } });
    expect(result.report).toHaveProperty("diagnostics", { phase: "native-mcp-proof" });
    expect(result.report).not.toHaveProperty("toolEvidence");
    expect(JSON.stringify(result)).not.toContain("private");
    for (const value of [NaN, Infinity, -Infinity, 1.5, -257, "1"]) {
      expect(fixedCanaryOutcome({ report: { failureExitCode: value } }).report).not.toHaveProperty("diagnostics");
    }
    for (const value of [NaN, Infinity, -Infinity, -1, 1.5, "0"]) {
      expect(fixedCanaryOutcome({ report: { activity: { toolEvents: value } } }).report).not.toHaveProperty("diagnostics");
    }
    expect(fixedCanaryOutcome({ report: { activity: { messageChunks: 2 } } }).report)
      .toHaveProperty("diagnostics", { activity: { messageChunks: 2 } });
  });
  it.each([-256, 0, 256])("retains a bounded exit and exact counter endpoints: %s", exitCode => {
    const result = fixedCanaryOutcome({ report: { failureExitCode: exitCode, activity: {
      permissions: 2048, rejectedPermissions: 2048, questions: 0, messageChunks: 65_536, toolEvents: 2048,
    } } });
    expect(result.report).toHaveProperty("diagnostics", { exitCode, activity: {
      permissions: 2048, rejectedPermissions: 2048, questions: 0, messageChunks: 65_536, toolEvents: 2048,
    } });
  });
  it("leaves historical reports and arbitrary diagnostic containers absent", () => {
    for (const report of [undefined, null, "private report", [], {}, { diagnostics: diagnosticReport() }]) {
      expect(fixedCanaryOutcome({ code: 1, retirement: 0, report }).report).not.toHaveProperty("diagnostics");
    }
  });
  it.each([
    { code: 0, retirement: 0, report: { qualified: true } },
    { code: 1, retirement: 0, report: { qualified: false } },
    { code: 1, retirement: 0, errorKind: "rate-limited", report: { qualified: false } },
    { code: 1, retirement: 0, report: { qualified: false, failureKind: "rate-limited" } },
    { code: 1, retirement: 0, report: { qualified: false, errorKind: "rate-limited" } },
    { code: 0, retirement: 0, report: { qualified: true, failureKind: "rate-limited" } },
    { code: 1, retirement: 0, report: { qualified: false, failureKind: " rate-limited" } },
  ])("does not change acceptance or exact rate-limit fields: %j", value => {
    const baseline = JSON.parse(JSON.stringify(fixedCanaryOutcome(value)));
    delete baseline.report.diagnostics;
    const result = fixedCanaryOutcome({ ...value, report: { ...diagnosticReport(), ...eventEvidence(), ...value.report } });
    expect(qualificationRateLimited(result)).toBe(qualificationRateLimited(value));
    const serialized = JSON.parse(JSON.stringify(result));
    expect(serialized.report).toHaveProperty("diagnostics");
    delete serialized.report.diagnostics;
    expect(serialized).toEqual(baseline);
  });
});

describe("release VM canary coordination", () => {
  it("saves bounded event diagnostics in the authenticated encrypted journal before failed cleanup and recovers without redispatch", async () => {
    const run: any = runFor(), lease = leaseFor(), owner = "a".repeat(24), key = "e".repeat(64);
    const state: any = { ...newHostedGeneration({ owner, identity: "synthetic event evidence" }),
      resources: { images: [] }, releaseRuns: [run] };
    lease.state = state;
    let sealed: string | undefined;
    lease.save.mockImplementation(async () => { sealed = sealReceipt(state, key); });
    const expected = { ...expectedDiagnostics(), ...eventEvidence() };
    const core = { allocate: vi.fn(async () => {}), ready: vi.fn(async () => true), start: vi.fn(async () => {}),
      poll: vi.fn(async () => ({ code: 1, retirement: 0, report: { version: 3, qualified: false, ...diagnosticReport(), ...eventEvidence(),
        rawInput: { private: "synthetic private native input" }, questions: [{ prompt: "synthetic private question" }] } })),
      retire: vi.fn(async () => {
        const saved = openReceipt(sealed!, key, owner).releaseRuns[0].canaries[0];
        expect(saved.phase).toBe("completed"); expect(saved.outcome.report.diagnostics).toEqual(expected);
        throw new Error("synthetic interrupted retirement");
      }) };
    const options = { pause: vi.fn(async () => {}), qualificationProfile: "full" as const };
    await expect(releaseCanaryAdapter(lease, run, connectionsFor("full"), core, options).qualify(image, "codex-chatgpt"))
      .rejects.toThrow("synthetic interrupted retirement");
    expect(sealed).not.toContain("native-mcp-tool-evidence");
    expect(() => openReceipt(sealed!, "f".repeat(64), owner)).toThrow("authenticate");
    const restored = openReceipt(sealed!, key, owner), replayLease = leaseFor();
    replayLease.state = restored;
    replayLease.save.mockImplementation(async () => { sealed = sealReceipt(restored, key); });
    core.retire.mockImplementation(async () => {});
    const adapter = releaseCanaryAdapter(replayLease, restored.releaseRuns[0], connectionsFor("full"), core, options);
    expect(await adapter.cleanup()).toBe(true);
    const result = await adapter.qualify(image, "codex-chatgpt");
    expect(result.outcome.report.diagnostics).toEqual(expected);
    expect(result.outcome.report.qualified).toBe(false);
    const saved = openReceipt(sealed!, key, owner).releaseRuns[0].canaries[0];
    expect(saved.retired).toBe(true); expect(saved.outcome.report.diagnostics).toEqual(expected);
    expect(JSON.stringify(saved.outcome)).not.toContain("private");
    expect(core.allocate).toHaveBeenCalledOnce(); expect(core.start).toHaveBeenCalledOnce(); expect(core.poll).toHaveBeenCalledOnce();
    expect(core.retire).toHaveBeenCalledTimes(2); expect(options.pause).not.toHaveBeenCalled();
  });
  it("saves diagnostics before interrupted retirement and preserves them on cleanup reentry without redispatch", async () => {
    const lease = leaseFor(), run: any = runFor();
    let storedRun: any;
    lease.save.mockImplementation(async () => { storedRun = JSON.parse(JSON.stringify(run)); });
    const core = { allocate: vi.fn(async () => {}), ready: vi.fn(async () => true), start: vi.fn(async () => {}),
      poll: vi.fn(async () => ({ code: 1, retirement: 0, report: { version: 3, qualified: false, ...diagnosticReport() } })),
      retire: vi.fn(async () => {
        expect(storedRun.canaries[0].phase).toBe("completed");
        expect(storedRun.canaries[0].outcome.report).toHaveProperty("diagnostics", expectedDiagnostics());
        throw new Error("synthetic interrupted retirement");
      }) };
    const options = { pause: vi.fn(async () => {}), qualificationProfile: "full" as const };
    await expect(releaseCanaryAdapter(lease, run, connectionsFor("full"), core, options).qualify(image, "codex-chatgpt"))
      .rejects.toThrow("synthetic interrupted retirement");
    const restored = JSON.parse(JSON.stringify(storedRun));
    const replayLease = leaseFor();
    core.retire.mockImplementation(async () => {});
    const adapter = releaseCanaryAdapter(replayLease, restored, connectionsFor("full"), core, options);
    expect(await adapter.cleanup()).toBe(true);
    const result = await adapter.qualify(image, "codex-chatgpt");
    expect(result.outcome.report).toHaveProperty("diagnostics", expectedDiagnostics());
    expect(result.outcome.report.qualified).toBe(false);
    expect(restored.canaries[0].retired).toBe(true);
    expect(core.allocate).toHaveBeenCalledOnce(); expect(core.start).toHaveBeenCalledOnce(); expect(core.poll).toHaveBeenCalledOnce();
    expect(core.retire).toHaveBeenCalledTimes(2); expect(options.pause).not.toHaveBeenCalled();
  });
  it.each(["forbidden", "uncertain"])("stops a %s startup failure without polling, replaying or inventing an outcome", async reason => {
    const lease = leaseFor(), run: any = runFor(), pause = vi.fn(async () => {});
    const core = { allocate: vi.fn(async () => {}), ready: vi.fn(async () => true),
      start: vi.fn(async () => { throw reason === "forbidden"
        ? new ReleaseCanaryPrelaunchError()
        : new Error("synthetic-private-start-diagnostic"); }),
      poll: vi.fn(async () => ({ running: true })), retire: vi.fn(async () => {}) };
    const adapter = releaseCanaryAdapter(lease, run, connectionsFor(), core, { pause, qualificationProfile: "smoke" });
    const error = await adapter.qualify(image, "claude-setup-token").catch(value => value);
    expect(error).toBeInstanceOf(PromotionError);
    expect(error.message).toContain(reason === "forbidden" ? "file.write" : "unconfirmed");
    expect(error.message).not.toContain("synthetic-private-start-diagnostic");
    expect(core.poll).not.toHaveBeenCalled(); expect(pause).not.toHaveBeenCalled();
    expect(run.canaries[0]).toMatchObject({ phase: "starting" });
    expect(run.canaries[0].outcome).toBeUndefined(); expect(run.canaries[0].retired).not.toBe(true);
    expect(core.start).toHaveBeenCalledOnce();
  });
  it("persists a definite prelaunch rejection separately from outcome and refuses polling on resume", async () => {
    const lease = leaseFor(), run: any = runFor();
    const core = { allocate: vi.fn(async () => {}), ready: vi.fn(async () => true),
      start: vi.fn(async () => { throw new ReleaseCanaryPrelaunchError(); }),
      poll: vi.fn(async () => ({ running: true })), retire: vi.fn(async () => {}) };
    const options = { qualificationProfile: "smoke" as const, pause: vi.fn(async () => {}) };
    await expect(releaseCanaryAdapter(lease, run, connectionsFor(), core, options).qualify(image, "claude-setup-token")).rejects.toThrow("file.write");
    expect(run.canaries[0].prelaunchFailure).toEqual({ version: 1, stage: "private-input-upload", classification: "forbidden", status: 403 });
    expect(run.canaries[0].outcome).toBeUndefined();
    await expect(releaseCanaryAdapter(lease, run, connectionsFor(), core, options).qualify(image, "claude-setup-token")).rejects.toThrow("file.write");
    expect(core.poll).not.toHaveBeenCalled(); expect(core.start).toHaveBeenCalledOnce();
  });
  it("attests the disposable clone before server dispatch, retains fixed evidence and physically deletes it", async () => {
    const lease = leaseFor(), run: any = runFor(), calls: string[] = [];
    const core = { allocate: vi.fn(async () => { calls.push("allocate"); }), ready: vi.fn(async () => { calls.push("attest"); return true; }),
      start: vi.fn(async (_job: any, input: any) => { calls.push("server-dispatch"); expect(input).not.toHaveProperty("material"); expect(input.qualificationProfile).toBe("smoke"); }),
      poll: vi.fn(async () => ({ code: 0, retirement: 0, report: { version: 3, qualified: true, qualificationProfile: "smoke", executionProfile: "zeros-cloud-native-v1",
        authority: "isolated-image-canary", qualifiedAt: new Date().toISOString(), identity: { ...image, contractSha256: "c".repeat(64), kind: "claude-setup-token", model: SMOKE_MODELS.claude }, checks: ["nativeTurn"] } })),
      retire: vi.fn(async () => { calls.push("delete"); }) };
    const adapter = releaseCanaryAdapter(lease, run, connectionsFor(), core, { pause: async () => {}, qualificationProfile: "smoke" });
    const result = await adapter.qualify(image, "claude-setup-token");
    expect(result.connection.kind).toBe("claude-setup-token"); expect(result.outcome.report.qualified).toBe(true);
    expect(calls).toEqual(["allocate", "attest", "server-dispatch", "delete"]);
    expect(JSON.stringify(run)).not.toContain("material");
  });
  it("polls a persisted lost dispatch instead of starting another credential-bearing VM", async () => {
    const lease = leaseFor(), job = { id: randomUUID(), ...workerConnections()[0], qualificationProfile: "full", phase: "starting", startedAt: Date.now(), image }, run: any = { ...runFor(), canaries: [job] };
    const core = { allocate: vi.fn(), ready: vi.fn(), start: vi.fn(), poll: vi.fn(async () => ({ code: 1, retirement: 0, report: { qualified: false, failureKind: "rate-limited" } })), retire: vi.fn() };
    const adapter = releaseCanaryAdapter(lease, run, connectionsFor("full"), core, { pause: async () => {} });
    expect((await adapter.qualify(image, "claude-setup-token")).outcome.report.failureKind).toBe("rate-limited");
    expect(core.start).not.toHaveBeenCalled(); expect(core.allocate).not.toHaveBeenCalled(); expect(core.retire).toHaveBeenCalledOnce();
  });
  it("fails closed before credential admission on stale attestation and refuses profile changes on recovery", async () => {
    const lease = leaseFor(), run: any = runFor(), core = { allocate: vi.fn(), ready: vi.fn(async () => "failed"), start: vi.fn(), retire: vi.fn() };
    const adapter = releaseCanaryAdapter(lease, run, connectionsFor(), core, { qualificationProfile: "smoke" });
    await expect(adapter.qualify(image, "claude-setup-token")).rejects.toThrow("attestation"); expect(core.start).not.toHaveBeenCalled();
    const full = releaseCanaryAdapter(lease, run, connectionsFor("full"), core, { qualificationProfile: "full" });
    await expect(full.qualify(image, "claude-setup-token")).rejects.toThrow("profile or model changed");
  });
  it("never reports cleanup success when physical deletion is uncertain", async () => {
    const run: any = { canaries: [{ id: randomUUID(), kind: "cursor-api-key" }] }, core = { retire: vi.fn(async () => { throw new Error("synthetic-private"); }) };
    expect(await releaseCanaryAdapter(leaseFor(), run, new Map(), core).cleanup()).toBe(false);
    expect(run.canaries[0].retired).not.toBe(true);
  });
});

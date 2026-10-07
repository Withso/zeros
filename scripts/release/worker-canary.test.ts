import { qualificationRateLimited } from "../dev-environment/native-agent-canary.mjs";
import { RELEASE_WORKER_IMAGES_RETIRED } from "../../apps/control-plane/src/cloud-workspaces/release-worker-retirement";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { releaseCanaryAdapter, fixedCanaryOutcome } from "./worker-canary";
import { releaseCanaryBroker, releaseCanaryConnections } from "./worker-broker";
import { SMOKE_MODELS } from "./worker-profile";
import { workerEnvironment, workerConnections } from "./worker-test-fixtures";
import { workerExecutionConfig } from "./worker-config";

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

describe("retired release VM canaries and retained cleanup", () => {
  it("refuses new qualification without allocating, staging input or changing its journal", async () => {
    const lease = leaseFor(), run = runFor();
    const core = { allocate: vi.fn(), ready: vi.fn(), start: vi.fn(), poll: vi.fn(), retire: vi.fn() };
    await expect(releaseCanaryAdapter(lease, run, connectionsFor(), core).qualify(image, "claude-setup-token"))
      .rejects.toThrow(RELEASE_WORKER_IMAGES_RETIRED);
    expect(run.canaries).toEqual([]); expect(lease.save).not.toHaveBeenCalled();
    for (const effect of Object.values(core)) expect(effect).not.toHaveBeenCalled();
  });
  it("retains historical diagnostics while retiring an existing job without native redispatch", async () => {
    const lease = leaseFor(), diagnostics = fixedCanaryOutcome({ report: diagnosticReport() }).report.diagnostics;
    const job = { id: "recorded-canary", phase: "completed", retired: false, outcome: { report: { diagnostics } } };
    const run = { canaries: [job] }, core = { retire: vi.fn(async () => {}), start: vi.fn(), allocate: vi.fn() };
    expect(await releaseCanaryAdapter(lease, run, new Map(), core).cleanup()).toBe(true);
    expect(job.retired).toBe(true); expect(job.outcome.report.diagnostics).toEqual(diagnostics);
    expect(core.retire).toHaveBeenCalledOnce(); expect(core.start).not.toHaveBeenCalled(); expect(core.allocate).not.toHaveBeenCalled();
  });
  it("never reports cleanup success when retirement is uncertain", async () => {
    const lease = leaseFor(), job = { id: "recorded-canary", retired: false }, run = { canaries: [job] };
    const core = { retire: vi.fn(async () => { throw new Error("synthetic retirement uncertainty"); }), start: vi.fn() };
    expect(await releaseCanaryAdapter(lease, run, new Map(), core).cleanup()).toBe(false);
    expect(job.retired).toBe(false); expect(core.start).not.toHaveBeenCalled();
  });
});

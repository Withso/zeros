import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudAgentAccessMaterial } from "@zeros/protocol/cloud-agent-execution";
import { cloudCommandFailureCode, cloudCommandFailureFromCode, CloudCommandFailureError } from "@zeros/protocol/cloud-commands";
import { CloudAgentLease } from "../../cloud-agent-lease";
import { AgentGateway } from "../../gateway";
import { AgentFailureError, type AgentAdapter } from "../../types";
import { testCloudBootFixture } from "../../__tests__/helpers/test-cloud-boot";
import { CloudExecutionBoundary } from "../cloud-execution-boundary";
import { CloudNativeBoundary } from "../cloud-native-boundary";
import { acquireCloudNativeHistory, CloudNativeHistoryError } from "../cloud-native-history";
import { createCloudNativeHome, type CloudNativeHome } from "../cloud-native-home";
import { portableCloudWorkloads } from "./helpers/portable-cloud-custody";
import { turnFailureForCard } from "../../../../renderer/features/agent/turn-failure";

const fixture = vi.hoisted(() => ({ historyRoot: "", configuration: {
  version: 4 as const, backend: "cloud-worker" as const, profile: "zeros-cloud-worker-v4" as const,
  uid: process.geteuid?.() ?? 0, gid: process.getegid?.() ?? 0,
  toolchain: { node: process.execPath, supervisor: process.cwd() + "/apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs" },
} }));
vi.mock("../cloud-worker-config", () => ({
  loadCloudWorkerConfiguration: () => fixture.configuration,
  isCloudWorkerConfiguration: (value: unknown) => value === fixture.configuration,
}));
vi.mock("../cloud-runtime-root.mjs", async original => ({
  ...await original<typeof import("../cloud-runtime-root.mjs")>(),
  resolveCloudRuntime: (await import("../../__tests__/helpers/test-cloud-runtime")).testCloudRuntime,
}));
vi.mock("../cloud-native-history", async original => {
  const module = await original<typeof import("../cloud-native-history")>();
  return { ...module, acquireCloudNativeHistory: (input: Parameters<typeof module.acquireCloudNativeHistory>[0]) =>
    module.acquireCloudNativeHistory({ ...input, root: fixture.historyRoot }) };
});
vi.mock("../../../git/github-native-broker", () => ({
  createNativeGithubBroker: vi.fn(async () => ({ env: {}, stopAndProve: async () => {} })),
}));

const roots: string[] = [], leases: CloudAgentLease[] = [];
const registries: ReturnType<typeof portableCloudWorkloads>[] = [];
const bootCleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const lease of leases.splice(0)) await lease.close();
  for (const cleanup of bootCleanups.splice(0).reverse()) await cleanup();
  for (const registry of registries.splice(0)) await registry.drain(registry.fence());
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function native(provider: "claude" | "codex" | "cursor", root?: string, conversationId = randomUUID()) {
  if (!root) { root = await mkdtemp(path.join(os.tmpdir(), "zeros-native-durability-")); roots.push(root); }
  vi.stubEnv("ZEROS_DATA_DIR", root);
  fixture.historyRoot = path.join(root, "native-agent-history");
  const admission = { executionId: randomUUID(), delegationId: randomUUID(), provider, model: "qualified-model",
    source: { kind: "session" as const, actorSessionId: randomUUID() } };
  const material = { kind: provider + "-api-key", apiKey: "synthetic-selected-key" } as CloudAgentAccessMaterial;
  const receipt = { leaseId: randomUUID(), expiresAt: new Date(Date.now() + 45_000).toISOString(), credentialVersion: 1 };
  const request = vi.fn(async (input: { kind: string }) => input.kind === "release" ? { released: true } :
    input.kind === "validate" ? receipt : { ...receipt, authorityId: "a".repeat(64),
      credentialKind: material.kind, provider, model: admission.model, material });
  const lease = await CloudAgentLease.admit(admission, request, new AbortController().signal, { onRetirementFailure: vi.fn() });
  leases.push(lease);
  const workloads = portableCloudWorkloads(fixture.configuration); registries.push(workloads);
  const boundary = new CloudExecutionBoundary({ configuration: fixture.configuration, workloads });
  const workload = await boundary.prepare({ executionId: admission.executionId, providerId: provider,
    actor: "agent-code", cwd: process.cwd(), workspaceRoot: process.cwd() });
  lease.attach(workload);
  const coordinator = await CloudNativeBoundary.prepare(lease, workload, conversationId);
  const home = coordinator.nativeHome.paths;
  const store = provider === "claude" ? path.join(home.claudeConfigDir, "projects") :
    provider === "codex" ? path.join(home.codexHome, "sessions") : path.join(home.cursorHome, "zeros-store");
  const durable = path.join(fixture.historyRoot, createHash("sha256").update(conversationId).digest("hex"), provider);
  return { coordinator, workload, lease, root, conversationId, store, durable };
}

async function bootNative() {
  const root = await mkdtemp(path.join(os.tmpdir(), "zeros-native-boot-history-")); roots.push(root);
  vi.stubEnv("ZEROS_DATA_DIR", root);
  fixture.historyRoot = path.join(root, "native-agent-history");
  const workloads = portableCloudWorkloads(fixture.configuration); registries.push(workloads);
  const boundary = new CloudExecutionBoundary({ projectRoot: root, configuration: fixture.configuration, workloads });
  const boot = await testCloudBootFixture(root);
  const gateway = new AgentGateway({ projectRoot: root, executionBoundary: boundary, cloudAgentExecutionFactory: boot.factory,
    events: { onSessionUpdate() {}, onPermissionRequest() {}, onQuestionRequest() {}, onAgentStderr() {}, onAgentExit() {} } });
  bootCleanups.push(async () => { try { await gateway.dispose(); } finally { await boot.close(); } });
  const start = vi.fn<AgentAdapter["newSession"]>(async options => {
    if (!options.executionId) throw new Error("Expected original execution identity");
    return { session: { executionId: options.executionId, sessionId: options.executionId }, initialize: { protocolVersion: 1 } };
  });
  const unexpected = async () => { throw new Error("Unexpected provider operation"); };
  const adapter: AgentAdapter = { agentId: "cursor", initialize: unexpected, listSessions: unexpected, newSession: start,
    loadSession: unexpected, prompt: unexpected, cancel: async () => {}, disposeSession: async () => {}, dispose: async () => {} };
  (gateway as unknown as { adapters: Map<string, AgentAdapter> }).adapters.set("cursor", adapter);
  const begin = (selection = boot.selection) => gateway.newSession("cursor", { cwd: root, conversationId: boot.input.conversationId,
    cloudExecution: selection, cloudExecutionId: selection.executionId });
  const durable = path.join(fixture.historyRoot, createHash("sha256").update(boot.input.conversationId).digest("hex"), "cursor");
  return { ...boot, gateway, boundary, root, durable, start, begin };
}

function bannerFor(error: unknown) {
  const failure = error instanceof AgentFailureError ? error.failure :
    cloudCommandFailureFromCode(cloudCommandFailureCode(error, "provider_start"));
  return turnFailureForCard({ events: [], turnId: "boot-history-refusal", status: "failed", fallback: failure });
}

function transcriptDirectory(home: CloudNativeHome, provider: "claude" | "codex" | "cursor") {
  if (provider === "claude") return path.join(home.paths.claudeConfigDir, "projects");
  if (provider === "codex") return path.join(home.paths.codexHome, "sessions");
  return path.join(home.paths.cursorHome, "zeros-store");
}

describe.skipIf(process.platform !== "linux")("native history durability before retirement", () => {
  it.each(["symlink", "hardlink"] as const)("keeps the repair banner through real boot preparation and gateway admission for SDK %s history", async kind => {
    const f = await bootNative(), initial = await f.begin();
    const homes = path.join(f.root, "native-agent-homes", createHash("sha256").update(f.input.conversationId).digest("hex"), "cursor");
    const store = path.join(homes, initial.executionId, "home", ".cursor", "zeros-store");
    expect(await realpath(store)).toBe(f.durable);
    await writeFile(path.join(store, "checkpoints.ndjson"), "boot-owner native history\n");
    const outside = path.join(f.root, "outside-entry"); await writeFile(outside, "untouched outside bytes");
    if (kind === "symlink") await symlink(outside, path.join(store, "unsafe-entry"));
    else await link(outside, path.join(store, "unsafe-entry"));
    await f.gateway.endSession("cursor", initial.executionId, { failClosed: true });
    const before = await readFile(path.join(f.durable, "checkpoints.ndjson"));
    const next = f.factory.selectBoot({ ...f.input, executionId: randomUUID() });
    const error: unknown = await f.begin(next).then(() => undefined, failure => failure);
    expect(error).toBeInstanceOf(CloudNativeHistoryError);
    expect(cloudCommandFailureCode(error, "provider_start")).toBe("cloud_containment_environment_setup_failed");
    expect(bannerFor(error)).toMatchObject({ kind: "protocol-error", message: "This conversation's saved history contains an unsupported file, so the agent can't resume it. The history is kept unchanged. Start a new conversation to continue." });
    expect(bannerFor(error)!.message).not.toContain(outside);
    expect(await readFile(path.join(f.durable, "checkpoints.ndjson"))).toEqual(before);
    expect(await readFile(outside, "utf8")).toBe("untouched outside bytes");
    expect(f.start).toHaveBeenCalledOnce();
    await rm(path.join(f.durable, "unsafe-entry"));
    const repaired = f.factory.selectBoot({ ...f.input, executionId: randomUUID() });
    await f.begin(repaired);
    expect(await readFile(path.join(f.durable, "checkpoints.ndjson"))).toEqual(before);
  });
  it("keeps arbitrary typed native errors generic during boot preparation", async () => {
    const f = await bootNative();
    const native = Object.assign(new AgentFailureError({ kind: "protocol-error", stage: "initialize",
      message: "Private native details /private/synthetic-provider-state" }), { code: "cloud_containment_environment_setup_failed" });
    vi.spyOn(CloudNativeBoundary, "prepareBoot").mockRejectedValueOnce(native);
    const error: unknown = await f.begin().then(() => undefined, failure => failure);
    expect(error).toMatchObject({ message: "Cloud native preparation failed", code: native.code });
    expect(error).not.toBeInstanceOf(AgentFailureError);
    expect(bannerFor(error)!.message).not.toContain("Private native details");
    expect(bannerFor(error)!.message).not.toContain("/private/");
    expect(f.start).not.toHaveBeenCalled();
  });
  it("keeps the boot repair banner and retirement evidence when the ORIGINAL Stop proof fails", async () => {
    const f = await bootNative(), initial = await f.begin();
    const store = path.join(f.root, "native-agent-homes", createHash("sha256").update(f.input.conversationId).digest("hex"),
      "cursor", initial.executionId, "home", ".cursor", "zeros-store");
    await writeFile(path.join(store, "checkpoints.ndjson"), "retained boot history\n");
    const outside = path.join(f.root, "outside-entry"); await writeFile(outside, "outside bytes");
    await symlink(outside, path.join(store, "unsafe-entry"));
    await f.gateway.endSession("cursor", initial.executionId, { failClosed: true });
    const before = await readFile(path.join(f.durable, "checkpoints.ndjson"));
    const prepare = f.boundary.prepare.bind(f.boundary);
    let restoreStop: (() => void) | undefined;
    vi.spyOn(f.boundary, "prepare").mockImplementationOnce(async (request, control) => {
      const workload = await prepare(request, control);
      const stop = vi.spyOn(workload, "stopAndProve").mockRejectedValue(Object.assign(new Error("Private retirement details"),
        { code: "cloud_containment_attestation_failed" }));
      restoreStop = () => { stop.mockRestore(); };
      return workload;
    });
    try {
      const next = f.factory.selectBoot({ ...f.input, executionId: randomUUID() });
      const error: unknown = await f.begin(next).then(() => undefined, failure => failure);
      expect(bannerFor(error)).toMatchObject({ message: "This conversation's saved history contains an unsupported file, so the agent can't resume it. The history is kept unchanged. Start a new conversation to continue." });
      expect(error).toBeInstanceOf(CloudNativeHistoryError);
      expect((error as Error & { cause?: AggregateError }).cause?.errors).toEqual([
        expect.objectContaining({ code: "cloud_containment_attestation_failed", message: "Cloud actor context is unavailable" }),
      ]);
      expect(bannerFor(error)!.message).not.toContain("Private retirement details");
      expect(await readFile(path.join(f.durable, "checkpoints.ndjson"))).toEqual(before);
      expect(await readFile(outside, "utf8")).toBe("outside bytes");
      expect(f.start).toHaveBeenCalledOnce();
    } finally { restoreStop?.(); }
  });
  it("retains the unsafe-history primary and a sanitized retirement failure when boot close also fails", async () => {
    const f = await bootNative(), refusal = new CloudNativeHistoryError();
    vi.spyOn(CloudNativeBoundary, "prepareBoot").mockRejectedValueOnce(refusal);
    const workload = await f.factory.launchBootSelection(f.selection, () => f.boundary.prepare({ executionId: f.selection.executionId,
      actor: "agent-code", providerId: "cursor", cwd: f.root, workspaceRoot: f.root }));
    const closing = vi.spyOn(workload, "stopAndProve").mockRejectedValueOnce(Object.assign(new Error("Private retirement details"),
      { code: "cloud_containment_attestation_failed" }));
    try {
      const error: unknown = await f.factory.prepareBoot({ selection: f.selection, workload, signal: new AbortController().signal })
        .then(() => undefined, failure => failure);
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError)) throw error;
      expect(error.errors[0]).toBe(refusal);
      expect(error.errors[1]).toMatchObject({ message: "Cloud actor context is unavailable", code: "cloud_containment_attestation_failed" });
      expect(cloudCommandFailureCode(error, "provider_start")).toBe(refusal.code);
      expect(error.message).toBe("Cloud native preparation failed");
    } finally { closing.mockRestore(); }
  });
  it("preserves only the dedicated FIRST history refusal across gateway boundary normalization", async () => {
    const f = await bootNative();
    const normalize = (f.gateway as unknown as { boundaryAdmissionFailure(provider: string, stage: "newSession", error: unknown): Error })
      .boundaryAdmissionFailure.bind(f.gateway);
    const refusal = new CloudNativeHistoryError();
    expect(normalize("cursor", "newSession", refusal)).toBe(refusal);
    const retirement = new CloudCommandFailureError({ stage: "containment", category: "attestation_failed" });
    const combined = Object.assign(new AggregateError([refusal, retirement], "Cloud native preparation failed"), { code: refusal.code });
    const error = normalize("cursor", "newSession", combined);
    expect(error).toBeInstanceOf(CloudNativeHistoryError);
    expect(bannerFor(error)).toMatchObject({ message: refusal.message });
    expect((error as Error & { cause?: AggregateError }).cause?.errors).toContain(retirement);
    const arbitrary = Object.assign(new AgentFailureError({ kind: "protocol-error", stage: "initialize", message: "Private native details" }),
      { code: refusal.code });
    expect(normalize("cursor", "newSession", arbitrary)).toBeInstanceOf(CloudCommandFailureError);
    expect(bannerFor(normalize("cursor", "newSession", arbitrary))!.message).not.toContain("Private native details");
    const reversed = Object.assign(new AggregateError([arbitrary, refusal], "Private native details"), { code: refusal.code });
    expect(normalize("cursor", "newSession", reversed)).toBeInstanceOf(CloudCommandFailureError);
  });
  it("recovers a synced native turn after the lock owner is killed without release or capture", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-native-abrupt-history-")); roots.push(root);
    const historyRoot = path.join(root, "history");
    const crashed = path.join(root, "native-agent-homes", createHash("sha256").update("abrupt").digest("hex"), "cursor", "crashed");
    const store = path.join(crashed, "home", ".cursor", "zeros-store");
    fixture.historyRoot = historyRoot;
    const writer = path.resolve("apps/desktop/src/engine/agents/containment/__tests__/fixtures/native-history-writer.mts");
    const child = spawn(process.execPath, ["--import", "tsx", writer, root, historyRoot],
      { cwd: process.cwd(), env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr!.on("data", chunk => { stderr = (stderr + String(chunk)).slice(0, 4096); });
    const exited = new Promise<NodeJS.Signals | null>(resolve => {
      child.once("exit", (_code, signal) => resolve(signal));
      child.once("error", () => resolve(null));
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        let output = "";
        child.stdout!.on("data", chunk => {
          output += String(chunk);
          if (output.includes("history-ready\n")) resolve();
        });
        child.once("error", reject);
        child.once("exit", () => reject(new Error("History writer exited before readiness: " + stderr)));
        timer = setTimeout(() => reject(new Error("History writer readiness timed out")), 10_000);
      });
      clearTimeout(timer);
      expect((await lstat(store)).isSymbolicLink()).toBe(true);
      const durable = await realpath(store), before = await readFile(path.join(durable, "checkpoints.ndjson"));
      expect(await readFile(path.join(crashed, "home", ".cursor", "auth.json"), "utf8")).toBe("synthetic orphan auth");
      child.kill("SIGKILL");
      expect(await exited).toBe("SIGKILL");
      const nativeHome = await createCloudNativeHome({ dataRoot: root, conversationId: "abrupt", provider: "cursor", executionId: "resumed" });
      const resumed = await acquireCloudNativeHistory({ root: historyRoot, conversationId: "abrupt", provider: "cursor",
        uid: process.geteuid!(), gid: process.getegid!(), nativeHome });
      try {
        expect(await readFile(path.join(resumed.mount.directory, "checkpoints.ndjson"), "utf8")).toBe("persisted before abrupt exit\n");
        await expect(lstat(crashed)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readFile(path.join(durable, "checkpoints.ndjson"))).toEqual(before);
        expect((await lstat(nativeHome.paths.directory)).isDirectory()).toBe(true);
      } finally { await resumed.release(); }
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  });
  it("reclaims only orphan execution HOMEs after acquiring the conversation lock", async () => {
    const active = await native("cursor");
    const orphan = await createCloudNativeHome({ dataRoot: active.root, conversationId: active.conversationId,
      provider: "cursor", executionId: "orphan" });
    await writeFile(path.join(orphan.paths.cursorHome, "auth.json"), "orphan auth");
    await symlink(active.durable, path.join(orphan.paths.cursorHome, "zeros-store"));
    const alias = path.join(path.dirname(orphan.paths.directory), "orphan-alias");
    await symlink(active.durable, alias);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sibling = await createCloudNativeHome({ dataRoot: active.root, conversationId: "different-conversation",
      provider: "cursor", executionId: "sibling" });
    await writeFile(path.join(active.store, "checkpoints.ndjson"), "history must survive HOME reclamation\n");
    const before = await readFile(path.join(active.durable, "checkpoints.ndjson"));
    await expect(native("cursor", active.root, active.conversationId)).rejects.toThrow(/active native execution/);
    expect(await readFile(path.join(orphan.paths.cursorHome, "auth.json"), "utf8")).toBe("orphan auth");
    expect((await lstat(active.coordinator.nativeHome.paths.directory)).isDirectory()).toBe(true);
    await active.lease.close();
    const resumed = await native("cursor", active.root, active.conversationId);
    await expect(lstat(orphan.paths.directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(alias)).isSymbolicLink()).toBe(true);
    expect(await readlink(alias)).toBe(active.durable);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith("[cloud-native-history] preserved 1 orphan execution HOME(s) with legacy or ambiguous transcripts; acquisition will continue");
    expect(await readFile(path.join(active.durable, "checkpoints.ndjson"))).toEqual(before);
    expect((await lstat(resumed.coordinator.nativeHome.paths.directory)).isDirectory()).toBe(true);
    expect((await lstat(sibling.paths.directory)).isDirectory()).toBe(true);
  });
  it.each(["claude", "codex", "cursor"] as const)("preserves uncaptured physical %s transcripts without refusing the next acquisition", async provider => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-native-legacy-orphan-")); roots.push(root);
    const conversationId = "original-conversation";
    fixture.historyRoot = path.join(root, "history");
    const input = { root: fixture.historyRoot, conversationId, provider, uid: process.geteuid!(), gid: process.getegid!() };
    const old = await createCloudNativeHome({ dataRoot: root, conversationId, provider, executionId: "old-execution" });
    const history = await acquireCloudNativeHistory(input);
    const canonical = history.mount.directory, oldTranscript = transcriptDirectory(old, provider);
    await writeFile(path.join(canonical, "saved-turn.jsonl"), "original durable turn\n");
    const durableBytes = await readFile(path.join(canonical, "saved-turn.jsonl"));
    await mkdir(oldTranscript, { mode: 0o700 });
    await history.materialize(oldTranscript);
    await writeFile(path.join(oldTranscript, "last-turn.jsonl"), "original uncaptured turn\n");
    await writeFile(path.join(old.paths.home, "auth.json"), "retained legacy auth");
    // A dead owner's kernel lock is gone; no clean Stop/capture occurred.
    await history.release();
    const home = await createCloudNativeHome({ dataRoot: root, conversationId, provider, executionId: "successor" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const next = await acquireCloudNativeHistory({ ...input, nativeHome: home });
    try {
      const retained = await Promise.all([oldTranscript, canonical].map(directory =>
        readFile(path.join(directory, "last-turn.jsonl"), "utf8").catch(() => null)));
      expect(retained).toContain("original uncaptured turn\n");
      expect(await readFile(path.join(oldTranscript, "last-turn.jsonl"), "utf8")).toBe("original uncaptured turn\n");
      expect(await readFile(path.join(oldTranscript, "saved-turn.jsonl"))).toEqual(durableBytes);
      expect(await readFile(path.join(old.paths.home, "auth.json"), "utf8")).toBe("retained legacy auth");
      expect(await readFile(path.join(next.mount.directory, "saved-turn.jsonl"))).toEqual(durableBytes);
      await expect(lstat(path.join(next.mount.directory, "last-turn.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await lstat(old.paths.directory)).isDirectory()).toBe(true);
      expect((await lstat(home.paths.directory)).isDirectory()).toBe(true);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith("[cloud-native-history] preserved 1 orphan execution HOME(s) with legacy or ambiguous transcripts; acquisition will continue");
    } finally { await next.release(); }
  });
  it.each(["claude", "codex", "cursor"] as const)("reclaims missing and empty %s transcript slots without following the canonical link", async provider => {
    const active = await native(provider);
    const before = Buffer.from("durable bytes survive safe orphan cleanup\n");
    await writeFile(path.join(active.durable, "saved-turn.jsonl"), before);
    const orphans: CloudNativeHome[] = [];
    for (const kind of ["missing", "empty", "canonical"] as const) {
      const orphan = await createCloudNativeHome({ dataRoot: active.root, conversationId: active.conversationId, provider, executionId: kind });
      orphans.push(orphan);
      await writeFile(path.join(orphan.paths.home, "auth.json"), "orphan auth");
      const transcript = transcriptDirectory(orphan, provider);
      if (kind === "empty") await mkdir(transcript, { mode: 0o700 });
      if (kind === "canonical") await symlink(active.durable, transcript);
    }
    await active.lease.close();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resumed = await native(provider, active.root, active.conversationId);
    for (const orphan of orphans) await expect(lstat(orphan.paths.directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(active.durable, "saved-turn.jsonl"))).toEqual(before);
    expect((await lstat(resumed.coordinator.nativeHome.paths.directory)).isDirectory()).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });
  it("preserves ambiguous orphan shapes with one path-free count and continues from durable history", async () => {
    const active = await native("cursor"), provider = "cursor" as const;
    const outside = path.join(active.root, "outside"); await mkdir(outside, { mode: 0o700 });
    await writeFile(path.join(outside, "last-turn.jsonl"), "outside turn\n");
    await writeFile(path.join(active.durable, "saved-turn.jsonl"), "canonical turn\n");
    const before = await readFile(path.join(active.durable, "saved-turn.jsonl"));
    const orphans: CloudNativeHome[] = [];
    for (const kind of ["foreign-link", "dangling-link", "file", "nested-empty", "parent-link"] as const) {
      const orphan = await createCloudNativeHome({ dataRoot: active.root, conversationId: active.conversationId, provider, executionId: kind });
      orphans.push(orphan);
      await writeFile(path.join(orphan.paths.home, "auth.json"), "ambiguous orphan auth");
      const transcript = transcriptDirectory(orphan, provider);
      if (kind === "foreign-link") await symlink(outside, transcript);
      if (kind === "dangling-link") await symlink(path.join(active.root, "missing-target"), transcript);
      if (kind === "file") await writeFile(transcript, "ambiguous native bytes");
      if (kind === "nested-empty") await mkdir(path.join(transcript, "nested"), { recursive: true, mode: 0o700 });
      if (kind === "parent-link") {
        await rm(orphan.paths.cursorHome, { recursive: true });
        await symlink(outside, orphan.paths.cursorHome);
      }
    }
    await active.lease.close();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resumed = await native(provider, active.root, active.conversationId);
    for (const orphan of orphans) {
      expect((await lstat(orphan.paths.directory)).isDirectory()).toBe(true);
      expect(await readFile(path.join(orphan.paths.home, "auth.json"), "utf8")).toBe("ambiguous orphan auth");
    }
    expect(await readlink(transcriptDirectory(orphans[0]!, provider))).toBe(outside);
    expect(await readlink(transcriptDirectory(orphans[1]!, provider))).toBe(path.join(active.root, "missing-target"));
    expect(await readFile(transcriptDirectory(orphans[2]!, provider), "utf8")).toBe("ambiguous native bytes");
    expect((await lstat(path.join(transcriptDirectory(orphans[3]!, provider), "nested"))).isDirectory()).toBe(true);
    expect(await readlink(orphans[4]!.paths.cursorHome)).toBe(outside);
    expect(await readFile(path.join(outside, "last-turn.jsonl"), "utf8")).toBe("outside turn\n");
    expect(await readFile(path.join(active.durable, "saved-turn.jsonl"))).toEqual(before);
    expect((await lstat(resumed.coordinator.nativeHome.paths.directory)).isDirectory()).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith("[cloud-native-history] preserved 5 orphan execution HOME(s) with legacy or ambiguous transcripts; acquisition will continue");
  });
  it.each(["symlink", "hardlink"] as const)("shows a typed repair banner for SDK-written %s history while retaining all bytes", async kind => {
    const first = await native("cursor");
    await writeFile(path.join(first.store, "checkpoints.ndjson"), "retained native history\n");
    const outside = path.join(first.root, "outside-entry"); await writeFile(outside, "outside bytes");
    const unsafe = path.join(first.store, "unsafe-entry");
    if (kind === "symlink") await symlink(outside, unsafe); else await link(outside, unsafe);
    await first.lease.close();
    const before = await readFile(path.join(first.durable, "checkpoints.ndjson"));
    for (let attempt = 0; attempt < 2; attempt++) {
      const error: unknown = await native("cursor", first.root, first.conversationId).then(() => undefined, failure => failure);
      expect(await readFile(path.join(first.durable, "checkpoints.ndjson"))).toEqual(before);
      expect(await readFile(outside, "utf8")).toBe("outside bytes");
      expect((await lstat(path.join(first.durable, "unsafe-entry"))).isSymbolicLink()).toBe(kind === "symlink");
      expect(error).toBeInstanceOf(AgentFailureError);
      if (!(error instanceof AgentFailureError)) throw error;
      expect(cloudCommandFailureCode(error, "provider_start")).toBe("cloud_containment_environment_setup_failed");
      const banner = turnFailureForCard({ events: [], turnId: "failed-turn", status: "failed", fallback: error.failure });
      expect(banner).toMatchObject({ kind: "protocol-error", message: "This conversation's saved history contains an unsupported file, so the agent can't resume it. The history is kept unchanged. Start a new conversation to continue." });
      expect(banner!.message).not.toContain(outside);
    }
    // Explicit repair clears only the bad entry; no empty replacement or lost
    // native session is fabricated by a failed acquisition.
    await rm(path.join(first.durable, "unsafe-entry"));
    const repaired = await native("cursor", first.root, first.conversationId);
    expect(await readFile(path.join(repaired.store, "checkpoints.ndjson"))).toEqual(before);
  });
  it.each(["claude", "codex", "cursor"] as const)("%s native writes reach durable history without Stop or capture", async provider => {
    const f = await native(provider);
    const file = await open(path.join(f.store, "checkpoints.ndjson"), "wx", 0o600);
    try { await file.writeFile("native turn before engine loss\n"); await file.sync(); }
    finally { await file.close(); }
    // A crash can skip every retirement callback. The committed native write
    // must already be in the canonical checkpoint scope.
    expect(await readFile(path.join(f.durable, "checkpoints.ndjson"), "utf8")).toBe("native turn before engine loss\n");
    expect((await lstat(f.coordinator.nativeHome.paths.home)).isSymbolicLink()).toBe(false);
    expect(f.coordinator.environment().HOME).toBe(f.coordinator.nativeHome.paths.home);
  });

  it("keeps authentication/configuration per execution while a later run resumes the same history", async () => {
    const first = await native("codex");
    const originalHome = first.coordinator.nativeHome.paths.home;
    await writeFile(path.join(first.coordinator.nativeHome.paths.codexHome, "auth.json"), "synthetic run-only auth");
    await writeFile(path.join(first.store, "rollout.jsonl"), "durable native turn\n");
    await first.lease.close();
    const next = await native("codex", first.root, first.conversationId);
    expect(next.coordinator.nativeHome.paths.home).not.toBe(originalHome);
    expect(await readFile(path.join(next.store, "rollout.jsonl"), "utf8")).toBe("durable native turn\n");
    await expect(readFile(path.join(next.coordinator.nativeHome.paths.codexHome, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(next.durable)).not.toContain("auth.json");
    await expect(lstat(first.coordinator.nativeHome.paths.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("holds the history lock and HOME until the original workload retirement proof settles", async () => {
    const f = await native("cursor");
    let resume!: () => void;
    const waiting = new Promise<void>(resolve => { resume = resolve; });
    const originalStop = f.workload.stopAndProve;
    vi.spyOn(f.workload, "stopAndProve").mockImplementation(async () => { await waiting; await originalStop(); });
    const closing = f.coordinator.stopAndProve();
    try {
      await expect(acquireCloudNativeHistory({ root: fixture.historyRoot, conversationId: f.conversationId,
        provider: "cursor", uid: process.geteuid!(), gid: process.getegid!() })).rejects.toThrow(/active native execution/);
      expect((await lstat(f.coordinator.nativeHome.paths.directory)).isDirectory()).toBe(true);
    } finally { resume(); await closing; }
    await expect(lstat(f.coordinator.nativeHome.paths.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains already durable bytes and the lock if Stop fails, then permits the original proof to retry", async () => {
    const f = await native("cursor");
    await writeFile(path.join(f.store, "checkpoints.ndjson"), "turn before failed Stop\n");
    const originalStop = f.workload.stopAndProve;
    vi.spyOn(f.workload, "stopAndProve").mockImplementationOnce(async () => { throw new Error("retirement proof unavailable"); }).mockImplementation(originalStop);
    await expect(f.coordinator.stopAndProve()).rejects.toThrow(/retirement proof unavailable/);
    expect(await readFile(path.join(f.durable, "checkpoints.ndjson"), "utf8")).toBe("turn before failed Stop\n");
    expect((await lstat(f.coordinator.nativeHome.paths.directory)).isDirectory()).toBe(true);
    await expect(acquireCloudNativeHistory({ root: fixture.historyRoot, conversationId: f.conversationId,
      provider: "cursor", uid: process.geteuid!(), gid: process.getegid!() })).rejects.toThrow(/active native execution/);
    await f.coordinator.stopAndProve();
  });
});

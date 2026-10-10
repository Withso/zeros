import { generateKeyPairSync, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, readlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { BridgeClient } from "../lib/bridge-client";
import { createFixtureControlPlane } from "./fixture-control-plane/server";
import { HarnessFailure, safeTrace, selectProviders, diagnoseHarnessFailure, type Provider } from "./assertions";
import { authenticateEngine, driveTurn, selectEngineWorkspace, keepActorAlive } from "./driver";
import { assertInstalledHarnessRuntimeCurrent, awaitInstalledHarnessRetirement, createHarnessClose, fixtureCredentialEnv, fixtureOuterArguments, fixtureTransportToken,
  parseInstalledHarnessHandover, readInstalledHarnessOperator, readInstalledHarnessRuntime, readRootHarnessFile,
  requireInstalledCommonIdentity, requireInstalledTreeReceipt, selectHarnessRuntimeMode,
  type InstalledHarnessRetirementEvidence } from "./runtime-contract";
import { observedInstalledHarnessChildRoot, observedInstalledRootIdentity, requireInstalledHarnessChildRoot, type InstalledRootIdentity } from "./identity";
import { buildSourceRuntime, createFixtureTls } from "./runtime";
import { awaitRetirement, summarizeRetirement, type NamespaceOutcome, type RetirementEvidence } from "./retirement";
import { fixtureAgentFileMatches } from "./artifacts";
import { requireFixtureEngineIdentity, type FixtureEngineIdentity } from "./projection";
import type { prepareUbuntuRootfs, UbuntuFixtureFailure } from "./ubuntu-rootfs";
import { measureCurrentTurn } from "./baseline";
import { measureBootOwnerConversation } from "./conversation-measurement";
import { selectMeasurementOptions } from "./operator-options";
import { configureFixtureMeasurement, createMeasurementReadyGate } from "./operator-boot";
import { harnessFailureSite } from "./failure-site";

const sourceRoot = process.cwd();
const args = process.argv.slice(2);
const runtimeMode = selectHarnessRuntimeMode(args);
const installedHandover = runtimeMode.mode === "installed"
  ? parseInstalledHarnessHandover(JSON.parse(readRootHarnessFile(runtimeMode.handoverFile, 16 * 1024, 0o600).toString("utf8"))) : undefined;
const installedRuntime = installedHandover ? await readInstalledHarnessRuntime(installedHandover) : undefined;
const installedRoot = installedRuntime ? observedInstalledRootIdentity(installedRuntime.active) : undefined;
const installedOperator = installedRuntime
  ? readInstalledHarnessOperator(fileURLToPath(import.meta.url), installedRuntime.sourceCommit, installedRuntime.runtime) : undefined;
const assertInstalledCurrent = () => {
  if (!installedHandover || !installedRuntime || !installedRoot) throw new HarnessFailure("fixture_contract_invalid");
  assertInstalledHarnessRuntimeCurrent(installedHandover, installedRuntime.activeRecordSha256);
  observedInstalledRootIdentity(installedRuntime.active, installedRoot);
};
function option(name: string, fallback: string) { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1] ?? ""; }
const providers = selectProviders(option("--providers", "claude,codex,cursor").split(","));
const mode = option("--credentials", "invalid");
if (!["invalid", "environment"].includes(mode)) throw new HarnessFailure("operator_input_invalid");
const measurement = selectMeasurementOptions(installedRuntime && !args.includes("--measurement")
  ? [...args, "--measurement", "boot-owner"] : args, mode);
const credentialEnv = fixtureCredentialEnv(mode as "invalid" | "environment", process.env, args.includes("--owner-authorized-provider-turns"));
const scope = option("--scope", "strict");
if (!["strict", "cpu-private-pid-fixture"].includes(scope)) throw new HarnessFailure("operator_input_invalid");
const linuxView = option("--linux-view", "host");
if (!["host", "ubuntu-24.04"].includes(linuxView)) throw new HarnessFailure("operator_input_invalid");
const scratch = installedOperator ? path.join(installedOperator.directory, `evidence-${randomUUID()}`)
  : path.join(sourceRoot, ".context/agents-fix/scratch/W5", `e2e-${Date.now()}-${randomUUID().slice(0, 8)}`);
await mkdir(scratch, { recursive: !installedOperator, mode: 0o700 });
const trace: Record<string, unknown>[] = [];
function stage(input: Record<string, unknown>) { const row = safeTrace(input); trace.push(row); process.stdout.write(`${JSON.stringify(row)}\n`); }
const models: Record<Provider, string> = { claude: option("--claude-model", "claude-sonnet-4-6"), codex: option("--codex-model", "gpt-5.4"), cursor: option("--cursor-model", "sonnet-4.6") };
let child: ChildProcess | undefined, client: BridgeClient | undefined;
let stopHeartbeat: (() => void) | undefined;
let cp: ReturnType<typeof createFixtureControlPlane> | undefined;
let activeStage = installedRuntime ? "validation" : "build";
let failureDiagnosis: ReturnType<typeof diagnoseHarnessFailure> | undefined;
let failureSite: ReturnType<typeof harnessFailureSite>;
let linuxFixture: Awaited<ReturnType<typeof prepareUbuntuRootfs>> | undefined;
let ubuntuModule: typeof import("./ubuntu-rootfs") | undefined;
let ubuntuBootstrapFailure: UbuntuFixtureFailure["bootstrap"] | undefined;
let childClosed: Promise<NamespaceOutcome> | undefined;
let installedDeadline: ReturnType<typeof setTimeout> | undefined;
const retirement: RetirementEvidence = {};
const installedRetirement: InstalledHarnessRetirementEvidence = {};
let installedChildRoot: InstalledRootIdentity | undefined;
let installedCleanup: Awaited<ReturnType<typeof awaitInstalledHarnessRetirement>> | undefined;
let retirementSummary: ReturnType<typeof summarizeRetirement> = { status: "pending", pidNamespaceRetired: false };
let fixtureLedger: ReturnType<ReturnType<typeof createFixtureControlPlane>["inspect"]> | undefined;
const inspections = new Map<string, { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
let namespaceFailure: Record<string, unknown> | undefined;
let namespaceExit: Record<string, unknown> | undefined;
const namespaceFailures: Record<string, unknown>[] = [];
let namespacePassed = false;
let engineIdentity: FixtureEngineIdentity | undefined;
let procIdentity: { filesystemType: number; ownPid1: true } | undefined;
const results: Record<string, unknown>[] = [];
const pending = ["basic_streaming", "native_read_edit_shell", "mcp_0canvas_success", "second_turn_resume", "stop_mid_tool", "spawn_failure"];
const port = await new Promise<number>((resolve, reject) => { const server = createServer(); server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const address = server.address(); if (!address || typeof address === "string") return reject(new HarnessFailure("operator_input_invalid"));
    server.close(error => error ? reject(error) : resolve(address.port)); }); });
function inspect(op = "inspect", params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { inspections.delete(id); reject(new HarnessFailure("fixture_inspection_failed")); }, 5000);
    inspections.set(id, { resolve, reject, timer });
    child?.stdin?.write(`${JSON.stringify({ ...params, op, id })}\n`);
  });
}
const close = createHarnessClose(async () => {
  stopHeartbeat?.();
  client?.close();
  if (child?.exitCode === null && !child.signalCode) {
    child.stdin?.write(`${JSON.stringify({ op: "shutdown" })}\n`);
    child.stdin?.end();
    const signalChild = (signal: NodeJS.Signals) => {
      if (child?.exitCode !== null || child?.signalCode || !child?.pid) return;
      try {
        if (installedRuntime && installedRoot) {
          assertInstalledCurrent();
          if (!installedChildRoot) throw new HarnessFailure("cleanup_unconfirmed");
          observedInstalledHarnessChildRoot(installedRuntime.active, installedRoot, child.pid, installedChildRoot);
        }
        child.kill(signal);
      } catch { installedRetirement.cleanupFailed = true; }
    };
    const timeout = setTimeout(() => signalChild("SIGTERM"), installedRuntime ? 25_000 : 12_000);
    const force = setTimeout(() => signalChild("SIGKILL"), installedRuntime ? 35_000 : 17_000);
    try { await childClosed; } finally { clearTimeout(timeout); clearTimeout(force); }
  }
  for (const item of inspections.values()) { clearTimeout(item.timer); item.reject(new HarnessFailure("cleanup_unconfirmed")); }
  inspections.clear();
  fixtureLedger = cp?.inspect();
  try { if (childClosed) {
    if (installedRuntime) {
      installedCleanup = await awaitInstalledHarnessRetirement(childClosed, () => installedRetirement, () => {
        assertInstalledCurrent();
        readInstalledHarnessOperator(fileURLToPath(import.meta.url), installedRuntime.sourceCommit, installedRuntime.runtime);
      });
      retirementSummary = { status: "passed", pidNamespaceRetired: false };
    } else retirementSummary = summarizeRetirement(await awaitRetirement(childClosed, () => retirement), retirement);
  } }
  finally { await cp?.close(); }
});
const closeFromSignal = () => {
  void close().catch(() => { if (installedRuntime) installedRetirement.cleanupFailed = true; process.exitCode = 1; });
};
process.once("SIGINT", closeFromSignal);
process.once("SIGTERM", closeFromSignal);
try {
  if (installedRuntime) installedDeadline = setTimeout(() => {
    namespaceFailure = { code: "turn_timeout" }; process.exitCode = 1;
    void close().catch(() => { installedRetirement.cleanupFailed = true; });
  }, 480_000);
  if (linuxView === "ubuntu-24.04") { ubuntuModule = await import("./ubuntu-rootfs");
    linuxFixture = await ubuntuModule.prepareUbuntuRootfs(sourceRoot, scratch);
    stage({ stage: "build", status: "observed", count: linuxFixture.manifest.packageCount }); }
  const runtime = installedRuntime && installedOperator
    ? { descriptor: { active: installedRuntime.active }, entry: installedOperator.entry, stage: null }
    : await buildSourceRuntime(sourceRoot, scratch);
  stage({ stage: installedRuntime ? "validation" : "build", status: "passed" });
  activeStage = "control_plane";
  const tls = await createFixtureTls(scratch);
  cp = createFixtureControlPlane({ tls, credentials: { mode: "environment", env: credentialEnv },
    requestDelay: measurement.requestDelay,
    allowedModels: Object.fromEntries(providers.map(provider => [provider, [models[provider]]])) });
  configureFixtureMeasurement(cp, measurement.measurement);
  const { runtimeId, manifestSha256, baseCompatibilityId, installerReceiptSha256, bootId, supervisorSessionId } = runtime.descriptor.active;
  cp.configureRuntime({ profile: "zeros-cloud-worker-v4", runtimeId, manifestSha256, baseCompatibilityId, installerReceiptSha256, bootId, supervisorSessionId });
  const { baseUrl } = await cp.start();
  stage({ stage: "control_plane", status: "passed" });
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const source = { ZEROS_CLOUD_RUNTIME_B64: Buffer.from(JSON.stringify(cp.runtimeConfig())).toString("base64url"),
      ZEROS_CLOUD_PORT: String(port), ZEROS_CLOUD_OWNER_SUB: cp.actor.userId, ZEROS_REQUIRE_ACCOUNT: "1", ZEROS_REQUIRE_EXACT_MODEL: "1",
      ZEROS_CLOUD_TOKEN: fixtureTransportToken(),
      ZEROS_ACCOUNT_JWT_PUBLIC_KEY: publicKey.export({ type: "spki", format: "pem" }).toString(),
      ZEROS_ACCOUNT_JWT_AUD: installedRuntime ? "installed-runtime-fixture" : "source-mode-fixture",
      ZEROS_ACCOUNT_JWT_ISS: installedRuntime ? "https://installed-runtime-fixture.invalid" : "https://source-mode-fixture.invalid" };
  const config = installedRuntime ? { mode: "installed", handover: installedHandover, ca: tls.ca, source }
    : { outerMountNamespace: await readlink("/proc/self/ns/mnt"), outerPidNamespace: await readlink("/proc/self/ns/pid"), scope,
      scratch, stage: runtime.stage, ca: tls.ca, descriptor: runtime.descriptor, sourceFixtureLinux: linuxView,
      mcp: JSON.stringify({ mcpServers: { "0canvas": { type: "http", url: "http://localhost:24193/mcp" } } }), source };
  const configPath = path.join(scratch, "namespace-config.json");
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  activeStage = "namespace";
  if (installedRuntime && installedOperator && installedRoot) {
    assertInstalledCurrent();
    child = spawn(installedRuntime.runtime.node, [runtime.entry, configPath, "--installed"],
      { cwd: installedOperator.directory, env: { PATH: "/usr/bin:/bin", LANG: "C" }, stdio: ["pipe", "pipe", "pipe"] });
    child.once("spawn", () => {
      try { installedChildRoot = observedInstalledHarnessChildRoot(installedRuntime.active, installedRoot, child!.pid!); }
      catch { installedRetirement.cleanupFailed = true; namespaceFailure = { code: "fixture_contract_invalid" }; }
    });
  } else {
    child = spawn("sudo", ["unshare", "--mount", "--propagation", "private", "--pid", "--fork", "--mount-proc", "/usr/bin/bwrap",
      ...fixtureOuterArguments(sourceRoot, process.execPath, runtime.entry, configPath, linuxFixture?.root)],
      { cwd: sourceRoot, env: { PATH: process.env.PATH, LANG: "C.UTF-8" }, stdio: ["pipe", "pipe", "pipe"] });
  }
  childClosed = new Promise<NamespaceOutcome>((resolve, reject) => { child!.once("error", () => {
    if (installedRuntime) { installedRetirement.cleanupFailed = true; namespaceFailure = { code: "namespace_launch_failed" }; }
    else reject(new HarnessFailure("namespace_launch_failed"));
  });
    child!.once("close", (code, signal) => resolve({ code, signal })); });
  const reader = createInterface({ input: child.stdout! });
  reader.on("line", line => {
    try { const message = JSON.parse(line);
      if (message.type === "namespace") {
        if (message.runtimeId !== runtime.descriptor.active.runtimeId) throw new HarnessFailure("fixture_contract_invalid");
        namespacePassed = true; stage({ stage: "namespace", status: "observed" });
      }
      if (installedRuntime && installedRoot) {
        if (message.type === "installed-root") {
          installedChildRoot = requireInstalledHarnessChildRoot(message.root, installedRuntime.active, installedRoot, child!.pid!, installedChildRoot);
        }
        if (message.type === "prepared") {
          if (!installedChildRoot || installedRetirement.common) throw new HarnessFailure("cleanup_unconfirmed");
          installedRetirement.common = requireInstalledCommonIdentity(message.common);
        }
        if (message.type === "retired") {
          if (!installedChildRoot || !installedRetirement.common || installedRetirement.retired) throw new HarnessFailure("cleanup_unconfirmed");
          requireInstalledHarnessChildRoot(message.root, installedRuntime.active, installedRoot, child!.pid!, installedChildRoot);
          installedRetirement.retired = { launcherExit: message.installed?.launcherExit,
            receipt: requireInstalledTreeReceipt(installedRetirement.common, message.installed?.receipt) };
        }
        if (message.type === "failure" && message.code === "cleanup_unconfirmed") installedRetirement.cleanupFailed = true;
      }
      if (message.type === "proc") {
        if (message.filesystemType !== 0x9fa0 || message.ownPid1 !== true) throw new HarnessFailure("private_proc_view_required");
        procIdentity = { filesystemType: message.filesystemType, ownPid1: true };
      }
      if (message.type === "exit") namespaceExit = message;
      if (message.type === "failure" || message.type === "exit" && message.code !== 0) namespaceFailure = message;
      if (message.type === "failure" && namespaceFailures.length < 8) namespaceFailures.push(message);
      if (message.type === "failure") retirement.failure = true;
      if (!installedRuntime && message.type === "retired") retirement.proof = { engineScopeEmpty: message.engineScopeEmpty === true,
        cgroupRemoved: message.cgroupRemoved === true, namespacePrivate: message.namespacePrivate === true,
        scopeKind: message.scopeKind === "cpu-private-pid-fixture" ? "cpu-private-pid-fixture" : "strict",
        pidNamespaceProcessesEmpty: message.pidNamespaceProcessesEmpty === true, ownCpuCgroupRemoved: message.ownCpuCgroupRemoved === true };
      if (message.type === "inspection") { const item = inspections.get(message.id); if (item) { inspections.delete(message.id); clearTimeout(item.timer); item.resolve(message); } }
    } catch { namespaceFailure = { code: "fixture_contract_invalid" }; if (installedRuntime) installedRetirement.cleanupFailed = true; }
  });
  // Never forward raw engine/sudo output (authority, argv, provider prose).
  child.stderr!.resume();
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (namespaceFailure || child.exitCode !== null || child.signalCode) throw new HarnessFailure("namespace_launch_failed");
    try { const response = await fetch(`http://127.0.0.1:${port}/internal/readiness`, { headers: { "x-zeros-readiness-token": cp.runtimeTokens.readinessToken }, signal: AbortSignal.timeout(1500) });
      if (response.ok) { const body = await response.json() as { ready?: boolean; engine?: { instanceId?: string } };
        if (body.ready === true && body.engine?.instanceId === cp.identity.engineInstanceId && namespacePassed) break; }
    } catch { /* Socket not listening yet; no authority fallback. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (Date.now() >= deadline) throw new HarnessFailure("engine_ready_timeout");
  activeStage = "authentication";
  const readyGate = createMeasurementReadyGate(cp, measurement.measurement);
  client = new BridgeClient({ url: `ws://127.0.0.1:${port}/ws`, cloudToken: cp.actorGrantToken, requestTimeoutMs: 20_000,
    ...(measurement.measurement === "boot-owner" ? { verifyEngineReady: readyGate.verify } : {}) });
  await authenticateEngine(client, () => {});
  stopHeartbeat = keepActorAlive(client);
  stage({ stage: "authentication", status: "passed" });
  engineIdentity = requireFixtureEngineIdentity(await inspect("identity"));
  stage({ stage: "namespace", status: "passed" });
  const engineWorkspaceId = selectEngineWorkspace(await client.request("workspace.list"), cp.identity);
  for (const provider of providers) {
    if (installedRuntime) { assertInstalledCurrent(); if (namespaceFailure) throw new HarnessFailure("turn_timeout"); }
    activeStage = "receipt";
    if (measurement.measurement === "boot-owner") {
      await measureBootOwnerConversation(client, { fixture: cp, engineReady: readyGate.ready(),
        localProof: async (commandId, conversationId) => (await inspect("mirror-proof", { commandId, conversationId, scope: cp!.activeBootScope() })).proof,
        engineWorkspaceId, provider, model: models[provider], conversationId: randomUUID(), userMessageId: randomUUID(),
        permissionMode: provider === "claude" ? "bypass" : provider === "codex" ? "full-access" : "agent",
        prompt: "Reply with the exact text fixture stream 73491.", expected: "auth-failure", timeoutMs: 120_000 },
      ({ conversationId, turnKind, turnOrdinal, measurement: baseline }) => {
        results.push({ provider, case: "boot_owner_invalid_auth_measurement", conversationId, turnKind, turnOrdinal, ...baseline });
        stage({ stage: "receipt", status: "passed", provider, ...(baseline.turn.resultCode ? { code: baseline.turn.resultCode } : {}),
          liveDeltaBytes: baseline.turn.liveDeltaBytes, replayDeltaBytes: baseline.turn.replayDeltaBytes, count: baseline.sendWindow.ingressCount });
      });
      continue;
    }
    if (measurement.measurement === "current") {
      const baseline = await measureCurrentTurn(client, { fixture: cp, baseUrl, ca: await readFile(tls.ca),
        engineWorkspaceId, provider, model: models[provider], conversationId: randomUUID(), userMessageId: randomUUID(),
        permissionMode: provider === "claude" ? "bypass" : provider === "codex" ? "full-access" : "agent",
        prompt: "Reply with the exact text fixture stream 73491.", expected: "auth-failure", timeoutMs: 120_000 });
      results.push({ provider, case: "current_invalid_auth_measurement", ...baseline });
      stage({ stage: "receipt", status: "passed", provider, ...(baseline.turn.resultCode ? { code: baseline.turn.resultCode } : {}),
        liveDeltaBytes: baseline.turn.liveDeltaBytes, replayDeltaBytes: baseline.turn.replayDeltaBytes, count: baseline.sendWindow.ingressCount });
      continue;
    }
    const common = { workspaceId: engineWorkspaceId, provider, model: models[provider], requireCloudTurnProtocol: true,
      permissionMode: provider === "claude" ? "bypass" : provider === "codex" ? "full-access" : "agent", replayEvents: () => cp!.readEvents(), timeoutMs: 120_000 };
    const denied = await driveTurn(client, { ...common, conversationId: `fixture-${provider}-denied-${randomUUID()}`, commandId: randomUUID(),
      grantId: cp.invalidDelegationId, prompt: "Reply with one word.", expected: "admission-failure" });
    cp.assertTerminalConsistency(denied.commandId);
    results.push({ provider, case: "admission_failure", ...denied });
    stage({ stage: "admission", status: "passed", provider, code: denied.resultCode });
    const conversationId = `fixture-${provider}-${randomUUID()}`;
    const turn = await driveTurn(client, { ...common, conversationId, commandId: randomUUID(), grantId: cp.delegationId(provider),
      prompt: "Reply with the exact text fixture stream 73491.", expected: mode === "invalid" ? "auth-failure" : "success" });
    cp.assertTerminalConsistency(turn.commandId);
    results.push({ provider, case: mode === "invalid" ? "invalid_auth" : "basic_streaming", ...turn });
    stage({ stage: "receipt", status: "passed", provider, ...(turn.resultCode ? { code: turn.resultCode } : {}), liveDeltaBytes: turn.liveDeltaBytes, replayDeltaBytes: turn.replayDeltaBytes });
    if (mode === "environment") {
      const artifacts = await inspect("prepare-native", { nonce: randomUUID() }) as { nonce: string; outputHash: string; startHash: string; shellHash: string };
      const baseline = (await inspect()).files as Record<string, unknown>;
      if (["tool-output.txt", "shell-uid.txt", "stop-started.txt", "stop-finished.txt"].some(name => baseline[name] !== null)) throw new HarnessFailure("fixture_inspection_failed");
      const native = await driveTurn(client, { ...common, existing: true, conversationId, commandId: randomUUID(), grantId: cp.delegationId(provider), expected: "success",
        prompt: `Use native Read to read tool-input.txt; use native Edit/Write to create tool-output.txt with its entire contents followed by fixture native edit ${artifacts.nonce} and a newline. Run shell: printf 'fixture native shell ${artifacts.nonce}\\n' > shell-uid.txt; id -u >> shell-uid.txt. Then reply fixture tools done. Do not call MCP.` });
      const inspection = await inspect(); const files = inspection.files as Record<string, unknown>;
      if (!["read", "edit", "execute"].every(kind => native.toolKinds.includes(kind)) ||
        !fixtureAgentFileMatches(files["tool-output.txt"], artifacts.outputHash) || !fixtureAgentFileMatches(files["shell-uid.txt"], artifacts.shellHash))
        throw new HarnessFailure("tool_bytes_mismatch");
      cp.assertTerminalConsistency(native.commandId);
      results.push({ provider, case: "native_read_edit_shell_and_resume", ...native,
        toolIdentity: { namespaceUid: 10003, vmUid: 10003, vmGid: 10003 } });
      const stopped = await driveTurn(client, { ...common, existing: true, conversationId, commandId: randomUUID(), grantId: cp.delegationId(provider), expected: "cancelled", stopMidTool: true,
        toolStarted: async () => { const files = (await inspect()).files as Record<string, unknown>; return fixtureAgentFileMatches(files["stop-started.txt"], artifacts.startHash); },
        prompt: `Run one shell command: printf 'fixture native start ${artifacts.nonce}\\n' > stop-started.txt; sleep 30; printf 'finished\\n' > stop-finished.txt. Then reply done.` });
      const stopFiles = (await inspect()).files as Record<string, unknown>;
      if (stopFiles["stop-finished.txt"] !== null) throw new HarnessFailure("stop_evidence_missing");
      cp.assertTerminalConsistency(stopped.commandId);
      results.push({ provider, case: "stop_mid_tool", ...stopped });
    }
  }
} catch (error) {
  failureDiagnosis = diagnoseHarnessFailure(error);
  failureSite = harnessFailureSite(error);
  if (ubuntuModule && error instanceof ubuntuModule.UbuntuFixtureFailure) ubuntuBootstrapFailure = error.bootstrap;
  stage({ stage: activeStage, status: "failed", code: failureDiagnosis.code });
  process.exitCode = 1;
} finally {
  try { await close(); stage({ stage: "retirement", status: retirementSummary.status }); }
  catch { retirementSummary = { status: "failed", pidNamespaceRetired: false };
    stage({ stage: "retirement", status: "failed", code: "cleanup_unconfirmed" }); process.exitCode = 1; }
  clearTimeout(installedDeadline);
  const report = { ...(installedRuntime && installedOperator && installedHandover ? {
    schema: "zeros.installed-runtime-agent-e2e/v1", evidenceKind: "installed_runtime_fixture",
    label: "INSTALLED-RUNTIME, invalid-auth fixture", resourceLimits: "original installed runtime controls; kernel qualification separate",
    installation: { sandboxId: installedHandover.sandboxId, active: installedRuntime.active,
      activeRecordSha256: installedRuntime.activeRecordSha256, sourceCommit: installedRuntime.sourceCommit,
      archiveSha256: installedRuntime.archiveSha256 },
    operator: installedOperator.inventory, root: installedRoot, ...(installedChildRoot ? { operatorChildRoot: installedChildRoot } : {}),
    commonTreeRetired: !!installedCleanup, ...(installedCleanup ? { installedRetirement: installedCleanup } : {}), providerQualified: false,
  } : { schema: "zeros.source-mode-agent-e2e/v1", evidenceKind: "source_mode_fixture",
    label: scope === "strict" ? "SOURCE-MODE, strict cgroup fixture" : "PARTIAL CLI/bridge evidence — cgroup/resource qualification pending",
    resourceLimits: scope === "strict" ? "strict" : "SOURCE-MODE, no memory/pids cgroup limits" }), qualified: false, credentials: mode, scope, linuxView,
    ...(linuxFixture ? { linuxFixture: linuxFixture.manifest } : {}),
    pidNamespaceRetired: retirementSummary.pidNamespaceRetired,
    cgroupResourceQualified: false,
    outcome: process.exitCode ? "failed" : mode === "invalid" ? "pre_auth_only" : "response_cases_passed_matrix_pending", providers, results,
    measurement: measurement.measurement, fixtureRequestDelayMs: measurement.requestDelayMs,
    pending: mode === "invalid" ? pending : ["spawn_failure", "mcp_0canvas_success", "excluded_project_plugin_mcp_launch_markers"], trace,
    ...(namespaceFailure ? { namespace: { code: namespaceFailure.code, diagnostics: namespaceFailure.diagnostics, errno: namespaceFailure.errno, step: namespaceFailure.step, rootChecks: namespaceFailure.rootChecks } } : {}),
    fixture: fixtureLedger, ...(procIdentity ? { procIdentity } : {}), ...(engineIdentity ? { engineIdentity: { engineUid: engineIdentity.engineUid, engineGid: engineIdentity.engineGid,
      uidMap: engineIdentity.uidMap, gidMap: engineIdentity.gidMap, capabilities: engineIdentity.capabilities,
      noNewPrivileges: engineIdentity.noNewPrivileges, seccomp: engineIdentity.seccomp, identityObserved: true } } : {}), ...(failureDiagnosis ? { failure: failureDiagnosis } : {}),
    ...(ubuntuBootstrapFailure ? { ubuntuBootstrapFailure } : {}), ...(failureSite ? { failureSite } : {}) };
  if (namespaceExit) Object.assign(report, { namespaceExit });
  if (namespaceFailures.length) Object.assign(report, { namespaceFailures });
  await writeFile(path.join(scratch, "evidence.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`Evidence: ${path.relative(installedOperator?.directory ?? sourceRoot, scratch)}/evidence.json\n`);
}

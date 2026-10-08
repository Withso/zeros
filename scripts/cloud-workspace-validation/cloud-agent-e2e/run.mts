import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { BridgeClient } from "../lib/bridge-client";
import { createFixtureControlPlane } from "./fixture-control-plane/server";
import { HarnessFailure, safeTrace, selectProviders, diagnoseHarnessFailure, type Provider } from "./assertions";
import { authenticateEngine, driveTurn, selectEngineWorkspace, keepActorAlive } from "./driver";
import { fixtureCredentialEnv, fixtureOuterArguments, fixtureTransportToken } from "./runtime-contract";
import { buildSourceRuntime, createFixtureTls } from "./runtime";
import { awaitRetirement, summarizeRetirement, type NamespaceOutcome, type RetirementEvidence } from "./retirement";
import { freshNativeArtifacts, fixtureFileMatches } from "./artifacts";
import { prepareUbuntuRootfs, UbuntuFixtureFailure } from "./ubuntu-rootfs";

const sourceRoot = process.cwd();
const args = process.argv.slice(2);
function option(name: string, fallback: string) { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1] ?? ""; }
const providers = selectProviders(option("--providers", "claude,codex,cursor").split(","));
const mode = option("--credentials", "invalid");
if (!["invalid", "environment"].includes(mode)) throw new HarnessFailure("operator_input_invalid");
const credentialEnv = fixtureCredentialEnv(mode as "invalid" | "environment", process.env, args.includes("--owner-authorized-provider-turns"));
const scope = option("--scope", "strict");
if (!["strict", "cpu-private-pid-fixture"].includes(scope)) throw new HarnessFailure("operator_input_invalid");
const linuxView = option("--linux-view", "host");
if (!["host", "ubuntu-24.04"].includes(linuxView)) throw new HarnessFailure("operator_input_invalid");
const scratch = path.join(sourceRoot, ".context/agents-fix/scratch/W5", `e2e-${Date.now()}-${randomUUID().slice(0, 8)}`);
await mkdir(scratch, { recursive: true, mode: 0o700 });
const trace: Record<string, unknown>[] = [];
function stage(input: Record<string, unknown>) { const row = safeTrace(input); trace.push(row); process.stdout.write(`${JSON.stringify(row)}\n`); }
const models: Record<Provider, string> = { claude: option("--claude-model", "claude-sonnet-4-6"), codex: option("--codex-model", "gpt-5.4"), cursor: option("--cursor-model", "sonnet-4.6") };
let child: ChildProcess | undefined, client: BridgeClient | undefined;
let stopHeartbeat: (() => void) | undefined;
let cp: ReturnType<typeof createFixtureControlPlane> | undefined;
let closed = false;
let activeStage = "build";
let failureDiagnosis: ReturnType<typeof diagnoseHarnessFailure> | undefined;
let linuxFixture: Awaited<ReturnType<typeof prepareUbuntuRootfs>> | undefined;
let ubuntuBootstrapFailure: UbuntuFixtureFailure["bootstrap"] | undefined;
let childClosed: Promise<NamespaceOutcome> | undefined;
const retirement: RetirementEvidence = {};
let retirementSummary: ReturnType<typeof summarizeRetirement> = { status: "pending", pidNamespaceRetired: false };
let fixtureLedger: ReturnType<ReturnType<typeof createFixtureControlPlane>["inspect"]> | undefined;
const inspections = new Map<string, { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
let namespaceFailure: Record<string, unknown> | undefined;
let namespaceExit: Record<string, unknown> | undefined;
const namespaceFailures: Record<string, unknown>[] = [];
let namespacePassed = false;
let engineIdentity: Record<string, unknown> | undefined;
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
async function close() {
  if (closed) return; closed = true;
  stopHeartbeat?.();
  client?.close();
  if (child?.exitCode === null && !child.signalCode) {
    child.stdin?.write(`${JSON.stringify({ op: "shutdown" })}\n`);
    child.stdin?.end();
    const timeout = setTimeout(() => child?.kill("SIGTERM"), 12_000);
    const force = setTimeout(() => child?.kill("SIGKILL"), 17_000);
    try { await childClosed; } finally { clearTimeout(timeout); clearTimeout(force); }
  }
  for (const item of inspections.values()) { clearTimeout(item.timer); item.reject(new HarnessFailure("cleanup_unconfirmed")); }
  inspections.clear();
  fixtureLedger = cp?.inspect();
  try { if (childClosed) retirementSummary = summarizeRetirement(await awaitRetirement(childClosed, () => retirement), retirement); }
  finally { await cp?.close(); }
}
process.once("SIGINT", () => { void close(); });
process.once("SIGTERM", () => { void close(); });
try {
  if (linuxView === "ubuntu-24.04") { linuxFixture = await prepareUbuntuRootfs(sourceRoot, scratch);
    stage({ stage: "build", status: "observed", count: linuxFixture.manifest.packageCount }); }
  const runtime = await buildSourceRuntime(sourceRoot, scratch);
  stage({ stage: "build", status: "passed" });
  activeStage = "control_plane";
  const tls = await createFixtureTls(scratch);
  cp = createFixtureControlPlane({ tls, credentials: { mode: "environment", env: credentialEnv },
    allowedModels: Object.fromEntries(providers.map(provider => [provider, [models[provider]]])) });
  const { root: _root, schema: _schema, cgroupRoot: _scope, ...attestation } = runtime.descriptor.active;
  cp.configureRuntime({ profile: "zeros-cloud-worker-v4", ...attestation });
  await cp.start();
  stage({ stage: "control_plane", status: "passed" });
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const config = { outerMountNamespace: await readlink("/proc/self/ns/mnt"), outerPidNamespace: await readlink("/proc/self/ns/pid"), scope,
    scratch, stage: runtime.stage, ca: tls.ca, descriptor: runtime.descriptor, sourceFixtureLinux: linuxView,
    mcp: JSON.stringify({ mcpServers: { "0canvas": { type: "http", url: "http://localhost:24193/mcp" } } }),
    source: { ZEROS_CLOUD_RUNTIME_B64: Buffer.from(JSON.stringify(cp.runtimeConfig())).toString("base64url"),
      ZEROS_CLOUD_PORT: String(port), ZEROS_CLOUD_OWNER_SUB: cp.actor.userId, ZEROS_REQUIRE_ACCOUNT: "1", ZEROS_REQUIRE_EXACT_MODEL: "1",
      ZEROS_CLOUD_TOKEN: fixtureTransportToken(),
      ZEROS_ACCOUNT_JWT_PUBLIC_KEY: publicKey.export({ type: "spki", format: "pem" }).toString(),
      ZEROS_ACCOUNT_JWT_AUD: "source-mode-fixture", ZEROS_ACCOUNT_JWT_ISS: "https://source-mode-fixture.invalid" } };
  const configPath = path.join(scratch, "namespace-config.json");
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  activeStage = "namespace";
  child = spawn("sudo", ["unshare", "--mount", "--propagation", "private", "--pid", "--fork", "--mount-proc", "/usr/bin/bwrap",
    ...fixtureOuterArguments(sourceRoot, process.execPath, runtime.entry, configPath, linuxFixture?.root)],
    { cwd: sourceRoot, env: { PATH: process.env.PATH, LANG: "C.UTF-8" }, stdio: ["pipe", "pipe", "pipe"] });
  childClosed = new Promise<NamespaceOutcome>((resolve, reject) => { child!.once("error", () => reject(new HarnessFailure("namespace_launch_failed")));
    child!.once("close", (code, signal) => resolve({ code, signal })); });
  const reader = createInterface({ input: child.stdout! });
  reader.on("line", line => {
    try { const message = JSON.parse(line);
      if (message.type === "namespace") { namespacePassed = true; stage({ stage: "namespace", status: "observed" }); }
      if (message.type === "proc") {
        if (message.filesystemType !== 0x9fa0 || message.ownPid1 !== true) throw new HarnessFailure("private_proc_view_required");
        procIdentity = { filesystemType: message.filesystemType, ownPid1: true };
      }
      if (message.type === "exit") namespaceExit = message;
      if (message.type === "failure" || message.type === "exit" && message.code !== 0) namespaceFailure = message;
      if (message.type === "failure" && namespaceFailures.length < 8) namespaceFailures.push(message);
      if (message.type === "failure") retirement.failure = true;
      if (message.type === "retired") retirement.proof = { engineScopeEmpty: message.engineScopeEmpty === true,
        cgroupRemoved: message.cgroupRemoved === true, namespacePrivate: message.namespacePrivate === true,
        scopeKind: message.scopeKind === "cpu-private-pid-fixture" ? "cpu-private-pid-fixture" : "strict",
        pidNamespaceProcessesEmpty: message.pidNamespaceProcessesEmpty === true, ownCpuCgroupRemoved: message.ownCpuCgroupRemoved === true };
      if (message.type === "inspection") { const item = inspections.get(message.id); if (item) { inspections.delete(message.id); clearTimeout(item.timer); item.resolve(message); } }
    } catch { namespaceFailure = { code: "fixture_contract_invalid" }; }
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
  client = new BridgeClient({ url: `ws://127.0.0.1:${port}/ws`, cloudToken: cp.actorGrantToken, requestTimeoutMs: 20_000 });
  await authenticateEngine(client, () => {});
  stopHeartbeat = keepActorAlive(client);
  stage({ stage: "authentication", status: "passed" });
  engineIdentity = await inspect("identity");
  if (engineIdentity.identityObserved !== true) throw new HarnessFailure("engine_identity_missing");
  stage({ stage: "namespace", status: "passed" });
  const engineWorkspaceId = selectEngineWorkspace(await client.request("workspace.list"), cp.identity);
  for (const provider of providers) {
    activeStage = "receipt";
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
      const inspection = await inspect(); const files = inspection.files as Record<string, { sha256?: string; uid10001?: boolean } | null>;
      if (!["read", "edit", "execute"].every(kind => native.toolKinds.includes(kind)) ||
        !fixtureFileMatches(files["tool-output.txt"], artifacts.outputHash) || !fixtureFileMatches(files["shell-uid.txt"], artifacts.shellHash))
        throw new HarnessFailure("tool_bytes_mismatch");
      cp.assertTerminalConsistency(native.commandId);
      results.push({ provider, case: "native_read_edit_shell_and_resume", ...native });
      const stopped = await driveTurn(client, { ...common, existing: true, conversationId, commandId: randomUUID(), grantId: cp.delegationId(provider), expected: "cancelled", stopMidTool: true,
        toolStarted: async () => { const files = (await inspect()).files as Record<string, unknown>; return fixtureFileMatches(files["stop-started.txt"], artifacts.startHash); },
        prompt: `Run one shell command: printf 'fixture native start ${artifacts.nonce}\\n' > stop-started.txt; sleep 30; printf 'finished\\n' > stop-finished.txt. Then reply done.` });
      const stopFiles = (await inspect()).files as Record<string, unknown>;
      if (stopFiles["stop-finished.txt"] !== null) throw new HarnessFailure("stop_evidence_missing");
      cp.assertTerminalConsistency(stopped.commandId);
      results.push({ provider, case: "stop_mid_tool", ...stopped });
    }
  }
} catch (error) {
  failureDiagnosis = diagnoseHarnessFailure(error);
  if (error instanceof UbuntuFixtureFailure) ubuntuBootstrapFailure = error.bootstrap;
  stage({ stage: activeStage, status: "failed", code: failureDiagnosis.code });
  process.exitCode = 1;
} finally {
  try { await close(); stage({ stage: "retirement", status: retirementSummary.status }); }
  catch { retirementSummary = { status: "failed", pidNamespaceRetired: false };
    stage({ stage: "retirement", status: "failed", code: "cleanup_unconfirmed" }); process.exitCode = 1; }
  const report = { schema: "zeros.source-mode-agent-e2e/v1", evidenceKind: "source_mode_fixture", qualified: false, credentials: mode,
    label: scope === "strict" ? "SOURCE-MODE, strict cgroup fixture" : "PARTIAL CLI/bridge evidence — cgroup/resource qualification pending",
    resourceLimits: scope === "strict" ? "strict" : "SOURCE-MODE, no memory/pids cgroup limits", scope, linuxView,
    ...(linuxFixture ? { linuxFixture: linuxFixture.manifest } : {}),
    pidNamespaceRetired: retirementSummary.pidNamespaceRetired,
    cgroupResourceQualified: false,
    outcome: process.exitCode ? "failed" : mode === "invalid" ? "pre_auth_only" : "response_cases_passed_matrix_pending", providers, results,
    pending: mode === "invalid" ? pending : ["spawn_failure", "mcp_0canvas_success", "excluded_project_plugin_mcp_launch_markers"], trace,
    ...(namespaceFailure ? { namespace: { code: namespaceFailure.code, diagnostics: namespaceFailure.diagnostics, errno: namespaceFailure.errno, step: namespaceFailure.step, rootChecks: namespaceFailure.rootChecks } } : {}),
    fixture: fixtureLedger, ...(procIdentity ? { procIdentity } : {}), ...(engineIdentity ? { engineIdentity: { engineUid: engineIdentity.engineUid, engineGid: engineIdentity.engineGid,
      uidMap: engineIdentity.uidMap, gidMap: engineIdentity.gidMap, identityObserved: true } } : {}), ...(failureDiagnosis ? { failure: failureDiagnosis } : {}),
    ...(ubuntuBootstrapFailure ? { ubuntuBootstrapFailure } : {}) };
  if (namespaceExit) Object.assign(report, { namespaceExit });
  if (namespaceFailures.length) Object.assign(report, { namespaceFailures });
  await writeFile(path.join(scratch, "evidence.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`Evidence: ${path.relative(sourceRoot, scratch)}/evidence.json\n`);
}

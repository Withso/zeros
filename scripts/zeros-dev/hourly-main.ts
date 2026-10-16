import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ACTIONS_SECRET_KEYS } from "../agent-env-check.mjs";
import { parseCloudReplicaDeviceCredential, type CloudReplicaDeviceCredential } from "../../apps/desktop/src/engine/cloud-replica-device";
import { AgentFileStore, canonicalAgentFile } from "./agent-file.mjs";
import { parseFixture } from "./config";
import { ZerosDevSession } from "./session";
import { AlphaTransport, beforeDeadline } from "./transport";
import { ProductApi } from "./product";
import { RunStore, type RunHandle, type Source } from "./receipts";
import { ZerosDevRuntime } from "./runtime";
import { Evidence } from "./evidence";
import { closedError, diagnosticEvidence, ZerosDevError, type ErrorCode } from "./errors";
import { controlPlaneHealth } from "./health";
import { HourlyCredentials } from "./hourly-credentials";
import { runHourly, recoverHourlyRun, HOURLY_CLEANUP_MS, HOURLY_TOTAL_MS } from "./hourly";
import { ExecutionSchema, PrestartRecoverySchema, type PrestartRecovery, importHourlyArtifact, exportHourlyArtifact } from "./hourly-artifact";
import { actionsProfile, hourlyContext } from "./hourly-actions.mjs";
import { runGate0, productGate0Probe } from "./gate0";
import { GATE0_TOTAL_MS } from "./gate0-contract";
import { importCleanupInput } from "./cleanup-recovery";
import type { CleanupHandoffReference, CleanupSummary } from "./cleanup-contract";
import type { CleanupRecoveryReference } from "./cleanup-recovery-contract";
import { runInfrastructure } from "./infrastructure";
import { InfrastructureNative } from "./infrastructure-native";
import { initialInfrastructure, INFRASTRUCTURE_TOTAL_MS, OWNER_SECTION7_COVERAGE } from "./infrastructure-contract";

const PIN_KEYS = ["ZEROS_DEV_PASSWORD", "ZEROS_DEV_WORKOS_SUBJECT", "ZEROS_DEV_ACCOUNT_ID", "ZEROS_DEV_EMAIL", "ZEROS_DEV_ORGANIZATION_ID",
  "ZEROS_DEV_REPOSITORY", "ZEROS_DEV_REPOSITORY_ID", "ZEROS_DEV_GITHUB_INSTALLATION_ID", "ZEROS_DEV_DEVICE_PRIVATE_KEY_B64"] as const;
const profileSchema = z.enum(["hourly", "gate0", "infrastructure"]);
const planSchema = z.object({ execution: ExecutionSchema, profile: profileSchema.default("hourly"),
  prestartRecovery: PrestartRecoverySchema.optional(),
  bootstrap: z.boolean(), previous: ExecutionSchema.nullable(), artifactId: z.string().regex(/^[1-9][0-9]{0,19}$/).nullable() }).strict();

function maskActionsSecrets(env: Readonly<Record<string, string | undefined>>): void {
  const secrets = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value) { secrets.add(value); secrets.add(JSON.stringify(value).slice(1, -1)); }
  };
  const json = (raw: string | undefined): Record<string, unknown> | undefined => {
    if (!raw || Buffer.byteLength(raw) > 64 * 1024) return;
    add(raw);
    let decoded: unknown;
    try { decoded = JSON.parse(raw); } catch { return; }
    // Mask every decoded string, including unexpected token fields that the
    // strict fixture validator will reject. Walk iteratively within the bound.
    const pending = [decoded];
    while (pending.length) {
      const value = pending.pop();
      if (value && typeof value === "object") pending.push(...Object.values(value));
      else add(value);
    }
    return decoded && typeof decoded === "object" && !Array.isArray(decoded) ? decoded as Record<string, unknown> : undefined;
  };
  for (const key of ACTIONS_SECRET_KEYS) add(env[key]);
  const encoded = env.ZEROS_DEV_FIXTURE_B64;
  if (encoded && encoded.length <= 32 * 1024) {
    const fixture = json(Buffer.from(encoded, "base64").toString("utf8"));
    const device = fixture?.ZEROS_DEV_DEVICE_PRIVATE_KEY_B64;
    if (typeof device === "string" && device.length <= 32 * 1024) json(Buffer.from(device, "base64").toString("utf8"));
  }
  json(env.AGENT_RUNTIME_CODEX_AUTH_JSON);
  // Workflow control commands go only to stdout, never the evidence writer.
  // Escaping prevents decoded newlines/percent escapes from injecting commands.
  for (const secret of secrets) process.stdout.write(`::add-mask::${secret.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}\n`);
}

/** Actions has one ephemeral checkout. Only the fixture pins, password and
 * pre-enrolled device key are materialized, in the same canonical 0600 store
 * the interactive CLI uses. Provider keys are never written here. */
export async function initializeActionsFixture(checkout: string, env: Readonly<Record<string, string | undefined>>): Promise<AgentFileStore> {
  hourlyContext(env);
  maskActionsSecrets(env);
  let values: Record<string, string>;
  try {
    const raw = env.ZEROS_DEV_FIXTURE_B64;
    if (!raw || raw.length > 32 * 1024 || Buffer.from(raw, "base64").toString("base64") !== raw) throw new Error();
    values = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    if (!values || Array.isArray(values) || Object.keys(values).sort().join("\0") !== [...PIN_KEYS].sort().join("\0") ||
      Object.values(values).some(value => typeof value !== "string" || !value || value.trim() !== value || /[\r\n\0]/.test(value))) throw new Error();
    const fixture = parseFixture(values), credential = parseCloudReplicaDeviceCredential(JSON.parse(Buffer.from(values.ZEROS_DEV_DEVICE_PRIVATE_KEY_B64!, "base64").toString("utf8")));
    if (credential.accountUserId !== fixture.accountId || !credential.deviceId || values.ZEROS_DEV_PASSWORD!.length > 1024) throw new Error();
  } catch { throw new ZerosDevError("credentials_invalid"); }
  const file = await canonicalAgentFile(checkout);
  if (file !== path.join(await realpath(checkout), ".env.agent")) throw new ZerosDevError("credentials_unsafe");
  let output;
  try {
    output = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    const info = await output.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o7777) !== 0o600) throw new Error();
    await output.writeFile(PIN_KEYS.map(key => `${key}=${values[key]}`).join("\n") + "\n"); await output.sync();
  } catch { throw new ZerosDevError("credentials_unsafe"); }
  finally { await output?.close(); }
  const store = new AgentFileStore(file); await store.read(); return store;
}

async function ownedDirectory(directory: string): Promise<void> {
  await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.mode & 0o022 || await realpath(directory) !== directory)
    throw new ZerosDevError("artifact_invalid");
}

type ActionsServices = Pick<Parameters<typeof runHourly>[0], "api" | "credentials"> & {
  connect: (...args: Parameters<Parameters<typeof runHourly>[0]["connect"]>) => Promise<ZerosDevRuntime>;
  session: Pick<ZerosDevSession, "login" | "whoami" | "logout"> & Partial<Pick<ZerosDevSession, "prepareDetachedAuth" | "prepareLaunchAuth">>;
  health(): ReturnType<typeof controlPlaneHealth>;
};
type ActionsOptions = {
  signal?: AbortSignal;
  write?: (value: unknown) => void;
  factory?: (file: AgentFileStore, env: NodeJS.ProcessEnv) => ActionsServices;
  rehearse?: typeof runGate0;
  infrastructure?: typeof runInfrastructure;
};
function productServices(file: AgentFileStore): ActionsServices {
  const transport = new AlphaTransport(), session = new ZerosDevSession(file, transport), api = new ProductApi(session, transport);
  // Owner option B supplies no provider keys. Keep exact legacy credential
  // cleanup available; full agent installation awaits the release-check bridge.
  return { session, api, credentials: new HourlyCredentials(api),
    health: () => controlPlaneHealth(transport),
    connect: (run, signal, onAdmissionEvent) => ZerosDevRuntime.connect(session, api, run, { signal, onAdmissionEvent }) };
}

export async function runActions(env = process.env, options: ActionsOptions = {}): Promise<number> {
  const runId = randomUUID(), write = options.write ?? ((value: unknown) => { process.stdout.write(JSON.stringify(value) + "\n"); });
  const evidence = new Evidence(runId, write);
  let code: ErrorCode | null = null, historyVerified = false, loggedIn = false;
  let diagnostic: ReturnType<typeof diagnosticEvidence> = {};
  const fail = (error: unknown) => {
    if (code === null) { code = closedError(error); diagnostic = diagnosticEvidence(error); }
  };
  let store: RunStore | undefined, credential: CloudReplicaDeviceCredential | undefined, session: ActionsServices["session"] | undefined;
  let execution: z.infer<typeof ExecutionSchema> | undefined, artifact: string | undefined;
  let profile: z.infer<typeof profileSchema> | undefined;
  let handoff: CleanupHandoffReference | undefined, cleanup: CleanupSummary | undefined, prestartRecovery: PrestartRecovery | undefined;
  let cleanupRecovery: CleanupRecoveryReference | undefined, sourceArtifactSha256: string | undefined;
  try {
    execution = ExecutionSchema.parse(hourlyContext(env));
    profile = profileSchema.parse(actionsProfile(env));
    const plan = planSchema.parse(JSON.parse(env.ZEROS_DEV_E2E_PLAN ?? ""));
    prestartRecovery = plan.prestartRecovery;
    if (plan.profile !== profile || JSON.stringify(plan.execution) !== JSON.stringify(execution) || plan.bootstrap !== (plan.previous === null) || plan.bootstrap !== (plan.artifactId === null))
      throw new ZerosDevError("artifact_invalid");
    const started = Number(env.ZEROS_DEV_E2E_START_MS), wall = Date.now(), anchor = performance.now();
    // The workflow starts this budget before dependency installation. Anchor
    // its remainder once so a wall-clock adjustment cannot extend the run.
    const totalMs = profile === "gate0" ? GATE0_TOTAL_MS : profile === "infrastructure" ? INFRASTRUCTURE_TOTAL_MS : HOURLY_TOTAL_MS;
    const remaining = () => totalMs - Math.max(0, wall - started) - (performance.now() - anchor);
    if (!Number.isSafeInteger(started) || started > Date.now() + 1000 || remaining() < HOURLY_CLEANUP_MS + 60_000) throw new ZerosDevError("deadline");
    if (!env.GITHUB_WORKSPACE || !env.RUNNER_TEMP) throw new ZerosDevError("actions_required");
    const root = await realpath(env.GITHUB_WORKSPACE), temporary = await realpath(env.RUNNER_TEMP);
    const credentialsFile = await initializeActionsFixture(root, env), values = (await credentialsFile.read()).values;
    const fixture = parseFixture(values);
    credential = parseCloudReplicaDeviceCredential(JSON.parse(Buffer.from(values.ZEROS_DEV_DEVICE_PRIVATE_KEY_B64!, "base64").toString("utf8")));
    const output = path.join(temporary, "zeros-dev-output"); await ownedDirectory(output); artifact = path.join(output, "receipt.json");
    const context = path.join(root, ".context"); await ownedDirectory(context);
    store = new RunStore(path.join(context, "zeros-dev"), fixture, credential);
    if (plan.previous) {
      const previous = await importHourlyArtifact(path.join(temporary, "zeros-dev-previous", "receipt.json"), store, credential, plan.previous,
        { includeSourceDigest: true });
      handoff = previous.handoff; prestartRecovery ??= previous.prestartRecovery;
      cleanupRecovery = previous.cleanupRecovery; sourceArtifactSha256 = previous.sourceArtifactSha256;
    }
    const runs = store, device = credential, identity = execution, outputFile = artifact;
    const uncertain = { runId, success: false, code: "command_uncertain" as const };
    // An initial checkpoint precedes authentication or any product write. All
    // subsequent intent saves atomically replace only this signed execution.
    await exportHourlyArtifact(outputFile, runs, device, identity, uncertain, { handoff, profile, prestartRecovery, cleanupRecovery });
    historyVerified = true;
    if (env.ZEROS_DEV_CLEANUP_HANDOFF_B64) {
      ({ handoff, cleanupRecovery } = await importCleanupInput(env.ZEROS_DEV_CLEANUP_HANDOFF_B64, runs, device,
        { sourceArtifactSha256, handoff, cleanupRecovery }));
      await exportHourlyArtifact(outputFile, runs, device, identity, uncertain, { replace: true, handoff, profile, prestartRecovery, cleanupRecovery });
    }
    let checkpoints = Promise.resolve();
    const withRun = <T>(id: string, source: Source | null, work: (handle: RunHandle) => Promise<T>) => runs.withRun(id, source, async handle => {
      const save = handle.save;
      handle.save = async () => {
        await save();
        const checkpoint = checkpoints.then(async () => { await exportHourlyArtifact(outputFile, runs, device, identity, uncertain, { replace: true, handoff, profile, prestartRecovery, cleanupRecovery }); });
        checkpoints = checkpoint.catch(() => {}); await checkpoint;
      };
      return work(handle);
    });
    const services = (options.factory ?? productServices)(credentialsFile, env), { api, credentials } = services;
    session = services.session;
    const bound = () => {
      const left = remaining() - HOURLY_CLEANUP_MS;
      const deadline = left > 0 ? AbortSignal.timeout(Math.ceil(left)) : AbortSignal.abort();
      return options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    };
    const step = <T>(phase: Parameters<Evidence["step"]>[0], task: () => Promise<T>) => evidence.step(phase, () => {
      const signal = bound(); if (signal.aborted) throw new ZerosDevError("deadline");
      return beforeDeadline(task(), signal);
    });
    await step("login", () => session!.login()); loggedIn = true;
    await step("identity", () => session!.whoami());
    const health = await step("health_cp", async () => {
      const health = await services.health();
      if (!health.ready || !health.cloud.enabled) throw new ZerosDevError("service_unavailable");
      return health;
    });
    write({ schema: "zeros.dev-hourly-source/v1", localSource: execution.sourceSha, deployedSource: health.sourceSha });
    // A predecessor with an uncertain prompt is cleaned, never prompted again.
    // A missing create result remains unknown; no name-based provider cleanup.
    let recoveryFailure: unknown;
    for (const id of await store.list()) {
      try { await withRun(id, null, async handle => {
        const priorEvidence = new Evidence(id, write);
        let failed: unknown;
        try { await recoverHourlyRun({ handle, api, credentials, signal: bound(), evidence: priorEvidence,
          revokeMs: Math.max(1, Math.ceil(remaining() - 10_000)) }); }
        catch (error) { failed = error; }
        handle.run.evidence = [...handle.run.evidence, ...priorEvidence.events].slice(-256);
        try { await handle.save(); } catch (error) { failed ??= error; }
        if (failed) throw failed;
      }); } catch (error) { recoveryFailure ??= error; }
    }
    if (recoveryFailure) throw recoveryFailure;
    const predecessors = await Promise.all((await store.list()).map(id => store!.read(id)));
    if (bound().aborted) throw new ZerosDevError("deadline");
    await withRun(runId, { revision: execution.sourceSha, dirty: false }, async handle => {
      handle.run.hourly = { version: 1, ...execution!, credentials: [], histories: [], activeWindows: [], complete: false,
        ...(profile === "gate0" ? { rehearsal: { version: 1, complete: false, models: [], cycles: [], transports: [] } } : {}),
        ...(profile === "infrastructure" ? { infrastructure: initialInfrastructure() } : {}) }; await handle.save();
      let failed: unknown;
      try {
        const inputs = { handle, api, credentials, evidence, budgetMs: Math.max(1, Math.ceil(remaining() - HOURLY_CLEANUP_MS)),
          signal: options.signal, connect: services.connect, predecessors };
        if (profile === "infrastructure") {
          if (!session!.prepareLaunchAuth) throw new ZerosDevError("invalid_request");
          await (options.infrastructure ?? runInfrastructure)({ ...inputs,
            connect: services.connect,
            prepareLaunchAuth: ms => session!.prepareLaunchAuth!(ms),
            native: (runtime, handle, settings) => new InfrastructureNative(runtime, handle, settings) });
        } else if (profile === "gate0") {
          if (!session!.prepareDetachedAuth) throw new ZerosDevError("invalid_request");
          await (options.rehearse ?? runGate0)({ ...inputs, connect: services.connect,
            probe: productGate0Probe(api as ProductApi), prepareDetachedAuth: ms => session!.prepareDetachedAuth!(ms) });
        } else await runHourly(inputs);
      } catch (error) { failed = error; }
      // This is a fresh run; the runner may already have checkpointed this
      // same event prefix before cleanup. Never double-count those phases.
      handle.run.evidence = evidence.events.slice(-256);
      try { await handle.save(); } catch (error) { failed ??= error; }
      if (failed) throw failed;
    });
  } catch (error) { fail(error); }
  finally {
    if (loggedIn && session) {
      try { await beforeDeadline(session.logout(), AbortSignal.timeout(10_000)); }
      catch (error) { fail(error); }
    }
    if (historyVerified && store && credential && execution && artifact) {
      try { cleanup = await exportHourlyArtifact(artifact, store, credential, execution, { runId, success: code === null, code, ...diagnostic }, { replace: true, handoff, profile, prestartRecovery, cleanupRecovery }); }
      catch { code ??= "artifact_invalid"; }
    }
    write({ schema: profile === "infrastructure" ? "zeros.dev-infrastructure-result/v1" : "zeros.dev-hourly-result/v1",
      ...(profile === "infrastructure" ? { coverage: OWNER_SECTION7_COVERAGE } : {}),
      runId, success: code === null, code, ...diagnostic, ...(cleanup ? { cleanup } : {}) });
  }
  return code === null ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController(), stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  void runActions(process.env, { signal: controller.signal }).then(code => { process.exitCode = code; }).catch(() => {
    process.stderr.write('{"schema":"zeros.dev-error/v1","code":"internal"}\n'); process.exitCode = 1;
  }).finally(() => { process.off("SIGINT", stop); process.off("SIGTERM", stop); });
}

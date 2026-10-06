import type pg from "pg";
import { parseCloudWorkspaceSetupHookLog } from "./setup-log.js";
import { ClosedDiagnosticSchema, RuntimeInstallInputSchema, RUNTIME_INSTALL_MAX_ENCODED_BYTES, type RuntimeDescriptor } from "./runtime-contract.js";
import type { CloudRuntimePin } from "./runtime-selection.js";
import type { RuntimeArtifactStore } from "./runtime-artifact-store.js";
import { parseSetupDiagnostic, classifyCloudFailure, diagnosticCode, type SetupDiagnostic, type CloudDiagnosticPhase } from "./cloud-diagnostics.js";
import { retainCloudDiagnostic, diagnosticStorageFailed } from "./cloud-diagnostic-store.js";
import {
  CloudProviderError,
  isCloudWorkspaceProviderName,
  type CloudWorkspaceCommandRunner,
} from "./provider.js";
import {
  CloudWorkspaceSetupError,
  cloudWorkspaceSetupReadinessMatches,
  type CloudWorkspaceSetupExecution,
  type CloudWorkspaceSetupExecutor,
  type CloudWorkspaceSetupReadiness,
  type CloudWorkspaceSetupResult,
} from "./setup-worker.js";

export const CLOUD_WORKSPACE_LINUX_SETUP_HELPER_COMMAND =
  "/usr/bin/flock --exclusive --nonblock /run/zeros/setup.lock /opt/zeros-runtime/bin/node /opt/zeros-runtime/lib/zeros/setup-cloud-workspace.mjs";
export const CLOUD_WORKSPACE_RUNTIME_INSTALL_COMMAND =
  "/usr/bin/flock --exclusive --nonblock /run/zeros/setup.lock /opt/zeros-bootstrap/install-runtime.sh --stdin";
/** Compatibility export; the image-owned helper contract is provider neutral. */
export const DAYTONA_SETUP_HELPER_COMMAND =
  CLOUD_WORKSPACE_LINUX_SETUP_HELPER_COMMAND;
const SETUP_REQUEST_ENV = "ZEROS_CLOUD_WORKSPACE_SETUP_B64";
const SETUP_REQUEST_AUDIENCE = "zeros-cloud-workspace-setup-v1";
const SETUP_RESULT_AUDIENCE = "zeros-cloud-workspace-setup-result-v1";
const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_LOG_BYTES = 128 * 1024;
const MIN_ADMISSION_REMAINING_MS = 5_000;
export const CLOUD_WORKSPACE_RUNTIME_ADMISSION_TTL_SECONDS = 900;
const MAX_ADMISSION_LIFETIME_MS = CLOUD_WORKSPACE_RUNTIME_ADMISSION_TTL_SECONDS * 1_000;
// Installation precedes the one-use redemption. Reserve the ten-minute
// delivery/install allowance plus the helper's minimum entry lifetime; the
// remaining setup budget runs on fresh materials after that redemption.
const RUNTIME_INSTALL_BUDGET_MS = 10 * 60_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TOKEN_PATTERN = /^zws_[A-Za-z0-9_-]{43}$/;

type AdmissionDisposition = "completed" | "failed" | "rejected";

export type CloudWorkspaceSetupAdmission = {
  id: string;
  token: string;
  endpoint: string;
  expiresAt: Date;
  workspaceId: string;
  organizationId: string;
  generation: number;
  setupRunId: string;
  executionFence: number;
};

export interface CloudWorkspaceSetupAdmissionBroker {
  /** Mint a one-use, setup-run/fence-bound grant just before provider I/O. */
  issue(
    execution: CloudWorkspaceSetupExecution,
    signal: AbortSignal,
  ): Promise<CloudWorkspaceSetupAdmission>;
  /** Idempotently retire the grant before setup success can be published. */
  revoke(
    admission: CloudWorkspaceSetupAdmission,
    disposition: AdmissionDisposition,
  ): Promise<void>;
}

/** Compatibility alias for the original Daytona bootstrap API. */
export type DaytonaSetupCommandRunner = CloudWorkspaceCommandRunner;

export type CloudWorkspaceLinuxSetupExecutorOptions = {
  admissionBroker: CloudWorkspaceSetupAdmissionBroker;
  runtimeArtifacts: RuntimeArtifactStore | null;
  resolveRuntimeArtifact?: (pin: CloudRuntimePin) => Promise<{ descriptor: RuntimeDescriptor; objectKey: string } | null>;
  diagnosticPool?: pg.Pool;
  commandRunner?: DaytonaSetupCommandRunner;
  commandRunnerResolver?: (
    execution: CloudWorkspaceSetupExecution,
  ) => Promise<DaytonaSetupCommandRunner>;
  engineProtocolVersion: number;
  timeoutSeconds: number;
  now?: () => number;
};
export type DaytonaCloudWorkspaceSetupExecutorOptions =
  CloudWorkspaceLinuxSetupExecutorOptions;

type SetupHelperReady = {
  version: 1;
  audience: typeof SETUP_RESULT_AUDIENCE;
  outcome: "ready";
  readiness: CloudWorkspaceSetupReadiness;
  logExcerpt?: string;
};

const HELPER_FAILURES: Readonly<
  Record<string, { code: string; retryable: boolean }>
> = Object.freeze({
  admission_temporarily_unavailable: {
    code: "setup_admission_unavailable",
    retryable: true,
  },
  engine_readiness_failed: {
    code: "setup_engine_readiness_failed",
    retryable: true,
  },
  checkpoint_restore_invalid: {
    code: "setup_checkpoint_restore_invalid",
    retryable: false,
  },
  checkpoint_restore_unavailable: {
    code: "setup_checkpoint_restore_unavailable",
    retryable: true,
  },
  image_contract_invalid: {
    code: "setup_image_contract_invalid",
    retryable: false,
  },
  repository_revision_invalid: {
    code: "setup_repository_revision_invalid",
    retryable: false,
  },
  repository_history_limit: {
    code: "setup_repository_history_limit",
    retryable: false,
  },
  repository_temporarily_unavailable: {
    code: "setup_repository_unavailable",
    retryable: true,
  },
  setup_command_failed: {
    code: "setup_command_failed",
    retryable: true,
  },
  setup_hook_retry_required: { code: "setup_hook_retry_required", retryable: false },
  computer_environment_revoked: { code: "computer_environment_revoked", retryable: false },
  request_invalid: { code: "setup_request_invalid", retryable: false },
  settings_invalid: { code: "setup_settings_invalid", retryable: false },
});

function setupError(
  code: string,
  message: string,
  retryable: boolean,
): CloudWorkspaceSetupError {
  return new CloudWorkspaceSetupError(code, message, retryable);
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  return (
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0")
  );
}

function safeString(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    Buffer.byteLength(value, "utf8") <= maximumBytes &&
    !/[\0\r\n]/.test(value)
  );
}

function validateExecution(execution: CloudWorkspaceSetupExecution): void {
  if (
    !UUID_PATTERN.test(execution.setupRunId) ||
    !UUID_PATTERN.test(execution.workspaceId) ||
    !UUID_PATTERN.test(execution.organizationId) ||
    !UUID_PATTERN.test(execution.authority.accountUserId) ||
    !Number.isSafeInteger(execution.generation) ||
    execution.generation < 1 ||
    !Number.isSafeInteger(execution.attempt) ||
    execution.attempt < 1 ||
    !Number.isSafeInteger(execution.executionFence) ||
    execution.executionFence < 1 ||
    !isCloudWorkspaceProviderName(execution.provider.name) ||
    !safeString(execution.provider.resourceId, 512) ||
    !safeString(execution.image.ref, 1024) ||
    execution.image.sourceCommit === null ||
    !COMMIT_PATTERN.test(execution.image.sourceCommit) ||
    execution.repository.forge !== "github.com" ||
    !safeString(execution.repository.owner, 255) ||
    !safeString(execution.repository.name, 255) ||
    !safeString(execution.repository.revision, 512) ||
    !Number.isSafeInteger(execution.settings.version) ||
    execution.settings.version < 1 ||
    !SHA256_PATTERN.test(execution.settings.sha256)
  ) {
    throw setupError(
      "setup_execution_invalid",
      "Cloud workspace setup execution is invalid or unsupported",
      false,
    );
  }
}

function normalizedAdmissionEndpoint(raw: string): string | null {
  if (!safeString(raw, 512)) return null;
  let value: URL;
  try {
    value = new URL(raw);
  } catch {
    return null;
  }
  if (
    value.protocol !== "https:" ||
    value.username ||
    value.password ||
    value.search ||
    value.hash
  ) {
    return null;
  }
  return value.toString();
}

function validateAdmission(
  execution: CloudWorkspaceSetupExecution,
  admission: CloudWorkspaceSetupAdmission,
  now: number,
): string {
  const endpoint = normalizedAdmissionEndpoint(admission.endpoint);
  const expiresAt = admission.expiresAt.getTime();
  if (
    !UUID_PATTERN.test(admission.id) ||
    !TOKEN_PATTERN.test(admission.token) ||
    endpoint === null ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt - now < MIN_ADMISSION_REMAINING_MS + (execution.runtime ? RUNTIME_INSTALL_BUDGET_MS : 0) ||
    expiresAt - now > MAX_ADMISSION_LIFETIME_MS ||
    admission.workspaceId !== execution.workspaceId ||
    admission.organizationId !== execution.organizationId ||
    admission.generation !== execution.generation ||
    admission.setupRunId !== execution.setupRunId ||
    admission.executionFence !== execution.executionFence
  ) {
    throw setupError(
      "setup_admission_invalid",
      "Cloud workspace setup admission is invalid",
      false,
    );
  }
  return endpoint;
}

function encodeRequest(
  execution: CloudWorkspaceSetupExecution,
  admission: CloudWorkspaceSetupAdmission,
  endpoint: string,
  now: number,
): string {
  const serialized = JSON.stringify({
    admission: {
      endpoint,
      expiresAtMs: admission.expiresAt.getTime(),
      id: admission.id,
      token: admission.token,
    },
    audience: SETUP_REQUEST_AUDIENCE,
    execution: {
      executionFence: execution.executionFence,
      generation: execution.generation,
      organizationId: execution.organizationId,
      setupRunId: execution.setupRunId,
      workspaceId: execution.workspaceId,
    },
    expected: {
      imageRef: execution.image.ref,
      imageSourceCommit: execution.image.sourceCommit,
      repositoryRevision: execution.repository.revision,
      settingsSha256: execution.settings.sha256,
      settingsVersion: execution.settings.version,
    },
    issuedAtMs: now,
    version: 1,
  });
  if (Buffer.byteLength(serialized, "utf8") > MAX_REQUEST_BYTES) {
    throw setupError(
      "setup_request_too_large",
      "Cloud workspace setup request exceeds its protocol bound",
      false,
    );
  }
  return Buffer.from(serialized, "utf8").toString("base64url");
}

function exactReadinessShape(value: CloudWorkspaceSetupReadiness): boolean {
  return (
    exactKeys(value, [
      "executionFence",
      "generation",
      "image",
      "organizationId",
      "repository",
      "settings",
      "setupRunId",
      "version",
      "workspaceId",
      "engine",
    ]) &&
    !!value.image &&
    exactKeys(value.image, ["ref", "sourceCommit"]) &&
    !!value.repository &&
    exactKeys(value.repository, ["commit", "revision"]) &&
    !!value.settings &&
    exactKeys(value.settings, ["sha256", "version"]) &&
    !!value.engine &&
    exactKeys(value.engine, [
      "durableRecordConnected",
      "health",
      "instanceId",
      "protocolVersion",
    ])
  );
}

function parseReadyResponse(
  output: string,
  execution: CloudWorkspaceSetupExecution,
  expectedEngineProtocolVersion: number,
): CloudWorkspaceSetupResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw setupError(
      "setup_helper_response_invalid",
      "Cloud workspace setup helper returned an invalid response",
      false,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw setupError(
      "setup_helper_response_invalid",
      "Cloud workspace setup helper returned an invalid response",
      false,
    );
  }
  const value = parsed as Partial<SetupHelperReady>;
  const expectedKeys = [
    "audience",
    ...(value.logExcerpt === undefined ? [] : ["logExcerpt"]),
    "outcome",
    "readiness",
    "version",
  ];
  if (
    !exactKeys(parsed, expectedKeys) ||
    value.version !== 1 ||
    value.audience !== SETUP_RESULT_AUDIENCE ||
    value.outcome !== "ready" ||
    !value.readiness ||
    !exactReadinessShape(value.readiness) ||
    !cloudWorkspaceSetupReadinessMatches(execution, value.readiness) ||
    value.readiness.engine.protocolVersion !== expectedEngineProtocolVersion ||
    (value.logExcerpt !== undefined &&
      (typeof value.logExcerpt !== "string" ||
        Buffer.byteLength(value.logExcerpt, "utf8") > MAX_LOG_BYTES))
  ) {
    throw setupError(
      "setup_readiness_invalid",
      "Cloud workspace setup readiness proof is invalid",
      false,
    );
  }
  return {
    readiness: value.readiness,
    ...(value.logExcerpt !== undefined ? { logExcerpt: value.logExcerpt } : {}),
    logTruncated: false,
  };
}

type InstallerDiagnostic = NonNullable<SetupDiagnostic["installer"]>;

function withInstallerDiagnostic(error: CloudWorkspaceSetupError, installer: InstallerDiagnostic | undefined): CloudWorkspaceSetupError {
  if (installer) {
    const setup = "diagnostic" in error ? parseSetupDiagnostic(error.diagnostic) : null;
    Object.assign(error, { diagnostic: { ...(setup ?? { version: 1, phase: "runtime" }), installer } });
  }
  return error;
}

function runtimeInstallerOutput(output: string, exitCode: number): { output: string; diagnostic: InstallerDiagnostic } {
  // The installer appends one closed diagnostic after the unchanged helper
  // result. Never expose raw installer output or parser errors to diagnostics.
  let installer: InstallerDiagnostic | undefined;
  try {
    const lines = output.trim().split("\n");
    const diagnostic = ClosedDiagnosticSchema.safeParse(JSON.parse(lines.pop()!));
    if (diagnostic.success && diagnostic.data.component === "installer") {
      installer = diagnostic.data;
      if (installer.exitCode === exitCode && lines.length > 0 && (exitCode === 0
        ? installer.ok && !installer.timedOut && installer.failedChecks.length === 0
        : !installer.ok && installer.stage === "run_setup" && installer.failedChecks.length === 1 && installer.failedChecks[0] === "setup_exit")) {
        return { output: lines.join("\n"), diagnostic: installer };
      }
    }
  } catch { /* Reject through the closed error below. */ }
  // GNU timeout returns 124 after the child reports SIGTERM/143, or 137
  // after kill-after. The outer nonblocking flock exits 1 with no stdout.
  // Neither wrapper outcome can produce readiness; both use bounded retries.
  const transportTimeout = exitCode === 124 || exitCode === 137;
  const transient = new Set(["lock_busy", "artifact_expired", "http_status", "download_truncated", "timeout", "process_signal"]);
  const retryable = transportTimeout
    ? !installer || installer.failedChecks.every(check => transient.has(check))
    : installer
      ? exitCode !== 0 && installer.exitCode === exitCode && !installer.ok && installer.failedChecks.length > 0 &&
        installer.failedChecks.every(check => transient.has(check))
      : exitCode === 1 && output.trim() === "";
  throw withInstallerDiagnostic(setupError("setup_runtime_install_failed", "Cloud workspace runtime installation did not complete", retryable), installer);
}

function helperFailure(
  output: string,
  execution: CloudWorkspaceSetupExecution,
): CloudWorkspaceSetupError {
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    if (
      ((parsed.version === 1 && exactKeys(parsed, ["audience", "code", "outcome", "version"])) ||
        (parsed.version === 2 && exactKeys(parsed, ["audience", "code", "outcome", "version", "diagnostic"]) && parseSetupDiagnostic(parsed.diagnostic)) ||
        (parsed.version === 3 && execution.runtime?.profile === "zeros-cloud-worker-v4" &&
          ["setup_command_failed", "setup_hook_retry_required"].includes(String(parsed.code)) &&
          exactKeys(parsed, ["audience", "code", "outcome", "version", "diagnostic", "hookLog"]) &&
          parseSetupDiagnostic(parsed.diagnostic) && parseCloudWorkspaceSetupHookLog(parsed.hookLog))) &&
      parsed.audience === SETUP_RESULT_AUDIENCE &&
      parsed.outcome === "error" &&
      typeof parsed.code === "string"
    ) {
      const mapped = HELPER_FAILURES[parsed.code];
      if (mapped) {
        // Boat can expose its command channel while snapshot restoration is
        // still replacing runtime files. A failed proof never admits the VM:
        // let the setup worker's bounded claim budget rerun the entire helper
        // with fresh credentials and a new fence. Persistent mismatches exhaust
        // that budget and fail closed; other providers keep their policy.
        const restoringBoatImage =
          execution.provider.name === "boat" &&
          parsed.code === "image_contract_invalid";
        return Object.assign(setupError(
          mapped.code,
          "Cloud workspace setup helper did not complete",
          parsed.code === "computer_environment_revoked" || (execution.runtime && ["setup_command_failed", "setup_hook_retry_required"].includes(parsed.code)) ? false : mapped.retryable || restoringBoatImage,
        ), parsed.version === 2 || parsed.version === 3 ? { diagnostic: parseSetupDiagnostic(parsed.diagnostic)! } : {},
        parsed.version === 3 ? { hookLog: parseCloudWorkspaceSetupHookLog(parsed.hookLog)! } : {});
      }
    }
  } catch {
    // A malformed error body is deliberately collapsed below.
  }
  return setupError(
    "setup_helper_failed",
    "Cloud workspace setup helper did not complete",
    true,
  );
}

function normalizeExecutionError(error: unknown): CloudWorkspaceSetupError {
  if (error instanceof CloudWorkspaceSetupError) return error;
  if (error instanceof CloudProviderError) {
    const code = /^[a-z][a-z0-9_]{0,119}$/.test(error.code)
      ? `setup_${error.code}`
      : "setup_provider_failure";
    return Object.assign(setupError(
      code,
      "Cloud workspace provider command did not complete",
      error.retryable,
    ), "diagnostic" in error && parseSetupDiagnostic(error.diagnostic) ? { diagnostic: parseSetupDiagnostic(error.diagnostic)! } : {});
  }
  return setupError(
    "setup_provider_failure",
    "Cloud workspace provider command did not complete",
    true,
  );
}

export class CloudWorkspaceLinuxSetupExecutor implements CloudWorkspaceSetupExecutor {
  private readonly admissionBroker: CloudWorkspaceSetupAdmissionBroker;
  private readonly commandRunner: DaytonaSetupCommandRunner | null;
  private readonly commandRunnerResolver:
    | ((
        execution: CloudWorkspaceSetupExecution,
      ) => Promise<DaytonaSetupCommandRunner>)
    | null;
  private readonly engineProtocolVersion: number;
  private readonly timeoutSeconds: number;
  private readonly now: () => number;

  constructor(private readonly options: CloudWorkspaceLinuxSetupExecutorOptions) {
    if (
      (options.commandRunner ? 1 : 0) +
        (options.commandRunnerResolver ? 1 : 0) !==
        1 ||
      !Number.isSafeInteger(options.engineProtocolVersion) ||
      options.engineProtocolVersion < 1 ||
      options.engineProtocolVersion > 65_535 ||
      !Number.isSafeInteger(options.timeoutSeconds) ||
      options.timeoutSeconds < 30 ||
      options.timeoutSeconds > 60 * 60
    ) {
      throw new Error("Daytona setup executor options are invalid");
    }
    this.admissionBroker = options.admissionBroker;
    this.commandRunner = options.commandRunner ?? null;
    this.commandRunnerResolver = options.commandRunnerResolver ?? null;
    this.engineProtocolVersion = options.engineProtocolVersion;
    this.timeoutSeconds = options.timeoutSeconds;
    this.now = options.now ?? Date.now;
  }

  private async retain(execution: CloudWorkspaceSetupExecution, error: unknown, phase: CloudDiagnosticPhase, sourceError?: unknown): Promise<void> {
    const setup = parseSetupDiagnostic((error as { diagnostic?: SetupDiagnostic } | null)?.diagnostic);
    const typed = classifyCloudFailure(sourceError ?? error, setup?.phase ?? phase);
    const code = diagnosticCode((error as {code?:unknown}|null)?.code);
    typed.code = code === "compute_reconciliation_failed" ? "setup_provider_failure" : code;
    if (error instanceof CloudWorkspaceSetupError) typed.retryable = error.retryable;
    const source = sourceError && typeof sourceError === "object" ? sourceError as { code?: unknown } : {};
    const transientProvider = typed.retryable && !setup && (
      (sourceError instanceof CloudProviderError && sourceError.code.startsWith("provider_") && sourceError.code !== "provider_resource_lost") ||
      typed.httpClass === "5xx" || typed.errorClass === "timeout" ||
      ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "EPIPE"].includes(String(source.code))
    );
    if (transientProvider && error instanceof CloudWorkspaceSetupError) {
      // The worker owns retry exhaustion. Keep only the closed diagnostic on
      // the typed failure until it actually rejects setup; successful retries
      // should not leave a reject_setup incident in management history.
      error.providerDiagnostic = typed;
      return;
    }
    if (!this.options.diagnosticPool) return;
    try {
      const incidentId = await retainCloudDiagnostic(this.options.diagnosticPool, { ...execution, operationKind: "setup", operationId: execution.setupRunId },
        { ...typed, ...(setup ? { setup } : {}), retryCount: Math.min(10000,execution.attempt), decision: "reject_setup", claim: "current" });
      if (incidentId && error instanceof Error) Object.assign(error, { incidentId });
    } catch { await diagnosticStorageFailed(this.options.diagnosticPool); }
  }

  async execute(
    execution: CloudWorkspaceSetupExecution,
    signal: AbortSignal,
  ): Promise<CloudWorkspaceSetupResult> {
    if (signal.aborted) {
      throw setupError(
        "setup_execution_aborted",
        "Cloud workspace setup execution was aborted",
        true,
      );
    }
    validateExecution(execution);

    let commandRunner: DaytonaSetupCommandRunner;
    try {
      commandRunner = this.commandRunnerResolver
        ? await this.commandRunnerResolver(execution)
        : this.commandRunner!;
    } catch (error) {
      const failure = normalizeExecutionError(error);
      await this.retain(execution,failure,"bootstrap",error);
      throw failure;
    }

    let admission: CloudWorkspaceSetupAdmission;
    try {
      admission = await this.admissionBroker.issue(execution, signal);
    } catch (error) {
      const failure = error instanceof CloudWorkspaceSetupError ? error : setupError(
        "setup_admission_unavailable", "Cloud workspace setup admission is temporarily unavailable", true);
      await this.retain(execution,failure,"setup_admission",error);
      throw failure;
    }

    let disposition: AdmissionDisposition = "failed";
    let result: CloudWorkspaceSetupResult | null = null;
    let failure: CloudWorkspaceSetupError | null = null;
    try {
      const now = this.now();
      const endpoint = validateAdmission(execution, admission, now);
      if (signal.aborted) {
        throw setupError(
          "setup_execution_aborted",
          "Cloud workspace setup execution was aborted",
          true,
        );
      }
      const request = encodeRequest(execution, admission, endpoint, now);
      let encoded = request;
      let artifactUrl: string | undefined;
      if (execution.runtime) {
        if (execution.provider.name !== "boat" || !this.options.runtimeArtifacts || !this.options.resolveRuntimeArtifact)
          throw setupError("cloud_runtime_unavailable", "Cloud workspace runtime delivery is unavailable", false);
        const artifact = await this.options.resolveRuntimeArtifact(execution.runtime);
        if (!artifact || artifact.descriptor.runtimeId !== execution.runtime.runtimeId ||
          artifact.descriptor.manifestSha256 !== execution.runtime.manifestSha256 ||
          artifact.descriptor.engineProtocolVersion !== execution.runtime.engineProtocolVersion ||
          artifact.descriptor.engineProtocolVersion !== this.engineProtocolVersion)
          throw setupError("cloud_runtime_unavailable", "Cloud workspace runtime delivery is unavailable", false);
        const delivery = await this.options.runtimeArtifacts.presignGet(artifact.objectKey, 900);
        const expires = Date.parse(delivery.expiresAt);
        const issuedAt = this.now();
        if (!Number.isFinite(expires) || expires <= issuedAt || expires > issuedAt + 900_000)
          throw setupError("setup_runtime_input_invalid", "Cloud workspace runtime input is invalid", false);
        artifactUrl = delivery.url;
        const input = RuntimeInstallInputSchema.safeParse({ schema: "zeros.runtime-install/v1", purpose: "workspace-setup",
          runtime: artifact.descriptor, artifact: delivery, setup: request });
        if (!input.success) throw setupError("setup_runtime_input_invalid", "Cloud workspace runtime input is invalid", false);
        encoded = Buffer.from(JSON.stringify(input.data), "utf8").toString("base64url");
        if (encoded.length > RUNTIME_INSTALL_MAX_ENCODED_BYTES)
          throw setupError("setup_runtime_input_invalid", "Cloud workspace runtime input is invalid", false);
      }
      const response = await commandRunner.execute(
        {
          resourceId: execution.provider.resourceId,
          command: execution.runtime ? CLOUD_WORKSPACE_RUNTIME_INSTALL_COMMAND : CLOUD_WORKSPACE_LINUX_SETUP_HELPER_COMMAND,
          cwd: "/",
          env: { [SETUP_REQUEST_ENV]: encoded },
          ...(execution.runtime ? { runtimeBaseCompatibilityId: execution.runtime.baseCompatibilityId } : {}),
          timeoutSeconds: this.timeoutSeconds,
        },
        signal,
      );
      if (response.output.includes(admission.token) || (artifactUrl && response.output.includes(artifactUrl)) ||
        (execution.runtime && response.output.includes(encoded))) {
        throw setupError(
          "setup_helper_secret_echo",
          "Cloud workspace setup helper exposed its admission",
          false,
        );
      }
      if (response.outputTruncated) {
        throw setupError(
          "setup_helper_response_truncated",
          "Cloud workspace setup helper response was truncated",
          false,
        );
      }
      const installed = execution.runtime ? runtimeInstallerOutput(response.output, response.exitCode) : null;
      const output = installed?.output ?? response.output;
      if (response.exitCode !== 0) throw withInstallerDiagnostic(helperFailure(output, execution), installed?.diagnostic);
      result = parseReadyResponse(
        output,
        execution,
        this.engineProtocolVersion,
      );
      // V4 installer output is a closed diagnostic boundary. The helper sees
      // only its nested payload, but never persist arbitrary installer stdout.
      if (execution.runtime) result = { readiness: result.readiness, logTruncated: false };
      disposition = "completed";
    } catch (error) {
      failure = normalizeExecutionError(error);
      await this.retain(execution,failure,execution.runtime ? "runtime" : "bootstrap",error);
      if (failure.code === "setup_admission_invalid") disposition = "rejected";
    }

    try {
      await this.admissionBroker.revoke(admission, disposition);
    } catch (error) {
      const revokeFailure = setupError(
        "setup_admission_revoke_failed",
        "Cloud workspace setup admission could not be retired",
        true,
      );
      await this.retain(execution,revokeFailure,"setup_admission",error);
      throw revokeFailure;
    }
    if (failure) throw failure;
    return result!;
  }
}

export { CloudWorkspaceLinuxSetupExecutor as DaytonaCloudWorkspaceSetupExecutor };

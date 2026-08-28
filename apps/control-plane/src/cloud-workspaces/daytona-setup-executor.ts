import { CloudProviderError } from "./provider.js";
import {
  CloudWorkspaceSetupError,
  cloudWorkspaceSetupReadinessMatches,
  type CloudWorkspaceSetupExecution,
  type CloudWorkspaceSetupExecutor,
  type CloudWorkspaceSetupReadiness,
  type CloudWorkspaceSetupResult,
} from "./setup-worker.js";

export const DAYTONA_SETUP_HELPER_COMMAND =
  "/usr/bin/flock --exclusive --nonblock /run/zeros/setup.lock /usr/local/bin/node /usr/local/lib/zeros/setup-cloud-workspace.mjs";
const SETUP_REQUEST_ENV = "ZEROS_CLOUD_WORKSPACE_SETUP_B64";
const SETUP_REQUEST_AUDIENCE = "zeros-cloud-workspace-setup-v1";
const SETUP_RESULT_AUDIENCE = "zeros-cloud-workspace-setup-result-v1";
const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_LOG_BYTES = 128 * 1024;
const MIN_ADMISSION_REMAINING_MS = 5_000;
const MAX_ADMISSION_LIFETIME_MS = 15 * 60_000;
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

export interface DaytonaSetupCommandRunner {
  execute(
    input: {
      resourceId: string;
      command: string;
      cwd?: string;
      env?: Readonly<Record<string, string>>;
      timeoutSeconds: number;
    },
    signal: AbortSignal,
  ): Promise<{
    exitCode: number;
    output: string;
    outputTruncated: boolean;
  }>;
}

export type DaytonaCloudWorkspaceSetupExecutorOptions = {
  admissionBroker: CloudWorkspaceSetupAdmissionBroker;
  commandRunner: DaytonaSetupCommandRunner;
  engineProtocolVersion: number;
  timeoutSeconds: number;
  now?: () => number;
};

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
  image_contract_invalid: {
    code: "setup_image_contract_invalid",
    retryable: false,
  },
  repository_revision_invalid: {
    code: "setup_repository_revision_invalid",
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
    execution.provider.name !== "daytona" ||
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
    expiresAt - now < MIN_ADMISSION_REMAINING_MS ||
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

function helperFailure(output: string): CloudWorkspaceSetupError {
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    if (
      exactKeys(parsed, ["audience", "code", "outcome", "version"]) &&
      parsed.version === 1 &&
      parsed.audience === SETUP_RESULT_AUDIENCE &&
      parsed.outcome === "error" &&
      typeof parsed.code === "string"
    ) {
      const mapped = HELPER_FAILURES[parsed.code];
      if (mapped) {
        return setupError(
          mapped.code,
          "Cloud workspace setup helper did not complete",
          mapped.retryable,
        );
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
    return setupError(
      code,
      "Cloud workspace provider command did not complete",
      error.retryable,
    );
  }
  return setupError(
    "setup_provider_failure",
    "Cloud workspace provider command did not complete",
    true,
  );
}

export class DaytonaCloudWorkspaceSetupExecutor implements CloudWorkspaceSetupExecutor {
  private readonly admissionBroker: CloudWorkspaceSetupAdmissionBroker;
  private readonly commandRunner: DaytonaSetupCommandRunner;
  private readonly engineProtocolVersion: number;
  private readonly timeoutSeconds: number;
  private readonly now: () => number;

  constructor(options: DaytonaCloudWorkspaceSetupExecutorOptions) {
    if (
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
    this.commandRunner = options.commandRunner;
    this.engineProtocolVersion = options.engineProtocolVersion;
    this.timeoutSeconds = options.timeoutSeconds;
    this.now = options.now ?? Date.now;
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

    let admission: CloudWorkspaceSetupAdmission;
    try {
      admission = await this.admissionBroker.issue(execution, signal);
    } catch (error) {
      if (error instanceof CloudWorkspaceSetupError) throw error;
      throw setupError(
        "setup_admission_unavailable",
        "Cloud workspace setup admission is temporarily unavailable",
        true,
      );
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
      const response = await this.commandRunner.execute(
        {
          resourceId: execution.provider.resourceId,
          command: DAYTONA_SETUP_HELPER_COMMAND,
          cwd: "/",
          env: { [SETUP_REQUEST_ENV]: request },
          timeoutSeconds: this.timeoutSeconds,
        },
        signal,
      );
      if (response.output.includes(admission.token)) {
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
      if (response.exitCode !== 0) throw helperFailure(response.output);
      result = parseReadyResponse(
        response.output,
        execution,
        this.engineProtocolVersion,
      );
      disposition = "completed";
    } catch (error) {
      failure = normalizeExecutionError(error);
      if (failure.code === "setup_admission_invalid") disposition = "rejected";
    }

    try {
      await this.admissionBroker.revoke(admission, disposition);
    } catch {
      throw setupError(
        "setup_admission_revoke_failed",
        "Cloud workspace setup admission could not be retired",
        true,
      );
    }
    if (failure) throw failure;
    return result!;
  }
}

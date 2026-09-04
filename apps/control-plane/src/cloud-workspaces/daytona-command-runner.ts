import {
  Configuration as DaytonaConfiguration,
  SandboxApi,
} from "@daytona/api-client";
import {
  Configuration as DaytonaToolboxConfiguration,
  ProcessApi,
} from "@daytona/toolbox-api-client";

import { normalizeDaytonaError } from "./daytona-provider.js";
import { CloudProviderError } from "./provider.js";

const MAX_ENV_ENTRIES = 128;
const MAX_ENV_VALUE_BYTES = 32 * 1024;
const MAX_ENV_TOTAL_BYTES = 128 * 1024;
const MAX_COMMAND_BYTES = 4 * 1024;
const MAX_CWD_BYTES = 4 * 1024;
const MAX_RESOURCE_ID_BYTES = 512;

export type DaytonaCommandResponseLike = {
  exitCode: number;
  result: string;
  artifacts?: { stdout: string } | undefined;
};

export type DaytonaCommandSandboxLike = {
  id: string;
  process: {
    executeCommand(
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeoutSeconds?: number,
      signal?: AbortSignal,
    ): Promise<DaytonaCommandResponseLike>;
  };
};

export interface DaytonaCommandClientLike {
  get(
    resourceId: string,
    signal?: AbortSignal,
  ): Promise<DaytonaCommandSandboxLike>;
}

export type DaytonaSandboxCommandRunnerConfig = {
  apiKey: string;
  apiUrl: string;
  /** Explicit SSRF allowlist for provider-returned toolbox proxy URLs. */
  allowedToolboxOrigins: readonly string[];
  /** Local bound for the read-only SDK sandbox lookup. */
  lookupTimeoutMs: number;
  /** Every mutating command also carries its own Daytona server-side bound. */
  maxCommandTimeoutSeconds: number;
  /** Extra local wait after Daytona's server-side command deadline. */
  commandResponseGraceMs?: number;
  maxOutputBytes: number;
};

export type DaytonaSandboxCommandInput = {
  resourceId: string;
  command: string;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  timeoutSeconds: number;
};

export type DaytonaSandboxCommandResult = {
  exitCode: number;
  output: string;
  outputTruncated: boolean;
};

function assertSafeInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
}

function invalidCommand(): CloudProviderError {
  return new CloudProviderError(
    "provider_command_invalid",
    "Cloud sandbox command input is invalid",
    false,
  );
}

function abortError(): CloudProviderError {
  return new CloudProviderError(
    "provider_command_aborted",
    "Cloud sandbox command was aborted",
    true,
  );
}

function timedOutError(): CloudProviderError {
  return new CloudProviderError(
    "provider_command_response_timeout",
    "Cloud sandbox command response exceeded its bounded deadline",
    true,
  );
}

function allowedOrigins(values: readonly string[]): ReadonlySet<string> {
  if (values.length < 1 || values.length > 8) {
    throw new Error(
      "allowedToolboxOrigins must contain between 1 and 8 origins",
    );
  }
  const result = new Set<string>();
  for (const raw of values) {
    let value: URL;
    try {
      value = new URL(raw);
    } catch {
      throw new Error("allowedToolboxOrigins must contain HTTPS origins");
    }
    if (
      value.protocol !== "https:" ||
      value.username ||
      value.password ||
      value.pathname !== "/" ||
      value.search ||
      value.hash ||
      raw.replace(/\/$/, "") !== value.origin
    ) {
      throw new Error("allowedToolboxOrigins must contain HTTPS origins");
    }
    result.add(value.origin);
  }
  return result;
}

export function daytonaToolboxResourceUrl(
  raw: string,
  resourceId: string,
  allowed: ReadonlySet<string>,
): string {
  let value: URL;
  try {
    value = new URL(raw);
  } catch {
    throw new CloudProviderError(
      "provider_toolbox_url_invalid",
      "Daytona returned an invalid toolbox proxy URL",
      false,
    );
  }
  if (
    value.protocol !== "https:" ||
    value.username ||
    value.password ||
    value.search ||
    value.hash ||
    !allowed.has(value.origin)
  ) {
    throw new CloudProviderError(
      "provider_toolbox_url_invalid",
      "Daytona returned an unapproved toolbox proxy URL",
      false,
    );
  }
  if (!value.pathname.endsWith("/")) value.pathname += "/";
  value.pathname += encodeURIComponent(resourceId);
  return value.toString().replace(/\/$/, "");
}

function boundedText(
  value: string,
  maximumBytes: number,
): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) {
    return { value, truncated: false };
  }
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maximumBytes) break;
    result += character;
    bytes += size;
  }
  return { value: result, truncated: true };
}

function validateInput(
  input: DaytonaSandboxCommandInput,
  maxCommandTimeoutSeconds: number,
): {
  resourceId: string;
  command: string;
  cwd: string | undefined;
  env: Record<string, string> | undefined;
  timeoutSeconds: number;
} {
  if (
    typeof input.resourceId !== "string" ||
    input.resourceId.trim() !== input.resourceId ||
    Buffer.byteLength(input.resourceId, "utf8") < 1 ||
    Buffer.byteLength(input.resourceId, "utf8") > MAX_RESOURCE_ID_BYTES ||
    /[\0\r\n]/.test(input.resourceId) ||
    typeof input.command !== "string" ||
    input.command.trim() !== input.command ||
    Buffer.byteLength(input.command, "utf8") < 1 ||
    Buffer.byteLength(input.command, "utf8") > MAX_COMMAND_BYTES ||
    /[\0\r\n]/.test(input.command) ||
    !Number.isSafeInteger(input.timeoutSeconds) ||
    input.timeoutSeconds < 1 ||
    input.timeoutSeconds > maxCommandTimeoutSeconds
  ) {
    throw invalidCommand();
  }
  if (
    input.cwd !== undefined &&
    (typeof input.cwd !== "string" ||
      !input.cwd.startsWith("/") ||
      input.cwd.trim() !== input.cwd ||
      Buffer.byteLength(input.cwd, "utf8") > MAX_CWD_BYTES ||
      /[\0\r\n]/.test(input.cwd))
  ) {
    throw invalidCommand();
  }

  let env: Record<string, string> | undefined;
  if (input.env !== undefined) {
    const entries = Object.entries(input.env);
    if (entries.length > MAX_ENV_ENTRIES) throw invalidCommand();
    env = Object.create(null) as Record<string, string>;
    let totalBytes = 0;
    for (const [name, value] of entries) {
      if (
        !/^[A-Z_][A-Z0-9_]{0,127}$/.test(name) ||
        typeof value !== "string" ||
        /\0/.test(value)
      ) {
        throw invalidCommand();
      }
      const valueBytes = Buffer.byteLength(value, "utf8");
      totalBytes += Buffer.byteLength(name, "utf8") + valueBytes;
      if (
        valueBytes > MAX_ENV_VALUE_BYTES ||
        totalBytes > MAX_ENV_TOTAL_BYTES
      ) {
        throw invalidCommand();
      }
      env[name] = value;
    }
  }
  return {
    resourceId: input.resourceId,
    command: input.command,
    cwd: input.cwd,
    env,
    timeoutSeconds: input.timeoutSeconds,
  };
}

function boundedWait<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  timeoutError: () => Error,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortError()));
    const timer = setTimeout(
      () => finish(() => reject(timeoutError())),
      timeoutMs,
    );
    timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

class GeneratedDaytonaCommandClient implements DaytonaCommandClientLike {
  private readonly api: SandboxApi;

  constructor(
    private readonly config: DaytonaSandboxCommandRunnerConfig,
    private readonly approvedToolboxOrigins: ReadonlySet<string>,
    private readonly responseGraceMs: number,
  ) {
    const configuration = new DaytonaConfiguration({
      basePath: config.apiUrl,
      accessToken: config.apiKey,
      baseOptions: {
        headers: {
          "X-Daytona-Source": "zeros-control-plane",
          "X-Daytona-SDK-Version": "0.190.1",
          "User-Agent": "zeros-control-plane/daytona-command-client-0.190.1",
        },
      },
    });
    this.api = new SandboxApi(configuration);
  }

  async get(
    resourceId: string,
    signal?: AbortSignal,
  ): Promise<DaytonaCommandSandboxLike> {
    const sandbox = (
      await this.api.getSandbox(resourceId, undefined, false, {
        timeout: this.config.lookupTimeoutMs,
        maxRedirects: 0,
        maxContentLength: 1024 * 1024,
        ...(signal ? { signal } : {}),
      })
    ).data;
    const basePath = daytonaToolboxResourceUrl(
      sandbox.toolboxProxyUrl,
      sandbox.id,
      this.approvedToolboxOrigins,
    );
    const processApi = new ProcessApi(
      new DaytonaToolboxConfiguration({
        basePath,
        accessToken: this.config.apiKey,
        baseOptions: {
          headers: {
            "X-Daytona-Source": "zeros-control-plane",
            "X-Daytona-SDK-Version": "0.190.1",
            "User-Agent": "zeros-control-plane/daytona-command-client-0.190.1",
          },
        },
      }),
    );
    return {
      id: sandbox.id,
      process: {
        executeCommand: async (
          command,
          cwd,
          env,
          timeoutSeconds,
          commandSignal,
        ) => {
          const response = await processApi.executeCommand(
            {
              command,
              ...(cwd ? { cwd } : {}),
              ...(env && Object.keys(env).length > 0 ? { envs: env } : {}),
              ...(timeoutSeconds !== undefined
                ? { timeout: timeoutSeconds }
                : {}),
            },
            {
              timeout: (timeoutSeconds ?? 0) * 1_000 + this.responseGraceMs,
              maxRedirects: 0,
              maxBodyLength: 512 * 1024,
              maxContentLength: Math.min(
                8 * this.config.maxOutputBytes + 64 * 1024,
                8 * 1024 * 1024,
              ),
              ...(commandSignal ? { signal: commandSignal } : {}),
            },
          );
          return {
            exitCode: response.data.exitCode ?? Number.NaN,
            result: response.data.result,
          };
        },
      },
    };
  }
}

export class DaytonaSandboxCommandRunner {
  private readonly client: DaytonaCommandClientLike;
  private readonly responseGraceMs: number;
  private readonly approvedToolboxOrigins: ReadonlySet<string>;

  constructor(
    private readonly config: DaytonaSandboxCommandRunnerConfig,
    client?: DaytonaCommandClientLike,
  ) {
    assertSafeInteger(config.lookupTimeoutMs, "lookupTimeoutMs", 100, 60_000);
    assertSafeInteger(
      config.maxCommandTimeoutSeconds,
      "maxCommandTimeoutSeconds",
      1,
      24 * 60 * 60,
    );
    assertSafeInteger(config.maxOutputBytes, "maxOutputBytes", 1, 1024 * 1024);
    this.responseGraceMs = config.commandResponseGraceMs ?? 10_000;
    assertSafeInteger(
      this.responseGraceMs,
      "commandResponseGraceMs",
      1_000,
      60_000,
    );
    this.approvedToolboxOrigins = allowedOrigins(config.allowedToolboxOrigins);
    this.client =
      client ??
      new GeneratedDaytonaCommandClient(
        config,
        this.approvedToolboxOrigins,
        this.responseGraceMs,
      );
  }

  async execute(
    rawInput: DaytonaSandboxCommandInput,
    signal: AbortSignal,
  ): Promise<DaytonaSandboxCommandResult> {
    const input = validateInput(rawInput, this.config.maxCommandTimeoutSeconds);
    try {
      if (signal.aborted) throw abortError();
      const sandbox = await boundedWait(
        this.client.get(input.resourceId, signal),
        signal,
        this.config.lookupTimeoutMs,
        () =>
          new CloudProviderError(
            "provider_lookup_timeout",
            "Cloud sandbox lookup exceeded its bounded deadline",
            true,
          ),
      );
      if (sandbox.id !== input.resourceId) {
        throw new CloudProviderError(
          "provider_resource_mismatch",
          "Daytona resolved a different sandbox than the bound resource",
          false,
        );
      }
      const response = await boundedWait(
        sandbox.process.executeCommand(
          input.command,
          input.cwd,
          input.env,
          input.timeoutSeconds,
          signal,
        ),
        signal,
        input.timeoutSeconds * 1_000 + this.responseGraceMs,
        timedOutError,
      );
      if (!Number.isSafeInteger(response.exitCode)) {
        throw new CloudProviderError(
          "provider_response_invalid",
          "Daytona returned an invalid command response",
          true,
        );
      }
      const output =
        typeof response.result === "string"
          ? response.result
          : response.artifacts?.stdout;
      if (typeof output !== "string") {
        throw new CloudProviderError(
          "provider_response_invalid",
          "Daytona returned an invalid command response",
          true,
        );
      }
      const bounded = boundedText(output, this.config.maxOutputBytes);
      return {
        exitCode: response.exitCode,
        output: bounded.value,
        outputTruncated: bounded.truncated,
      };
    } catch (error) {
      if (error instanceof CloudProviderError) throw error;
      throw normalizeDaytonaError(error, "execute command");
    }
  }
}

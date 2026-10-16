import {
  isAgentControlFamily,
  isBrowserProductId,
  type AgentControlFamily,
} from "@zeros/protocol/browser-tools";
import {
  COMPUTER_USE_SERVICE_VERSION,
  isComputerToolName,
  type ComputerToolContent,
  type ComputerToolInvokeRequest,
  type ComputerToolResult,
  type ComputerUseOwner,
  type ComputerUseReleaseRequest,
} from "@zeros/protocol/computer-use-tools";
import {
  DEVICE_TOOLS_SERVICE_VERSION,
  isDeviceToolName,
  type DeviceToolInvokeRequest,
  type DeviceToolResult,
  type DeviceUseOwner,
  type DeviceUseReleaseRequest,
} from "@zeros/protocol/device-tools";

import {
  loopbackServiceConfig,
  type LoopbackServiceConfig,
} from "./loopback-service";

export const AGENT_CONTROL_SERVICE_URL_ENV =
  "ZEROS_AGENT_CONTROL_SERVICE_URL" as const;
export const AGENT_CONTROL_SERVICE_TOKEN_ENV =
  "ZEROS_AGENT_CONTROL_SERVICE_TOKEN" as const;

// One call can wait for another chat (5 min), then for the user's approval
// (4 min), then run (1 min). Stay above all three so main reports the outcome.
const INVOKE_TIMEOUT_MS = 11 * 60_000;
const CONTROL_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;

type ServiceEnv = Record<string, string | undefined>;

// The service credential is a main→engine capability. Capture it as this
// module loads, then scrub both names before an agent process can inherit
// them.
const inheritedServiceEnv: ServiceEnv = {
  [AGENT_CONTROL_SERVICE_URL_ENV]: process.env[AGENT_CONTROL_SERVICE_URL_ENV],
  [AGENT_CONTROL_SERVICE_TOKEN_ENV]: process.env[AGENT_CONTROL_SERVICE_TOKEN_ENV],
};
delete process.env[AGENT_CONTROL_SERVICE_URL_ENV];
delete process.env[AGENT_CONTROL_SERVICE_TOKEN_ENV];

interface ClientOptions {
  env?: ServiceEnv;
  fetchImpl?: typeof fetch;
}

export function resolveAgentControlServiceConfig(
  env: ServiceEnv = inheritedServiceEnv,
): LoopbackServiceConfig | null {
  return loopbackServiceConfig(
    env[AGENT_CONTROL_SERVICE_URL_ENV],
    env[AGENT_CONTROL_SERVICE_TOKEN_ENV],
  );
}

function validOwner(owner: ComputerUseOwner | DeviceUseOwner): boolean {
  return (
    isBrowserProductId(owner.workspaceId) &&
    isBrowserProductId(owner.conversationId)
  );
}

/** Run one `zeros_computer` call in Electron main. Refusals and tool
 * failures come back as `success: false`; transport and contract errors
 * reject. */
export async function invokeZerosComputerTool(
  request: Omit<ComputerToolInvokeRequest, "version">,
  options: ClientOptions & { signal?: AbortSignal } = {},
): Promise<ComputerToolResult> {
  if (
    !validOwner(request.owner) ||
    !isAgentControlFamily(request.agent) ||
    !isBrowserProductId(request.turnId) ||
    !isComputerToolName(request.tool)
  ) {
    throw new Error("Invalid Zeros computer tool request.");
  }
  const config = resolveAgentControlServiceConfig(options.env);
  if (!config) {
    throw new Error("Computer use is unavailable. Restart Zeros and try again.");
  }
  return parseToolResult(
    await postJson(
      options.fetchImpl ?? fetch,
      config,
      "/v1/computer/invoke",
      { version: COMPUTER_USE_SERVICE_VERSION, ...request },
      INVOKE_TIMEOUT_MS,
      options.signal,
    ),
    COMPUTER_USE_SERVICE_VERSION,
    "computer",
  );
}

/** Run one `zeros_device` call in Electron main. Refusals and tool failures
 * come back as `success: false`; transport and contract errors reject. */
export async function invokeZerosDeviceTool(
  request: Omit<DeviceToolInvokeRequest, "version">,
  options: ClientOptions & { signal?: AbortSignal } = {},
): Promise<DeviceToolResult> {
  if (
    !validOwner(request.owner) ||
    !isAgentControlFamily(request.agent) ||
    !isBrowserProductId(request.turnId) ||
    !isDeviceToolName(request.tool)
  ) {
    throw new Error("Invalid Zeros simulator tool request.");
  }
  const config = resolveAgentControlServiceConfig(options.env);
  if (!config) {
    throw new Error("Simulators are unavailable. Restart Zeros and try again.");
  }
  return parseToolResult(
    await postJson(
      options.fetchImpl ?? fetch,
      config,
      "/v1/device/invoke",
      { version: DEVICE_TOOLS_SERVICE_VERSION, ...request },
      INVOKE_TIMEOUT_MS,
      options.signal,
    ),
    DEVICE_TOOLS_SERVICE_VERSION,
    "simulator",
  );
}

/** Let go of the chat's simulators: its turn ended, the user pressed Stop,
 * or the conversation is gone (`retire`, which also forgets its simulator
 * approvals). False when it held nothing or the service is absent. */
export async function releaseZerosDeviceUse(
  owner: DeviceUseOwner,
  reason: DeviceUseReleaseRequest["reason"],
  options: ClientOptions = {},
): Promise<boolean> {
  if (!validOwner(owner)) return false;
  const config = resolveAgentControlServiceConfig(options.env);
  if (!config) return false;
  const result = asRecord(
    await postJson(
      options.fetchImpl ?? fetch,
      config,
      "/v1/device/release",
      { version: DEVICE_TOOLS_SERVICE_VERSION, owner, reason },
      CONTROL_TIMEOUT_MS,
    ),
  );
  if (
    result.version !== DEVICE_TOOLS_SERVICE_VERSION ||
    typeof result.released !== "boolean"
  ) {
    throw new Error("Zeros agent control returned an invalid release result.");
  }
  return result.released;
}

/** End the chat's control of the Mac: its turn ended, the user pressed
 * Stop, or the conversation is gone (`retire`, which also forgets its app
 * approvals). False when it held nothing or the service is absent. */
export async function releaseZerosComputerUse(
  owner: ComputerUseOwner,
  reason: ComputerUseReleaseRequest["reason"],
  options: ClientOptions = {},
): Promise<boolean> {
  if (!validOwner(owner)) return false;
  const config = resolveAgentControlServiceConfig(options.env);
  if (!config) return false;
  const result = asRecord(
    await postJson(
      options.fetchImpl ?? fetch,
      config,
      "/v1/computer/release",
      { version: COMPUTER_USE_SERVICE_VERSION, owner, reason },
      CONTROL_TIMEOUT_MS,
    ),
  );
  if (
    result.version !== COMPUTER_USE_SERVICE_VERSION ||
    typeof result.released !== "boolean"
  ) {
    throw new Error("Zeros agent control returned an invalid release result.");
  }
  return result.released;
}

/** Tell main that Codex's built-in computer use started or stopped in this
 * chat, so other chats wait for it. */
export async function reportNativeComputerUse(
  owner: ComputerUseOwner,
  agent: AgentControlFamily,
  active: boolean,
  options: ClientOptions = {},
): Promise<boolean> {
  if (!validOwner(owner) || !isAgentControlFamily(agent)) return false;
  const config = resolveAgentControlServiceConfig(options.env);
  if (!config) return false;
  const result = asRecord(
    await postJson(
      options.fetchImpl ?? fetch,
      config,
      "/v1/computer/native-activity",
      { version: COMPUTER_USE_SERVICE_VERSION, owner, agent, active },
      CONTROL_TIMEOUT_MS,
    ),
  );
  return result.accepted === true;
}

async function postJson(
  fetchImpl: typeof fetch,
  config: LoopbackServiceConfig,
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(`${config.baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
  });
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error("Zeros agent control response exceeded its size limit.");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("Zeros agent control response exceeded its size limit.");
  }
  if (!response.ok) {
    throw new Error(`Zeros agent control rejected the request (${response.status}).`);
  }
  return JSON.parse(text);
}

function parseToolResult<V extends number>(
  value: unknown,
  version: V,
  what: "computer" | "simulator",
): { version: V; success: boolean; content: ComputerToolContent[] } {
  const invalid = () =>
    new Error(`Zeros agent control returned an invalid ${what} result.`);
  const record = asRecord(value);
  if (
    record.version !== version ||
    typeof record.success !== "boolean" ||
    !Array.isArray(record.content)
  ) {
    throw invalid();
  }
  const content = record.content.map((item): ComputerToolContent => {
    const entry =
      item && typeof item === "object" && !Array.isArray(item)
        ? (item as Record<string, unknown>)
        : {};
    if (entry.type === "text" && typeof entry.text === "string") {
      return { type: "text", text: entry.text };
    }
    if (
      entry.type === "image" &&
      typeof entry.data === "string" &&
      (entry.mimeType === "image/png" || entry.mimeType === "image/jpeg")
    ) {
      return { type: "image", data: entry.data, mimeType: entry.mimeType };
    }
    throw invalid();
  });
  return { version, success: record.success, content };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Zeros agent control returned malformed JSON.");
  }
  return value as Record<string, unknown>;
}

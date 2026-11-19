import {
  BROWSER_SERVICE_VERSION,
  browserRouteSettings,
  isAgentControlFamily,
  isBrowserProductId,
  isBrowserToolName,
  resolveBrowserRoute,
  type AgentControlFamily,
  type BrowserJsonValue,
  type BrowserRoute,
  type BrowserToolContent,
  type BrowserToolName,
  type BrowserToolResult,
} from "@zeros/protocol/browser-tools";
import { gateBrowserRouteSettings } from "@zeros/protocol/agent-control-rollout";

import { agentControlAvailability } from "../agent-control/availability";
import {
  AGENT_CONTROL_SERVICE_TOKEN_ENV,
  AGENT_CONTROL_SERVICE_URL_ENV,
} from "../agent-control/control-service-client";
import {
  loopbackServiceConfig,
  type LoopbackServiceConfig,
} from "../agent-control/loopback-service";
import { opSettingsResolve } from "../settings/ops";

const URL_ENV = "ZEROS_BROWSER_SERVICE_URL";
const TOKEN_ENV = "ZEROS_BROWSER_SERVICE_TOKEN";
const ACQUIRE_TIMEOUT_MS = 5_000;
// Outlast the host's download deadline and any pending Browser approval so the host can report the outcome.
const INVOKE_TIMEOUT_MS = 10 * 60_000;
const STOP_TIMEOUT_MS = 2_000;
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;

type BrowserServiceEnv = Record<string, string | undefined>;

// Capture the main-process capability before scrubbing it from provider subprocess inheritance.
const inheritedServiceEnv: BrowserServiceEnv = {
  [URL_ENV]: process.env[URL_ENV],
  [TOKEN_ENV]: process.env[TOKEN_ENV],
};
delete process.env[URL_ENV];
delete process.env[TOKEN_ENV];

export type BrowserServiceConfig = LoopbackServiceConfig;

interface AcquireZerosBrowserHostOptions {
  workspaceId: string;
  conversationId: string;
  workspaceRoot: string;
  mainRepoRoot?: string;
  env?: BrowserServiceEnv;
  fetchImpl?: typeof fetch;
}

interface ActiveBrowserBinding {
  browserSessionId: string;
  config: BrowserServiceConfig;
  fetchImpl: typeof fetch;
}

interface ReleaseZerosBrowserConversationOptions {
  env?: BrowserServiceEnv;
  fetchImpl?: typeof fetch;
}

interface InvokeZerosBrowserToolOptions {
  browserSessionId: string;
  tool: BrowserToolName;
  arguments: BrowserJsonValue;
  agent?: AgentControlFamily;
  signal?: AbortSignal;
  env?: BrowserServiceEnv;
  fetchImpl?: typeof fetch;
}

interface StopZerosBrowserActionOptions {
  browserSessionId: string;
  env?: BrowserServiceEnv;
  fetchImpl?: typeof fetch;
}

const activeBindings = new Map<string, ActiveBrowserBinding>();
const ownerGenerations = new Map<string, number>();

export function resolveBrowserServiceConfig(
  env: BrowserServiceEnv = inheritedServiceEnv,
): BrowserServiceConfig | null {
  return loopbackServiceConfig(env[URL_ENV], env[TOKEN_ENV]);
}

/** Main→engine capabilities that no provider subprocess may inherit. */
const HOST_CAPABILITY_ENV = [
  URL_ENV,
  TOKEN_ENV,
  "ZEROS_DESIGN_CAPTURE_URL",
  "ZEROS_DESIGN_CAPTURE_TOKEN",
  "ZEROS_DESIGN_CAPTURE_RENDERER",
  "ZEROS_DESIGN_CAPTURE_RECORDER",
  AGENT_CONTROL_SERVICE_URL_ENV,
  AGENT_CONTROL_SERVICE_TOKEN_ENV,
] as const;

export function stripBrowserServiceCredentials(
  env: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (
    !env ||
    !HOST_CAPABILITY_ENV.some((name) =>
      Object.prototype.hasOwnProperty.call(env, name),
    )
  ) {
    return env;
  }
  const safe = { ...env };
  for (const name of HOST_CAPABILITY_ENV) delete safe[name];
  return safe;
}

export function claudeChromeEnabledForWorkspace(
  workspaceRoot: string,
  mainRepoRoot?: string,
): boolean {
  return browserRouteForWorkspace("claude", workspaceRoot, mainRepoRoot) === "claude-chrome";
}

export function browserRouteForWorkspace(
  agentFamily: string,
  workspaceRoot: string,
  mainRepoRoot?: string,
): BrowserRoute {
  return resolveBrowserRoute(
    agentFamily,
    gateBrowserRouteSettings(
      browserRouteSettings(opSettingsResolve(workspaceRoot, mainRepoRoot).effective.browser),
      agentControlAvailability(),
    ),
  );
}

/** The caller must apply the agent routing table before acquiring a host session. */
export async function acquireZerosBrowserToolSession(
  options: Omit<AcquireZerosBrowserHostOptions, "mainRepoRoot">,
): Promise<{ browserSessionId: string } | null> {
  if (!isBrowserProductId(options.workspaceId)) {
    throw new Error("Zeros browser workspace identity is invalid.");
  }
  if (!isBrowserProductId(options.conversationId)) {
    throw new Error("Zeros browser conversation identity is invalid.");
  }
  const key = ownerKey(options.workspaceId, options.conversationId);
  const generation = ownerGenerations.get(key) ?? 0;
  const config = resolveBrowserServiceConfig(options.env);
  if (!config) return null;
  const fetchImpl = options.fetchImpl ?? fetch;
  const acquired = await requestJson(
    fetchImpl,
    `${config.baseUrl}/v1/sessions/acquire`,
    config,
    {
      version: BROWSER_SERVICE_VERSION,
      owner: {
        workspaceId: options.workspaceId,
        conversationId: options.conversationId,
        workspaceRoot: options.workspaceRoot,
      },
    },
    ACQUIRE_TIMEOUT_MS,
  );
  const parsed = parseAcquireResponse(acquired);
  const binding = {
    browserSessionId: parsed.browserSessionId,
    config,
    fetchImpl,
  };
  // If deletion wins the acquire race, close the new session instead of publishing an orphan.
  if ((ownerGenerations.get(key) ?? 0) !== generation) {
    await closeBinding(binding).catch(() => false);
    return null;
  }
  activeBindings.set(key, binding);

  return { browserSessionId: parsed.browserSessionId };
}

/** Tool failures return success: false; transport and contract failures reject. */
export async function invokeZerosBrowserTool(
  options: InvokeZerosBrowserToolOptions,
): Promise<BrowserToolResult> {
  if (
    !isToolSessionId(options.browserSessionId) ||
    !isBrowserToolName(options.tool) ||
    (options.agent !== undefined && !isAgentControlFamily(options.agent))
  ) {
    throw new Error("Invalid Zeros browser tool request.");
  }
  const config = resolveBrowserServiceConfig(options.env);
  if (!config) {
    throw new Error(
      "The Zeros browser is unavailable; restart the desktop app.",
    );
  }
  return parseToolResult(
    await requestJson(
      options.fetchImpl ?? fetch,
      `${config.baseUrl}/v1/sessions/${encodeURIComponent(options.browserSessionId)}/invoke`,
      config,
      {
        version: BROWSER_SERVICE_VERSION,
        tool: options.tool,
        arguments: options.arguments,
        ...(options.agent ? { agent: options.agent } : {}),
      },
      INVOKE_TIMEOUT_MS,
      options.signal,
    ),
  );
}

/** Stop interrupts the action without closing the page. */
export async function stopZerosBrowserAction(
  options: StopZerosBrowserActionOptions,
): Promise<boolean> {
  if (!isToolSessionId(options.browserSessionId)) return false;
  const config = resolveBrowserServiceConfig(options.env);
  if (!config) return false;
  const result = asRecord(
    await requestJson(
      options.fetchImpl ?? fetch,
      `${config.baseUrl}/v1/sessions/${encodeURIComponent(options.browserSessionId)}/stop`,
      config,
      { version: BROWSER_SERVICE_VERSION },
      STOP_TIMEOUT_MS,
    ),
  );
  if (
    result.version !== BROWSER_SERVICE_VERSION ||
    typeof result.stopped !== "boolean"
  ) {
    throw new Error("Zeros browser service returned an invalid stop result.");
  }
  return result.stopped;
}

/** Execution teardown must not release the conversation-owned lease; resume and rebuild reuse it. */
export async function releaseZerosBrowserConversation(
  workspaceId: string,
  conversationId: string,
  options?: ReleaseZerosBrowserConversationOptions,
): Promise<boolean> {
  const key = ownerKey(workspaceId, conversationId);
  ownerGenerations.set(key, (ownerGenerations.get(key) ?? 0) + 1);
  const active = activeBindings.get(key);
  if (active) {
    activeBindings.delete(key);
    return closeBinding(active);
  }
  // Release by durable owner when an engine restart lost the binding but the host kept the page.
  if (!isBrowserProductId(workspaceId) || !isBrowserProductId(conversationId)) {
    return false;
  }
  const config = resolveBrowserServiceConfig(options?.env);
  if (!config) return false;
  const fetchImpl = options?.fetchImpl ?? fetch;
  const result = asRecord(
    await requestJson(
      fetchImpl,
      `${config.baseUrl}/v1/sessions/release`,
      config,
      { version: BROWSER_SERVICE_VERSION, workspaceId, conversationId },
      ACQUIRE_TIMEOUT_MS,
    ),
  );
  if (
    result.version !== BROWSER_SERVICE_VERSION ||
    typeof result.released !== "boolean"
  ) {
    throw new Error(
      "Zeros browser service returned an invalid release result.",
    );
  }
  return result.released;
}

async function closeBinding(active: ActiveBrowserBinding): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ACQUIRE_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await active.fetchImpl(
      `${active.config.baseUrl}/v1/sessions/${encodeURIComponent(active.browserSessionId)}`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${active.config.token}` },
        signal: controller.signal,
      },
    );
    return response.ok;
  } finally {
    clearTimeout(timer);
  }
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  config: BrowserServiceConfig,
  body: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: signal
        ? AbortSignal.any([controller.signal, signal])
        : controller.signal,
    });
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_RESPONSE_BYTES
    ) {
      throw new Error(
        "Zeros browser service response exceeded its size limit.",
      );
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
      throw new Error(
        "Zeros browser service response exceeded its size limit.",
      );
    }
    if (!response.ok) {
      throw new Error(
        `Zeros browser service rejected the request (${response.status}).`,
      );
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function parseAcquireResponse(value: unknown): { browserSessionId: string } {
  const record = asRecord(value);
  if (
    record.version !== BROWSER_SERVICE_VERSION ||
    !isToolSessionId(record.browserSessionId)
  ) {
    throw new Error(
      "Zeros browser service returned an invalid session identity.",
    );
  }
  return { browserSessionId: record.browserSessionId };
}

function parseToolResult(value: unknown): BrowserToolResult {
  const invalid = () =>
    new Error("Zeros browser service returned an invalid tool result.");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid();
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== BROWSER_SERVICE_VERSION ||
    typeof record.success !== "boolean" ||
    !Array.isArray(record.content)
  ) {
    throw invalid();
  }
  const content = record.content.map((item): BrowserToolContent => {
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
      entry.mimeType === "image/jpeg"
    ) {
      return { type: "image", data: entry.data, mimeType: "image/jpeg" };
    }
    throw invalid();
  });
  return {
    version: BROWSER_SERVICE_VERSION,
    success: record.success,
    content,
  };
}

function isToolSessionId(value: unknown): value is string {
  return isBrowserProductId(value) && value.startsWith("browser_");
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Zeros browser service returned malformed JSON.");
  }
  return value as Record<string, unknown>;
}

function ownerKey(workspaceId: string, conversationId: string): string {
  return `${workspaceId}\u0000${conversationId}`;
}

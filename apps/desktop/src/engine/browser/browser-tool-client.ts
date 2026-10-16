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
const TURN_SETTLE_TIMEOUT_MS = 2_000;
// One action can wait for a website approval (4 min) and then a download
// (5 min) inside the host. Stay above both so the host reports the outcome.
const INVOKE_TIMEOUT_MS = 10 * 60_000;
const STOP_TIMEOUT_MS = 2_000;
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;

type BrowserServiceEnv = Record<string, string | undefined>;

// The service credential is a main→engine capability, not ambient provider
// configuration. Capture it as this engine module loads, then scrub both names
// before Codex/Claude/Cursor or their helper subprocesses can inherit them.
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

interface RegisterCodexBrowserUseSessionOptions {
  browserSessionId: string;
  nativeSessionId: string;
  env?: BrowserServiceEnv;
  fetchImpl?: typeof fetch;
}

interface SettleCodexBrowserUseTurnOptions {
  browserSessionId: string;
  nativeSessionId: string;
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

/** Read the per-boot service capability. Credentials stay in the engine
 * process and are never forwarded in an agent subprocess environment. */
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

/** Resolve the trusted Browser-use setting without allocating a Zeros browser
 * session. Claude's official Chrome integration needs only this policy bit;
 * Cursor receives no browser capability; Codex separately acquires an IAB host
 * below. */
export function browserUseEnabledForWorkspace(
  workspaceRoot: string,
  mainRepoRoot?: string,
  provider: "codex" | "claude" = "codex",
): boolean {
  const browser = opSettingsResolve(workspaceRoot, mainRepoRoot).effective
    .browser as
    | {
        enabled?: boolean;
        codex_enabled?: boolean;
        claude_enabled?: boolean;
        provider?: string;
      }
    | undefined;
  const providerEnabled =
    provider === "claude" ? browser?.claude_enabled : browser?.codex_enabled;
  if (providerEnabled === false) return false;
  if (provider === "claude" && providerEnabled !== true) return false;
  if (providerEnabled === undefined && browser?.enabled === false) return false;
  if (browser?.provider !== undefined && browser.provider !== "isolated") {
    throw new Error("Unsupported Zeros browser provider setting.");
  }
  return true;
}

/** Which browser `agentFamily` uses in this Local workspace. Throws on an
 * unsupported host backend so callers fail the capability closed. */
export function browserRouteForWorkspace(
  agentFamily: string,
  workspaceRoot: string,
  mainRepoRoot?: string,
): BrowserRoute {
  const browser = opSettingsResolve(workspaceRoot, mainRepoRoot).effective
    .browser as { provider?: unknown } | undefined;
  if (browser?.provider !== undefined && browser.provider !== "isolated") {
    throw new Error("Unsupported Zeros browser provider setting.");
  }
  return resolveBrowserRoute(
    agentFamily,
    gateBrowserRouteSettings(
      browserRouteSettings(browser),
      agentControlAvailability(),
    ),
  );
}

/** Acquire the conversation's browser as the IAB host for Codex's built-in
 * Browser plugin. Null unless Codex's route is its built-in browser; malformed
 * or unreachable configured services reject so the gateway can emit one
 * diagnostic and continue agent startup without it. */
export async function acquireZerosBrowserHost(
  options: AcquireZerosBrowserHostOptions,
): Promise<{ browserSessionId: string } | null> {
  if (
    browserRouteForWorkspace(
      "codex",
      options.workspaceRoot,
      options.mainRepoRoot,
    ) !== "codex-native"
  ) {
    return null;
  }
  return acquireOwnerSession(options, true);
}

/** Acquire the same conversation-owned browser for the `zeros_browser` tools.
 * The caller has already applied the routing table for its agent. */
export async function acquireZerosBrowserToolSession(
  options: Omit<AcquireZerosBrowserHostOptions, "mainRepoRoot">,
): Promise<{ browserSessionId: string } | null> {
  return acquireOwnerSession(options, false);
}

async function acquireOwnerSession(
  options: AcquireZerosBrowserHostOptions,
  requireCodexIab: boolean,
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
  const parsed = parseAcquireResponse(acquired, requireCodexIab);
  const binding = {
    browserSessionId: parsed.browserSessionId,
    config,
    fetchImpl,
  };
  // Conversation deletion may race a slow service acquire. Do not publish an
  // orphan after the lifecycle owner has detached; close the just-created
  // record best-effort and let agent startup continue without the capability.
  if ((ownerGenerations.get(key) ?? 0) !== generation) {
    await closeBinding(binding).catch(() => false);
    return null;
  }
  activeBindings.set(key, binding);

  return { browserSessionId: parsed.browserSessionId };
}

/** Bind an app-server thread id to the conversation-owned IAB browser host.
 * The service credential stays inside the engine and the app-server receives
 * neither this bearer token nor a Zeros MCP/custom-tool endpoint. */
export async function registerCodexBrowserUseSession(
  options: RegisterCodexBrowserUseSessionOptions,
): Promise<boolean> {
  if (
    !isBrowserProductId(options.browserSessionId) ||
    !options.browserSessionId.startsWith("browser_") ||
    !isNativeSessionId(options.nativeSessionId)
  ) {
    return false;
  }
  const config = resolveBrowserServiceConfig(options.env);
  if (!config) return false;
  const result = asRecord(
    await requestJson(
      options.fetchImpl ?? fetch,
      `${config.baseUrl}/v1/providers/codex/register`,
      config,
      {
        version: BROWSER_SERVICE_VERSION,
        browserSessionId: options.browserSessionId,
        nativeSessionId: options.nativeSessionId,
      },
      ACQUIRE_TIMEOUT_MS,
    ),
  );
  return result.registered === true;
}

/** Tell the host that the owning app-server turn is terminal. OpenAI's IAB
 * client deliberately does not emit its optional `turnEnded` wire event, and
 * a timed-out/reset node_repl batch can skip `tabs.finalize()`. This
 * authenticated engine-owned fallback releases only the matching registered
 * native session; it never exposes a Zeros tool surface to Codex. */
export async function settleCodexBrowserUseTurn(
  options: SettleCodexBrowserUseTurnOptions,
): Promise<boolean> {
  if (
    !isBrowserProductId(options.browserSessionId) ||
    !options.browserSessionId.startsWith("browser_") ||
    !isNativeSessionId(options.nativeSessionId)
  ) {
    return false;
  }
  const config = resolveBrowserServiceConfig(options.env);
  if (!config) return false;
  const result = asRecord(
    await requestJson(
      options.fetchImpl ?? fetch,
      `${config.baseUrl}/v1/providers/codex/turn-ended`,
      config,
      {
        version: BROWSER_SERVICE_VERSION,
        browserSessionId: options.browserSessionId,
        nativeSessionId: options.nativeSessionId,
      },
      TURN_SETTLE_TIMEOUT_MS,
    ),
  );
  if (
    result.version !== BROWSER_SERVICE_VERSION ||
    typeof result.settled !== "boolean"
  ) {
    throw new Error(
      "Zeros browser service returned an invalid native turn result.",
    );
  }
  return result.settled;
}

/** Run one `zeros_browser` tool in the conversation's browser. Tool failures
 * come back as `success: false`; transport and contract errors reject. */
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

/** Interrupt the agent's current browser action and keep the page, as the
 * Browser tab's Stop button does. */
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

/** Detach the product resource when its Zeros conversation is deleted. Agent
 * execution teardown deliberately does not call this: resume/rebuild must keep
 * the same conversation-owned browser lease. */
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
  // Main's browser service survives an engine restart, while this module's
  // in-memory binding map does not. Release by the durable Zeros owner so an
  // orphaned live page cannot survive its conversation.
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

function parseAcquireResponse(
  value: unknown,
  requireCodexIab: boolean,
): { browserSessionId: string } {
  const record = asRecord(value);
  const capabilities =
    record.capabilities &&
    typeof record.capabilities === "object" &&
    !Array.isArray(record.capabilities)
      ? (record.capabilities as Record<string, unknown>)
      : {};
  if (
    record.version !== BROWSER_SERVICE_VERSION ||
    !isToolSessionId(record.browserSessionId)
  ) {
    throw new Error(
      "Zeros browser service returned an invalid session identity.",
    );
  }
  if (requireCodexIab && capabilities.codexIab !== true) {
    throw new Error(
      "Zeros browser service does not provide native Codex IAB; restart the desktop app.",
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

function isNativeSessionId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 256 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  );
}

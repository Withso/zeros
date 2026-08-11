import {
  BROWSER_SERVICE_VERSION,
  BROWSER_TOOL_DEFINITIONS,
  isBrowserProductId,
  type BrowserJsonValue,
  type BrowserSessionAcquireResponse,
  type BrowserToolContent,
  type BrowserToolResult,
} from "@zeros/protocol/browser-tools";

import type { AgentBrowserTools } from "../agents/types";
import { opSettingsResolve } from "../settings/ops";

const URL_ENV = "ZEROS_BROWSER_SERVICE_URL";
const TOKEN_ENV = "ZEROS_BROWSER_SERVICE_TOKEN";
const REQUEST_TIMEOUT_MS = 5 * 60_000;
const ACQUIRE_TIMEOUT_MS = 5_000;
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

export interface BrowserServiceConfig {
  readonly baseUrl: string;
  readonly token: string;
}

interface AcquireZerosBrowserToolsOptions {
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

const activeBindings = new Map<string, ActiveBrowserBinding>();
const ownerGenerations = new Map<string, number>();

/** Read the per-boot service capability. Credentials stay in the engine
 * process and are never forwarded in an agent subprocess environment. */
export function resolveBrowserServiceConfig(
  env: BrowserServiceEnv = inheritedServiceEnv,
): BrowserServiceConfig | null {
  const rawUrl = env[URL_ENV]?.trim();
  const token = env[TOKEN_ENV]?.trim();
  if (!rawUrl || !token || token.length > 1_024) return null;
  try {
    const url = new URL(rawUrl);
    const loopback =
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1" ||
      url.hostname === "[::1]" ||
      url.hostname === "localhost";
    if (
      url.protocol !== "http:" ||
      !loopback ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "")
    ) {
      return null;
    }
    return { baseUrl: url.origin, token };
  } catch {
    return null;
  }
}

export function stripBrowserServiceCredentials(
  env: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!env || (!env[URL_ENV] && !env[TOKEN_ENV])) return env;
  const safe = { ...env };
  delete safe[URL_ENV];
  delete safe[TOKEN_ENV];
  return safe;
}

/** Acquire the single Zeros browser identity for a workspace+conversation.
 * Absence/disablement is an optional capability; malformed or unreachable
 * configured services reject so the gateway can emit one diagnostic and
 * continue agent startup without browser tools. */
export async function acquireZerosBrowserTools(
  options: AcquireZerosBrowserToolsOptions,
): Promise<AgentBrowserTools | null> {
  const browser = opSettingsResolve(options.workspaceRoot, options.mainRepoRoot)
    .effective.browser as { enabled?: boolean; provider?: string } | undefined;
  if (browser?.enabled === false) return null;
  if (browser?.provider !== undefined && browser.provider !== "isolated") {
    throw new Error("Unsupported Zeros browser provider setting.");
  }
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
  // Conversation deletion may race a slow service acquire. Do not publish an
  // orphan after the lifecycle owner has detached; close the just-created
  // record best-effort and let agent startup continue without the capability.
  if ((ownerGenerations.get(key) ?? 0) !== generation) {
    await closeBinding(binding).catch(() => false);
    return null;
  }
  activeBindings.set(key, binding);

  return {
    browserSessionId: parsed.browserSessionId,
    definitions: BROWSER_TOOL_DEFINITIONS,
    async execute(tool, args) {
      const raw = await requestJson(
        fetchImpl,
        `${config.baseUrl}/v1/sessions/${encodeURIComponent(parsed.browserSessionId)}/invoke`,
        config,
        { version: BROWSER_SERVICE_VERSION, tool, arguments: args },
        REQUEST_TIMEOUT_MS,
      );
      return parseToolResult(raw);
    },
  };
}

/** Detach the product resource when its Zeros conversation is deleted. Agent
 * execution teardown deliberately does not call this: resume/rebuild must keep
 * the same conversation-owned browser lease. */
export async function releaseZerosBrowserConversation(
  workspaceId: string,
  conversationId: string,
): Promise<boolean> {
  const key = ownerKey(workspaceId, conversationId);
  ownerGenerations.set(key, (ownerGenerations.get(key) ?? 0) + 1);
  const active = activeBindings.get(key);
  if (!active) return false;
  activeBindings.delete(key);
  return closeBinding(active);
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
  body: BrowserJsonValue | Record<string, unknown>,
  timeoutMs: number,
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
      signal: controller.signal,
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

function parseAcquireResponse(value: unknown): BrowserSessionAcquireResponse {
  const record = asRecord(value);
  if (
    record.version !== BROWSER_SERVICE_VERSION ||
    !isBrowserProductId(record.browserSessionId) ||
    !String(record.browserSessionId).startsWith("browser_")
  ) {
    throw new Error(
      "Zeros browser service returned an invalid session identity.",
    );
  }
  return {
    version: BROWSER_SERVICE_VERSION,
    browserSessionId: record.browserSessionId,
  };
}

function parseToolResult(value: unknown): BrowserToolResult {
  const record = asRecord(value);
  if (
    record.version !== BROWSER_SERVICE_VERSION ||
    typeof record.success !== "boolean" ||
    !Array.isArray(record.content) ||
    record.content.length > 32
  ) {
    throw new Error("Zeros browser service returned an invalid tool result.");
  }
  const content: BrowserToolContent[] = record.content.map((item) => {
    const block = asRecord(item);
    if (block.type === "text" && typeof block.text === "string") {
      return { type: "text", text: block.text };
    }
    if (
      block.type === "image" &&
      block.mimeType === "image/jpeg" &&
      typeof block.data === "string"
    ) {
      return { type: "image", data: block.data, mimeType: "image/jpeg" };
    }
    throw new Error("Zeros browser service returned an invalid content block.");
  });
  return {
    version: BROWSER_SERVICE_VERSION,
    success: record.success,
    content,
  };
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

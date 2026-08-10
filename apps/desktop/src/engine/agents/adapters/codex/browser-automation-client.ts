import type { DynamicToolCallParams } from "./generated/v2/DynamicToolCallParams";
import type { DynamicToolCallResponse } from "./generated/v2/DynamicToolCallResponse";
import type { DynamicToolSpec } from "./generated/v2/DynamicToolSpec";
import type { JsonValue } from "./generated/serde_json/JsonValue";
import type { McpServerRegistration } from "../../types";

const BROWSER_URL_ENV = "ZEROS_BROWSER_AUTOMATION_URL";
const BROWSER_TOKEN_ENV = "ZEROS_BROWSER_AUTOMATION_TOKEN";
// Consequential browser actions can pause for an explicit user decision. Keep
// this just beyond the main-process confirmation deadline so the host, rather
// than the transport, owns the timeout and can settle the UI deterministically.
const TOOL_TIMEOUT_MS = 5 * 60_000;
const REGISTER_TIMEOUT_MS = 5_000;

export interface BrowserAutomationConfig {
  url: string;
  token: string;
}

/** Stable Zeros-owned identity shared by native dynamic tools and the MCP
 * fallback. Codex thread ids and MCP transport session ids are deliberately
 * not used as browser ownership keys because either can change when the same
 * desktop task is resumed. */
export interface BrowserTaskBinding {
  taskId: string;
}

type BrowserAutomationEnv = Record<string, string | undefined>;

/** Merge ordinary per-session overrides with the Electron-owned browser
 * bridge. The host values are authoritative: composer/model settings arrive
 * as a non-empty session env object and must not hide (or replace) the
 * process-level loopback endpoint injected when the engine was spawned. */
export function mergeBrowserAutomationEnv(
  sessionEnv: BrowserAutomationEnv | undefined,
  hostEnv: BrowserAutomationEnv = process.env,
): BrowserAutomationEnv {
  const merged: BrowserAutomationEnv = { ...(sessionEnv ?? {}) };
  for (const key of [BROWSER_URL_ENV, BROWSER_TOKEN_ENV]) {
    if (hostEnv[key] !== undefined) merged[key] = hostEnv[key];
  }
  return merged;
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): JsonValue {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  } as JsonValue;
}

/** Dynamic tools are the native Codex app-server extension point. Keeping the
 * whole browser under one namespace matches Codex's built-in Browser surface
 * and prevents these host tools from colliding with MCP or future core tools. */
export const CODEX_BROWSER_DYNAMIC_TOOLS: DynamicToolSpec[] = [
  {
    type: "namespace",
    name: "zeros_browser",
    description:
      "Control the browser provider selected in Zeros for user-like website testing. Use these tools directly when the user asks to open, inspect, navigate, click, type, resize, or screenshot a webpage; do not ask them to connect a browser when this namespace is available.",
    tools: [
      {
        type: "function",
        name: "open",
        description:
          "Open an http(s) URL in the browser provider selected in Zeros and return a semantic page snapshot.",
        inputSchema: objectSchema(
          {
            url: { type: "string", description: "Absolute http(s) URL." },
            width: { type: "integer", minimum: 320, maximum: 2560 },
            height: { type: "integer", minimum: 320, maximum: 1800 },
          },
          ["url"],
        ),
      },
      {
        type: "function",
        name: "snapshot",
        description:
          "Inspect the current page and return visible text plus semantic element refs for later actions.",
        inputSchema: objectSchema({}),
      },
      {
        type: "function",
        name: "click",
        description:
          "Click an element from the latest snapshot by its semantic ref, then return an updated snapshot.",
        inputSchema: objectSchema(
          { ref: { type: "string", description: "Element ref such as b12." } },
          ["ref"],
        ),
      },
      {
        type: "function",
        name: "type",
        description:
          "Type into a text field from the latest snapshot. Password entry pauses for explicit user confirmation; use upload for file inputs.",
        inputSchema: objectSchema(
          {
            ref: { type: "string" },
            text: { type: "string", maxLength: 20_000 },
            clear: { type: "boolean", default: true },
          },
          ["ref", "text"],
        ),
      },
      {
        type: "function",
        name: "upload",
        description:
          "Choose one local file for a file input. Zeros validates it and pauses for explicit user confirmation before the page can read it.",
        inputSchema: objectSchema(
          {
            ref: { type: "string", description: "File-input element ref." },
            path: { type: "string", description: "Absolute local file path." },
          },
          ["ref", "path"],
        ),
      },
      {
        type: "function",
        name: "screenshot",
        description:
          "Capture the current browser viewport as an image, optionally highlighting semantic refs.",
        inputSchema: objectSchema({
          annotations: {
            type: "array",
            maxItems: 20,
            items: {
              type: "object",
              properties: {
                ref: { type: "string" },
                label: { type: "string" },
              },
              required: ["ref"],
              additionalProperties: false,
            },
          },
        }),
      },
      {
        type: "function",
        name: "computer_screenshot",
        description:
          "Capture the primary Mac display when System Computer Use is selected and its macOS permissions are granted.",
        inputSchema: objectSchema({}),
      },
      {
        type: "function",
        name: "computer_click",
        description:
          "Click a primary-display coordinate through macOS System Computer Use. Zeros always asks the user to confirm the action.",
        inputSchema: objectSchema(
          {
            x: { type: "integer", minimum: 0, maximum: 20_000 },
            y: { type: "integer", minimum: 0, maximum: 20_000 },
          },
          ["x", "y"],
        ),
      },
      {
        type: "function",
        name: "computer_type",
        description:
          "Type text into the focused macOS control through System Computer Use. Zeros always asks the user to confirm the action.",
        inputSchema: objectSchema(
          { text: { type: "string", minLength: 1, maxLength: 2_000 } },
          ["text"],
        ),
      },
      {
        type: "function",
        name: "computer_key",
        description:
          "Press one supported navigation key through macOS System Computer Use. Zeros always asks the user to confirm the action.",
        inputSchema: objectSchema(
          {
            key: {
              type: "string",
              enum: [
                "enter",
                "tab",
                "escape",
                "space",
                "backspace",
                "arrow-up",
                "arrow-down",
                "arrow-left",
                "arrow-right",
              ],
            },
          },
          ["key"],
        ),
      },
      {
        type: "function",
        name: "trace",
        description:
          "Persist the bounded navigation, tool, permission, download, console, and network event trace for this task.",
        inputSchema: objectSchema({}),
      },
      {
        type: "function",
        name: "cdp",
        description:
          "Run one raw Chrome DevTools Protocol command. Disabled by default; requires the Developer browser CDP setting and explicit confirmation for the exact site and method.",
        inputSchema: objectSchema(
          {
            method: {
              type: "string",
              description: "CDP Domain.method name.",
            },
            params: { type: "object", additionalProperties: true },
          },
          ["method"],
        ),
      },
      {
        type: "function",
        name: "resize",
        description:
          "Resize the viewport for responsive testing and return an updated snapshot.",
        inputSchema: objectSchema(
          {
            width: { type: "integer", minimum: 320, maximum: 2560 },
            height: { type: "integer", minimum: 320, maximum: 1800 },
          },
          ["width", "height"],
        ),
      },
      ...["back", "forward", "reload", "close"].map((name) => ({
        type: "function" as const,
        name,
        description:
          name === "close"
            ? "Close this task's browser session and erase its isolated session data when applicable."
            : `${name[0]!.toUpperCase()}${name.slice(1)} in the selected browser provider and return an updated snapshot.`,
        inputSchema: objectSchema({}),
      })),
    ],
  },
];

export function resolveBrowserAutomationConfig(
  env: BrowserAutomationEnv = process.env,
): BrowserAutomationConfig | null {
  const rawUrl = env[BROWSER_URL_ENV]?.trim();
  const token = env[BROWSER_TOKEN_ENV]?.trim();
  if (!rawUrl || !token) return null;
  try {
    const url = new URL(rawUrl);
    const loopback =
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      url.hostname === "::1" ||
      url.hostname === "localhost";
    if (url.protocol !== "http:" || !loopback || url.username || url.password)
      return null;
    return { url: url.href, token };
  } catch {
    return null;
  }
}

export function browserDynamicTools(
  env: BrowserAutomationEnv = process.env,
): DynamicToolSpec[] | undefined {
  return resolveBrowserAutomationConfig(env)
    ? CODEX_BROWSER_DYNAMIC_TOOLS
    : undefined;
}

/** Standard MCP fallback loaded at app-server spawn. Unlike dynamic tools,
 * MCP tools remain available after `thread/resume`, so older tasks gain
 * browser control without rewriting their Codex rollout files. */
export function browserMcpServerRegistration(
  env: BrowserAutomationEnv = process.env,
  binding?: BrowserTaskBinding,
): McpServerRegistration | undefined {
  const config = resolveBrowserAutomationConfig(env);
  const taskKey = binding ? browserTaskKey(binding.taskId) : null;
  if (!config || (binding && !taskKey)) return undefined;
  const url = new URL(config.url);
  url.pathname = "/mcp";
  url.search = "";
  url.hash = "";
  if (binding) url.searchParams.set("taskId", binding.taskId);
  return {
    name: "zeros_browser",
    transport: "http",
    url: url.href,
    bearerTokenEnvVar: BROWSER_TOKEN_ENV,
  };
}

/** Bind Codex's native rollout/session id to Zeros' stable task id. The
 * bundled Browser skill discovers IAB providers independently through the
 * privileged Node REPL native-pipe transport, so MCP registration alone is
 * not sufficient for Codex-compatible Browser Use. */
export async function registerCodexBrowserUseSession(
  env: BrowserAutomationEnv = process.env,
  binding: BrowserTaskBinding,
  sessionId: string,
): Promise<boolean> {
  const config = resolveBrowserAutomationConfig(env);
  if (!config || !browserTaskKey(binding.taskId) || !validBinding(sessionId)) {
    return false;
  }
  const url = new URL(config.url);
  url.pathname = "/codex-browser-use/register";
  url.search = "";
  url.hash = "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REGISTER_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetch(url.href, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ taskId: binding.taskId, sessionId }),
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function createBrowserDynamicToolHandler(
  env: BrowserAutomationEnv = process.env,
  binding?: BrowserTaskBinding,
):
  | ((params: DynamicToolCallParams) => Promise<DynamicToolCallResponse>)
  | undefined {
  const config = resolveBrowserAutomationConfig(env);
  const taskKey = binding ? browserTaskKey(binding.taskId) : null;
  if (!config || (binding && !taskKey)) return undefined;

  return async (params) => {
    if (params.namespace !== "zeros_browser") {
      return failure(
        `Unsupported dynamic-tool namespace: ${params.namespace ?? "(none)"}`,
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TOOL_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await fetch(config.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...params,
          // A new Codex thread and a resumed MCP connection must resolve to
          // the same browser lease for this Zeros task.
          ...(taskKey ? { threadId: taskKey } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        return failure(`Browser host returned HTTP ${response.status}.`);
      }
      const payload = (await response.json()) as DynamicToolCallResponse;
      if (
        typeof payload?.success !== "boolean" ||
        !Array.isArray(payload?.contentItems)
      ) {
        return failure("Browser host returned an invalid response.");
      }
      return payload;
    } catch (error) {
      const message =
        error instanceof Error && error.name === "AbortError"
          ? "Browser action timed out."
          : `Browser action failed: ${error instanceof Error ? error.message : String(error)}`;
      return failure(message);
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Browser host keys are intentionally boring and bounded before they cross
 * the loopback process boundary or enter an MCP URL. */
function browserTaskKey(taskId: string): string | null {
  const value = taskId.trim();
  if (!validBinding(value)) return null;
  return `task:${value}`;
}

function validBinding(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,200}$/.test(value.trim());
}

function failure(text: string): DynamicToolCallResponse {
  return { success: false, contentItems: [{ type: "inputText", text }] };
}

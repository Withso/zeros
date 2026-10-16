import { randomBytes, timingSafeEqual } from "node:crypto";

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  BROWSER_TOOL_DEFINITIONS,
  isBrowserToolName,
  type BrowserJsonValue,
  type BrowserRoute,
  type BrowserToolName,
  type BrowserToolResult,
} from "@zeros/protocol/browser-tools";

import type { DesignMcpToolHandler } from "../design/design-agent-mcp";

export type ZerosBrowserToolPolicy =
  | { ok: true }
  | { ok: false; reason: string };

/** Engine-side owner of one conversation's browser. Every port is bound to the
 * admitted workspace and conversation; tool arguments never choose either. */
export interface ZerosBrowserToolPorts {
  /** Settings decide per call, so a toggle applies to a running agent. */
  policy(): ZerosBrowserToolPolicy;
  /** Throws once the owning workspace is no longer the admitted one. */
  assertOwner?(): void;
  acquire(): Promise<{ browserSessionId: string } | null>;
  invoke(request: {
    browserSessionId: string;
    tool: BrowserToolName;
    arguments: BrowserJsonValue;
    signal?: AbortSignal;
  }): Promise<BrowserToolResult>;
  stop(browserSessionId: string): Promise<boolean>;
}

const IN_APP_OFF = "The in-app browser is turned off in Settings > Browser.";
const STOPPED = "Browser work was stopped.";
const CANCELLED = "The browser action was cancelled.";
const RETIRED = "Browser tools were retired for this agent session.";
// Turn-end handoff must not hold the provider's turn open behind a stuck page.
const HANDOFF_TIMEOUT_MS = 5_000;

const TOOLS: readonly Tool[] = BROWSER_TOOL_DEFINITIONS.map((definition) => ({
  name: definition.name,
  description: definition.description,
  // Protocol schemas are JSON values; MCP types each property as an object.
  inputSchema: definition.inputSchema as Tool["inputSchema"],
}));

/** Whether an agent family may call `zeros_browser` on its Settings route.
 * Codex keeps the tools on its built-in route because the app-server adapter
 * removes them once OpenAI's Browser plugin loads, and keeps them as the
 * fallback when it cannot. */
export function zerosBrowserToolPolicy(
  agentFamily: string,
  route: BrowserRoute,
): ZerosBrowserToolPolicy {
  if (route === "zeros") return { ok: true };
  if (agentFamily === "codex") {
    return route === "codex-native"
      ? { ok: true }
      : {
          ok: false,
          reason: "Browser use is turned off for Codex in Settings > Browser.",
        };
  }
  if (route === "claude-chrome") {
    return {
      ok: false,
      reason:
        "Claude is set to use Chrome in Settings > Browser, so the in-app browser is not available.",
    };
  }
  return { ok: false, reason: IN_APP_OFF };
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function toCallToolResult(result: BrowserToolResult): CallToolResult {
  const content: CallToolResult["content"] = result.content.map((item) =>
    item.type === "text"
      ? { type: "text", text: item.text }
      : { type: "image", data: item.data, mimeType: item.mimeType },
  );
  if (content.length === 0) {
    content.push({
      type: "text",
      text: result.success ? "Done." : "The browser action failed.",
    });
  }
  return result.success ? { content } : { content, isError: true };
}

/** Settle with `work` unless `signal` aborts first. The host keeps running an
 * abandoned action until the separate stop request reaches it. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** The `zeros_browser` MCP handler for one agent execution. It drives the
 * conversation's browser in the Electron host, the same page the Browser tab
 * shows, and hands that page back to the user when a turn that used it ends. */
export class ZerosBrowserTools implements DesignMcpToolHandler {
  readonly token = randomBytes(32).toString("base64url");
  private readonly retired = new AbortController();
  private turn = new AbortController();
  private inFlight = 0;
  private browserSessionId: string | null = null;
  private usedSinceHandoff = false;

  constructor(private readonly ports: ZerosBrowserToolPorts) {}

  assertActive(token: string): void {
    const supplied = Buffer.from(token);
    const expected = Buffer.from(this.token);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      throw new Error("Invalid browser tool authority.");
    }
    if (this.retired.signal.aborted) throw new Error(RETIRED);
    this.ports.assertOwner?.();
  }

  listTools(): Tool[] {
    if (this.retired.signal.aborted || !this.policy().ok) return [];
    return TOOLS.map((tool) => ({ ...tool }));
  }

  async callTool(
    name: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    if (this.retired.signal.aborted) throw new Error(RETIRED);
    const policy = this.policy();
    if (!policy.ok) return errorResult(policy.reason);
    if (!isBrowserToolName(name)) {
      return errorResult("Unknown Zeros browser tool.");
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return errorResult("Browser tool arguments must be an object.");
    }
    const turn = this.turn.signal;
    if (turn.aborted) return errorResult(STOPPED);
    if (signal.aborted) return errorResult(CANCELLED);
    const call = AbortSignal.any([signal, turn, this.retired.signal]);
    let browserSessionId: string | null = null;
    this.inFlight += 1;
    try {
      const session = await untilAborted(this.ports.acquire(), call);
      if (!session) {
        return errorResult(
          "The Zeros browser is unavailable. Restart Zeros and try again.",
        );
      }
      browserSessionId = session.browserSessionId;
      this.browserSessionId = browserSessionId;
      this.usedSinceHandoff = true;
      return toCallToolResult(
        await untilAborted(
          this.ports.invoke({
            browserSessionId,
            tool: name,
            arguments: input as BrowserJsonValue,
            signal: call,
          }),
          call,
        ),
      );
    } catch (error) {
      if (!call.aborted) {
        return errorResult(
          error instanceof Error && error.message
            ? error.message
            : "The browser action failed.",
        );
      }
      // cancel() and dispose() interrupt the host once for all pending calls;
      // a provider cancelling one call interrupts it here.
      if (this.retired.signal.aborted) throw new Error(RETIRED);
      if (turn.aborted) return errorResult(STOPPED);
      if (browserSessionId) this.interrupt(browserSessionId);
      return errorResult(CANCELLED);
    } finally {
      this.inFlight -= 1;
    }
  }

  beginPrompt(): void {
    if (this.turn.signal.aborted) this.turn = new AbortController();
  }

  /** Stop: fail pending calls now and interrupt the page's current action. */
  cancel(): void {
    const busy = this.inFlight > 0;
    this.turn.abort();
    if (busy && this.browserSessionId) this.interrupt(this.browserSessionId);
  }

  /** The provider turn settled. Give the page back if the agent drove it. */
  async endPrompt(): Promise<void> {
    if (this.retired.signal.aborted) return;
    await this.handOff();
  }

  dispose(): void {
    if (this.retired.signal.aborted) return;
    const busy = this.inFlight > 0;
    this.retired.abort();
    if (busy && this.browserSessionId) this.interrupt(this.browserSessionId);
    void this.handOff();
  }

  private policy(): ZerosBrowserToolPolicy {
    try {
      return this.ports.policy();
    } catch {
      return {
        ok: false,
        reason: "Browser settings could not be read. Check Settings > Browser.",
      };
    }
  }

  private interrupt(browserSessionId: string): void {
    void this.ports.stop(browserSessionId).catch(() => false);
  }

  private async handOff(): Promise<void> {
    const browserSessionId = this.browserSessionId;
    if (!this.usedSinceHandoff || !browserSessionId) return;
    this.usedSinceHandoff = false;
    try {
      await this.ports.invoke({
        browserSessionId,
        tool: "close",
        arguments: {},
        signal: AbortSignal.timeout(HANDOFF_TIMEOUT_MS),
      });
    } catch {
      // Handoff is best effort; the host's idle expiry still reclaims the page.
    }
  }
}

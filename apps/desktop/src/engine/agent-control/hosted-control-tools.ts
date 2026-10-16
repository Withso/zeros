import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { BrowserJsonValue } from "@zeros/protocol/browser-tools";

import type { DesignMcpToolHandler } from "../design/design-agent-mcp";

export type HostedControlToolPolicy =
  | { ok: true }
  | { ok: false; reason: string };

/** What Electron main returns for one call. */
export interface HostedControlToolResult {
  success: boolean;
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: "image/png" | "image/jpeg" }
  >;
}

/** Engine-side owner of one chat's tools that Electron main runs. Every port
 * is bound to the admitted workspace, conversation and agent; tool arguments
 * never choose them. */
export interface HostedControlToolPorts<TName extends string> {
  /** Settings decide per call, so turning the tools off applies to a running
   * agent. */
  policy(): HostedControlToolPolicy;
  /** Throws once the owning workspace is no longer the admitted one. */
  assertOwner?(): void;
  invoke(request: {
    turnId: string;
    tool: TName;
    arguments: BrowserJsonValue;
    signal: AbortSignal;
  }): Promise<HostedControlToolResult>;
  /** End this chat's hold on what main controls for it. */
  release(reason: "turn-end" | "stop"): Promise<boolean>;
}

/** The curated tool family: its manifest, its argument contract and the
 * words its refusals use. */
export interface HostedControlToolSpec<TName extends string> {
  definitions: readonly {
    name: TName;
    description: string;
    inputSchema: unknown;
  }[];
  parse(
    name: unknown,
    input: unknown,
  ): { ok: true; call: { tool: TName } } | { ok: false; error: string };
  text: {
    authority: string;
    stopped: string;
    cancelled: string;
    retired: string;
    failed: string;
    unreadable: string;
  };
}

// Turn-end release must not hold the provider's turn open.
const RELEASE_TIMEOUT_MS = 5_000;

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Settle with `work` unless `signal` aborts first. Main keeps waiting on an
 * abandoned call until the aborted request reaches it. */
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

function newTurnId(): string {
  return `turn_${randomUUID()}`;
}

/** An MCP handler for one agent execution whose calls Electron main runs.
 * This side tracks the provider's turns so the chat lets go when a turn ends,
 * the user stops it, or the session retires. */
export class HostedControlTools<TName extends string>
  implements DesignMcpToolHandler
{
  readonly token = randomBytes(32).toString("base64url");
  private readonly retired = new AbortController();
  private turn = new AbortController();
  private turnId = newTurnId();
  private usedThisTurn = false;
  private readonly tools: readonly Tool[];

  constructor(
    private readonly ports: HostedControlToolPorts<TName>,
    private readonly spec: HostedControlToolSpec<TName>,
  ) {
    this.tools = spec.definitions.map((definition) => ({
      name: definition.name,
      description: definition.description,
      // Protocol schemas are JSON values; MCP types each property as an object.
      inputSchema: definition.inputSchema as Tool["inputSchema"],
    }));
  }

  assertActive(token: string): void {
    const supplied = Buffer.from(token);
    const expected = Buffer.from(this.token);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      throw new Error(this.spec.text.authority);
    }
    if (this.retired.signal.aborted) throw new Error(this.spec.text.retired);
    this.ports.assertOwner?.();
  }

  listTools(): Tool[] {
    if (this.retired.signal.aborted || !this.policy().ok) return [];
    return this.tools.map((tool) => ({ ...tool }));
  }

  async callTool(
    name: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    const text = this.spec.text;
    if (this.retired.signal.aborted) throw new Error(text.retired);
    const policy = this.policy();
    if (!policy.ok) return errorResult(policy.reason);
    const parsed = this.spec.parse(name, input);
    if (!parsed.ok) return errorResult(parsed.error);
    const turn = this.turn.signal;
    if (turn.aborted) return errorResult(text.stopped);
    if (signal.aborted) return errorResult(text.cancelled);
    const call = AbortSignal.any([signal, turn, this.retired.signal]);
    this.usedThisTurn = true;
    try {
      return this.toCallToolResult(
        await untilAborted(
          this.ports.invoke({
            turnId: this.turnId,
            tool: parsed.call.tool,
            arguments: input as BrowserJsonValue,
            signal: call,
          }),
          call,
        ),
      );
    } catch (error) {
      if (!call.aborted) {
        return errorResult(
          error instanceof Error && error.message ? error.message : text.failed,
        );
      }
      if (this.retired.signal.aborted) throw new Error(text.retired);
      return errorResult(turn.aborted ? text.stopped : text.cancelled);
    }
  }

  beginPrompt(): void {
    if (this.turn.signal.aborted) this.turn = new AbortController();
    this.turnId = newTurnId();
    this.usedThisTurn = false;
  }

  /** Composer Stop: fail pending calls now and let go. */
  cancel(): void {
    this.turn.abort();
    if (this.usedThisTurn) {
      this.usedThisTurn = false;
      void this.release("stop");
    }
  }

  /** The provider turn settled. */
  async endPrompt(): Promise<void> {
    if (!this.usedThisTurn) return;
    this.usedThisTurn = false;
    await this.release("turn-end");
  }

  /** The execution is gone; its chat may continue in a new one, so approvals
   * stay. */
  dispose(): void {
    if (this.retired.signal.aborted) return;
    this.retired.abort();
    if (this.usedThisTurn) {
      this.usedThisTurn = false;
      void this.release("turn-end");
    }
  }

  private toCallToolResult(result: HostedControlToolResult): CallToolResult {
    const content: CallToolResult["content"] = result.content.map((item) =>
      item.type === "text"
        ? { type: "text", text: item.text }
        : { type: "image", data: item.data, mimeType: item.mimeType },
    );
    if (content.length === 0) {
      content.push({
        type: "text",
        text: result.success ? "Done." : this.spec.text.failed,
      });
    }
    return result.success ? { content } : { content, isError: true };
  }

  private policy(): HostedControlToolPolicy {
    try {
      return this.ports.policy();
    } catch {
      return { ok: false, reason: this.spec.text.unreadable };
    }
  }

  private async release(reason: "turn-end" | "stop"): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.ports.release(reason),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, RELEASE_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } catch {
      // Best effort: main's own expiry still ends a forgotten hold.
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

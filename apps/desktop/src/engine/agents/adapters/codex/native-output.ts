import type { NativePromptOutputKind } from "../../types";

export const CODEX_NATIVE_OUTPUT_METHODS = [
  "item/agentMessage/delta", "item/started", "item/completed",
  "item/commandExecution/outputDelta", "item/fileChange/outputDelta", "turn/completed", "error",
] as const;
const nativeIdentity = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const toolTypes = new Set(["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "imageGeneration", "collabAgentToolCall"]);
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Each instance belongs to one actual native request. A notification's thread
 * alone cannot distinguish a held old warm turn from this send. Early events
 * retain only bounded identities/kinds until the matched RPC ACK proves turn
 * ownership. The observer carries no native text, tool payload or timestamp. */
export class CodexNativeTurnOutput {
  private submitted = false;
  private disposed = false;
  private finished = false;
  private acceptedTurn: string | null = null;
  private readonly early = new Map<string, Map<NativePromptOutputKind, number>>();
  private readonly terminal = new Set<string>();
  private terminalOverflow = false;
  private readonly emitted = new Set<NativePromptOutputKind>();

  constructor(private readonly threadId: unknown, private readonly observe: (kind: NativePromptOutputKind, receivedAtMs: number) => void) {}
  written(): void { if (!this.disposed) this.submitted = true; }

  accept(turnId: unknown, status: unknown): void {
    if (!this.submitted || this.disposed || this.finished || !nativeIdentity(this.threadId) || !nativeIdentity(turnId) ||
      typeof status !== "string" || !["inProgress", "completed", "failed", "cancelled", "interrupted"].includes(status)) return;
    this.acceptedTurn = turnId;
    if (!this.terminalOverflow) for (const [kind, receivedAtMs] of this.early.get(turnId) ?? []) this.emit(kind, receivedAtMs);
    this.finished = this.terminalOverflow || this.terminal.has(turnId) || status !== "inProgress";
    this.early.clear(); this.terminal.clear();
  }

  receive(method: string, value: unknown): void {
    if (!this.submitted || this.disposed || this.finished || !nativeIdentity(this.threadId)) return;
    const params = record(value);
    if (!params) return;
    if (method === "error" && params.willRetry !== true && !params.turnId) {
      // Existing runtime semantics retire every pending request for a terminal
      // unscoped error. No later frame can be first output for this request.
      this.finished = true; this.early.clear(); this.terminal.clear(); return;
    }
    if (params.threadId !== this.threadId) return;
    const turn = record(params.turn);
    const turnId = method === "turn/completed" ? turn?.id : params.turnId;
    if (!nativeIdentity(turnId)) return;
    if (method === "turn/completed" || method === "error" && params.willRetry !== true) {
      if (this.acceptedTurn === turnId) this.finished = true;
      else if (this.acceptedTurn === null && !this.terminal.has(turnId)) {
        if (this.terminal.size === 32) this.terminalOverflow = true;
        else this.terminal.add(turnId);
      }
      return;
    }
    if (this.terminal.has(turnId)) return;
    let kind: NativePromptOutputKind | null = null;
    if (method === "item/agentMessage/delta") {
      if (typeof params.delta === "string" && params.delta.length > 0) kind = "text";
    } else if (method === "item/commandExecution/outputDelta" || method === "item/fileChange/outputDelta") {
      if (typeof params.delta === "string" && params.delta.length > 0 && nativeIdentity(params.itemId)) kind = "tool";
    } else if (method === "item/started" || method === "item/completed") {
      const item = record(params.item);
      if (item && nativeIdentity(item.id)) {
        if (typeof item.type === "string" && toolTypes.has(item.type)) kind = "tool";
        else if (method === "item/completed" && item.type === "agentMessage" && typeof item.text === "string" && item.text.length > 0) kind = "text";
      }
    }
    if (!kind) return;
    // This clock is sampled by the trusted engine process at notification
    // arrival. Deferred ownership must never substitute the later ACK clock.
    const receivedAtMs = performance.now();
    if (this.acceptedTurn !== null) {
      if (turnId === this.acceptedTurn) this.emit(kind, receivedAtMs);
      return;
    }
    let kinds = this.early.get(turnId);
    if (!kinds) {
      if (this.early.size === 32) return;
      kinds = new Map(); this.early.set(turnId, kinds);
    }
    if (!kinds.has(kind)) kinds.set(kind, receivedAtMs);
  }

  dispose(): void { this.disposed = true; this.early.clear(); this.terminal.clear(); }
  private emit(kind: NativePromptOutputKind, receivedAtMs: number): void {
    if (this.disposed || this.emitted.has(kind)) return;
    this.emitted.add(kind);
    if (!Number.isFinite(receivedAtMs) || receivedAtMs < 0) return;
    try {
      const result: unknown = this.observe(kind, receivedAtMs);
      if (result !== null && (typeof result === "object" || typeof result === "function") &&
        typeof (result as { then?: unknown }).then === "function") void Promise.resolve(result).catch(() => {});
    } catch { /* passive observation */ }
  }
}

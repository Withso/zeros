import { randomUUID } from "node:crypto";
import { vaultControlLine, type VaultSnapshot } from "./vault-persist";

/** Explicit saves wait for encrypted storage. The request and acknowledgement
 * use the private host pipe; neither secrets nor storage details reach logs. */
export class McpVaultConfirmation {
  private readonly pending = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly send: (line: string) => void) {}
  persist(snapshot: VaultSnapshot): Promise<void> {
    if (this.pending.size >= 4) return Promise.reject(new Error("Wait for the current MCP save to finish."));
    const requestId = randomUUID();
    const line = vaultControlLine(snapshot, requestId);
    if (Buffer.byteLength(line) > 1024 * 1024) return Promise.reject(new Error("MCP secrets exceed the secure storage limit."));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.settle(requestId, false); }, 10_000); timer.unref?.();
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.send(line); } catch { this.settle(requestId, false); }
    });
  }
  private settle(id: string, ok: boolean): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id); clearTimeout(pending.timer);
    if (ok) pending.resolve();
    else pending.reject(new Error("MCP secrets could not be saved securely. Reconnect and try again."));
  }
  accept(message: unknown): boolean {
    if (!message || typeof message !== "object" || !("type" in message) || message.type !== "host.mcpVaultPersisted") return false;
    const msg = message as { requestId?: unknown; ok?: unknown };
    if (typeof msg.requestId === "string") this.settle(msg.requestId, msg.ok === true);
    return true;
  }
  close(): void { for (const id of this.pending.keys()) this.settle(id, false); }
}

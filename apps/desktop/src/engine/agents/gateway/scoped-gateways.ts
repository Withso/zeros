import { isDeepStrictEqual } from "node:util";
import { McpGateway } from "./server";
import type { GatewayBackend } from "../mcp-registry";
import type { McpOAuthCallback } from "./oauth-callback";
import type { OAuthVault } from "./oauth-provider";

/** Lazily opened project gateways isolate the effective tool/credential set.
 * No timers or polling: settings changes refresh admitted projects; shutdown
 * closes all listeners. The bound prevents unbounded retained native state. */
export class ScopedMcpGateways {
  private readonly entries = new Map<string, { gateway: McpGateway; backends: readonly GatewayBackend[]; flight: Promise<McpGateway> }>();
  private stopped = false;
  constructor(private readonly vault: () => OAuthVault, private readonly origin: () => string | undefined, private readonly callback?: () => McpOAuthCallback) {}
  async get(root: string, backends: readonly GatewayBackend[], force = false): Promise<McpGateway> {
    if (this.stopped) throw new Error("MCP runtime is shutting down.");
    const current = this.entries.get(root);
    if (current) {
      if (!force && isDeepStrictEqual(signature(current.backends), signature(backends))) return current.flight;
      current.backends = [...backends];
      current.flight = current.flight.catch(() => current.gateway).then(async gateway => {
        this.assertCurrent(root, gateway);
        await gateway.reload(backends);
        this.assertCurrent(root, gateway);
        return gateway;
      });
      return current.flight;
    }
    if (this.entries.size >= 64) throw new Error("Too many active MCP projects. Restart Zeros to release unused connections.");
    const gateway = new McpGateway({ port: 0, callbackPort: 0, callback: this.callback?.(), vault: this.vault(), clientMetadataOrigin: this.origin() });
    const entry = { gateway, backends: [...backends], flight: Promise.resolve(gateway) };
    entry.flight = gateway.start(backends).then(async () => {
      this.assertCurrent(root, gateway);
      return gateway;
    }).catch(async error => {
      if (this.entries.get(root) === entry) this.entries.delete(root);
      await gateway.stop(); throw error;
    });
    this.entries.set(root, entry);
    return entry.flight;
  }
  private assertCurrent(root: string, gateway: McpGateway): void {
    if (this.stopped) throw new Error("MCP runtime is shutting down.");
    if (this.entries.get(root)?.gateway !== gateway) throw new Error("This MCP project was removed. Reopen the session.");
  }
  roots(): string[] { return [...this.entries.keys()]; }
  async remove(root: string): Promise<void> {
    const entry = this.entries.get(root);
    if (!entry) return;
    this.entries.delete(root);
    await entry.gateway.stop();
    await entry.flight.catch(() => {});
  }
  async stop(): Promise<void> {
    this.stopped = true;
    const entries = [...this.entries.values()]; this.entries.clear();
    await Promise.allSettled(entries.map(async entry => { await entry.gateway.stop(); await entry.flight.catch(() => {}); }));
  }
}

function signature(backends: readonly GatewayBackend[]): unknown {
  return backends.map(({ authorization: _authorization, ...backend }) => backend);
}

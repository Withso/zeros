import type { CloudServiceContext, CloudWorkspaceAccessBroker, CloudWorkspaceRuntimeIdentity } from "./cloud-workspace-access-broker";
import type { CloudDetectedPorts } from "./cloud-workspace-detected-ports";
import { CloudPortForwardingPreferences, DEFAULT_CLOUD_PORT_FORWARDING, type CloudPortForwardingState } from "./cloud-workspace-port-forwarding-store";

type Target = { organizationId: string; workspaceId: string };
type Receipt = Awaited<ReturnType<CloudWorkspaceAccessBroker["startAutomaticTunnel"]>>;
type Entry = {
  runtime: CloudWorkspaceRuntimeIdentity; context: CloudServiceContext; epoch: number; suspended: boolean;
  automatic: Map<number, Receipt>; suppressed: Set<number>; observedAt: number;
  controller?: AbortController; timer?: ReturnType<typeof setTimeout>; flight?: Promise<void>;
};
const targetKey = (target: Target) => JSON.stringify([target.organizationId, target.workspaceId]);
const sameContext = (a: CloudServiceContext, b: CloudServiceContext) => a.authorityId === b.authorityId && a.deviceId === b.deviceId && a.keyVersion === b.keyVersion;
const sameRuntime = (a: CloudWorkspaceRuntimeIdentity, b: CloudWorkspaceRuntimeIdentity) => a.runtimeId === b.runtimeId && a.generation === b.generation &&
  a.authorityEpoch === b.authorityEpoch && a.engineInstanceId === b.engineInstanceId && a.connectionSequence === b.connectionSequence;
const MAX_AUTOMATIC_PER_WORKSPACE = 8;
const MAX_AUTOMATIC = 32;

/** Owns background forwarding, independent of popover visibility. It observes
 * already admitted, connected runtimes and persisted intent; it never admits an
 * engine, enrolls a device, connects a peer, or performs a lifecycle action. */
export class CloudWorkspacePortForwarding {
  private readonly entries = new Map<string, Entry>();
  private disposed = false;
  private pendingAutomatic = 0;
  private readonly now: () => number;
  constructor(private readonly options: {
    broker: Pick<CloudWorkspaceAccessBroker, "serviceContext" | "listServices" | "assertRuntime" | "startAutomaticTunnel" | "revoke">;
    preferences: CloudPortForwardingPreferences; accountId: string;
    readPorts(runtime: CloudWorkspaceRuntimeIdentity, signal: AbortSignal): Promise<CloudDetectedPorts>;
    now?: () => number;
  }) { this.now = options.now ?? Date.now; }

  readPreferences(input: Target & CloudServiceContext): Readonly<CloudPortForwardingState> {
    this.options.broker.listServices(input);
    return input.deviceId ? this.options.preferences.read({ ...input, deviceId: input.deviceId, accountId: this.options.accountId }) : DEFAULT_CLOUD_PORT_FORWARDING;
  }
  setPreferences(input: Target & CloudServiceContext, change: Partial<CloudPortForwardingState>): Readonly<CloudPortForwardingState> {
    if (this.disposed) throw new Error("Cloud forwarding authority has ended.");
    this.options.broker.listServices(input);
    if (!input.deviceId) throw new Error("A trusted device is required for cloud forwarding.");
    const state = this.options.preferences.set({ ...input, deviceId: input.deviceId, accountId: this.options.accountId }, change);
    const entry = this.entries.get(targetKey(input));
    if (entry) {
      // Explicit intent can re-arm a previously retired automatic service.
      entry.context = { authorityId: input.authorityId, deviceId: input.deviceId, keyVersion: input.keyVersion };
      entry.suspended = false;
      if (!state.forwardingEnabled || !state.autoForwardEnabled) void this.withdraw(entry);
      else { entry.suppressed.clear(); void this.refreshEntry(entry); }
    }
    return state;
  }
  publishRuntime(input: CloudWorkspaceRuntimeIdentity & { connected: boolean }): void {
    if (this.disposed) throw new Error("Cloud forwarding authority has ended.");
    this.options.broker.assertRuntime(input);
    const key = targetKey(input), previous = this.entries.get(key);
    if (!input.connected) {
      if (previous && sameRuntime(previous.runtime, input)) this.retireRuntime(input.runtimeId);
      return;
    }
    const context = this.options.broker.serviceContext();
    if (previous && sameRuntime(previous.runtime, input) && sameContext(previous.context, context)) return;
    if (previous) void this.withdraw(previous);
    if (!previous && this.entries.size >= 64) throw new Error("Too many cloud forwarding runtimes.");
    const { connected: _connected, ...runtime } = input;
    const entry: Entry = { runtime, context, epoch: 0, suspended: false, automatic: new Map(), suppressed: new Set(), observedAt: 0 };
    this.entries.set(key, entry);
    void this.refreshEntry(entry);
  }
  retireRuntime(runtimeId: string): void {
    for (const [key, entry] of this.entries) if (entry.runtime.runtimeId === runtimeId) {
      this.entries.delete(key);
      void this.withdraw(entry);
    }
  }
  removeWorkspace(target: Target): void {
    this.options.preferences.removeWorkspace(target);
    const entry = this.entries.get(targetKey(target));
    if (entry) this.retireRuntime(entry.runtime.runtimeId);
  }
  async revoke(accessId: string): Promise<boolean> {
    for (const entry of this.entries.values()) for (const [port, receipt] of entry.automatic) if (receipt.accessId === accessId) {
      entry.suppressed.add(port);
      entry.automatic.delete(port);
    }
    return this.options.broker.revoke(accessId);
  }
  refresh(): Promise<void> {
    return Promise.all([...this.entries.values()].map(entry => this.refreshEntry(entry))).then(() => undefined);
  }
  async dispose(input: { pruneAccount?: boolean } = {}): Promise<void> {
    this.disposed = true;
    const entries = [...this.entries.values()]; this.entries.clear();
    const cleanup = Promise.allSettled(entries.map(entry => this.withdraw(entry)));
    if (input.pruneAccount) this.options.preferences.removeAccount(this.options.accountId);
    await cleanup;
  }
  private eligible(entry: Entry): boolean {
    if (this.disposed || entry.suspended || this.entries.get(targetKey(entry.runtime)) !== entry) return false;
    try {
      this.options.broker.assertRuntime(entry.runtime);
      const current = this.options.broker.serviceContext();
      if (!current.deviceId || !sameContext(entry.context, current)) return false;
      const state = this.readPreferences({ ...entry.runtime, ...entry.context });
      return state.forwardingEnabled && state.autoForwardEnabled;
    } catch { return false; }
  }
  private async withdraw(entry: Entry): Promise<void> {
    entry.epoch++; clearTimeout(entry.timer); entry.timer = undefined; entry.controller?.abort();
    const receipts = [...entry.automatic.values()]; entry.automatic.clear();
    await Promise.allSettled(receipts.map(receipt => this.options.broker.revoke(receipt.accessId)));
  }
  private refreshEntry(entry: Entry): Promise<void> {
    if (!this.eligible(entry)) return this.withdraw(entry);
    if (entry.flight) return entry.flight;
    clearTimeout(entry.timer); entry.timer = undefined;
    const epoch = entry.epoch, controller = new AbortController(); entry.controller = controller;
    const current = () => epoch === entry.epoch && !controller.signal.aborted && this.eligible(entry);
    entry.flight = Promise.resolve().then(async () => {
      const snapshot = await this.options.readPorts(entry.runtime, controller.signal);
      if (!current()) return;
      if (snapshot.organizationId !== entry.runtime.organizationId || snapshot.workspaceId !== entry.runtime.workspaceId || snapshot.generation !== entry.runtime.generation || !["ready", "busy"].includes(snapshot.status)) {
        entry.suspended = true; await this.withdraw(entry); return;
      }
      const rows = this.options.broker.listServices({ ...entry.runtime, ...entry.context });
      for (const [port, receipt] of entry.automatic) if (!rows.some(row => row.accessId === receipt.accessId && !row.closing)) {
        entry.automatic.delete(port);
        // Unexpected grant retirement cannot silently mint replacement
        // authority. Normal expiry can renew under the explicit preference.
        if (Date.parse(receipt.expiresAt) > this.now()) { entry.suspended = true; await this.withdraw(entry); return; }
      }
      if (snapshot.ports === null || snapshot.observedAt === null) return;
      const observedAt = Date.parse(snapshot.observedAt);
      if (observedAt < entry.observedAt || observedAt < this.now() - 60_000 || observedAt > this.now() + 5_000) return;
      entry.observedAt = observedAt;
      const detected = new Set(snapshot.ports.filter(port => port.health !== "closed" && port.closedAt === null).map(port => port.port));
      for (const port of entry.suppressed) if (!detected.has(port)) entry.suppressed.delete(port);
      for (const [port, receipt] of entry.automatic) if (!detected.has(port)) {
        entry.automatic.delete(port); await this.options.broker.revoke(receipt.accessId).catch(() => undefined);
      }
      for (const remotePort of [...detected].sort((a, b) => a - b)) {
        if (!current() || entry.automatic.size >= MAX_AUTOMATIC_PER_WORKSPACE) break;
        if (entry.automatic.has(remotePort) || entry.suppressed.has(remotePort) || rows.some(row => row.kind === "tunnel" && row.generation === entry.runtime.generation && row.remotePort === remotePort)) continue;
        if ([...this.entries.values()].reduce((sum, row) => sum + row.automatic.size, this.pendingAutomatic) >= MAX_AUTOMATIC) break;
        for (let localPort = remotePort; localPort <= Math.min(65535, remotePort + 31) && current(); localPort++) {
          this.pendingAutomatic++;
          try {
            const receipt = await this.options.broker.startAutomaticTunnel({ ...entry.runtime, ...entry.context, localPort, remotePort });
            if (!current()) await this.options.broker.revoke(receipt.accessId).catch(() => undefined);
            else entry.automatic.set(remotePort, receipt);
            break;
          } catch (error) {
            if ((error as { code?: string }).code === "local_port_in_use") continue;
            throw error;
          } finally { this.pendingAutomatic--; }
        }
      }
    }).catch(async error => {
      if (!current()) { await this.withdraw(entry); return; }
      const status = (error as { status?: number }).status;
      if (status === 401 || status === 403 || status === 404 || status === 409) { entry.suspended = true; await this.withdraw(entry); }
      // Transient reads retain confirmed exact-runtime tunnels; their native
      // transport independently revalidates grant authority every five seconds.
    }).finally(() => {
      entry.flight = undefined;
      if (entry.controller === controller) entry.controller = undefined;
      if (current()) {
        entry.timer = setTimeout(() => { entry.timer = undefined; void this.refreshEntry(entry); }, 4_000);
        entry.timer.unref?.();
      } else if (this.eligible(entry)) void this.refreshEntry(entry);
    });
    return entry.flight;
  }
}

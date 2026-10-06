import type { CloudWorkspaceDocument } from "../platform/cloud-workspaces";

const INPUT_RECENCY_MS = 15 * 60_000;
const PRESENCE_INTERVAL_MS = 60_000;
const WAKE_DEBOUNCE_MS = 30_000;
const WAKE_INTENT_MS = 2 * 60_000;
const INCIDENT_WAKE_INTERVAL_MS = 5 * 60_000;
const WAKE_STATES = new Set(["stopped", "sleeping", "stopping", "waking", "provisioning", "setting_up"]);

/** One app-window controller, never mounted in a retained workspace surface.
 * Presence renews an existing connection only. Wake requires fresh user input,
 * with the same run authorization and explicit wake path as open/send. */
export class CloudWorkspaceInteraction {
  private readonly now: () => number;
  private lastInput = -Infinity;
  private presentKey: string | null = null;
  private lastPresence = -Infinity;
  private readonly wakes = new Map<string, number>();
  private pending: { key: string; controller: AbortController } | null = null;
  private armed: { key: string; generation: number; at: number } | null = null;
  private closed = false;
  constructor(private readonly options: {
    now?: () => number;
    current(): { key: string; document: CloudWorkspaceDocument } | null;
    visible(): boolean;
    focused(): boolean;
    available(): boolean;
    presence(key: string, present: boolean): boolean;
    wake(key: string, signal: AbortSignal): Promise<void>;
    failed?(key: string, error: unknown): void;
  }) { this.now = options.now ?? (() => performance.now()); }

  interact(otherWorkspaceRow = false): void {
    if (this.closed || !this.options.visible() || !this.options.focused() || !this.options.available()) return;
    this.lastInput = this.now();
    const selected = this.options.current();
    this.armed = !otherWorkspaceRow && selected ? {
      key: selected.key, generation: selected.document.generation.number, at: this.now(),
    } : null;
    this.refresh();
  }

  private wakeIfArmed(): void {
    const current = this.options.current();
    if (!this.armed || !current || this.armed.key !== current.key || this.armed.generation !== current.document.generation.number ||
        this.now() - this.armed.at >= WAKE_INTENT_MS || !this.options.visible() || !this.options.focused() || !this.options.available() ||
        current.document.deletedAt || !current.document.capabilities.canWrite ||
        !WAKE_STATES.has(current.document.status) || this.pending?.key === current.key) return;
    const interval = current.document.error ? INCIDENT_WAKE_INTERVAL_MS : WAKE_DEBOUNCE_MS;
    // A replacement runtime must not reset the incident retry budget.
    const identity = current.key;
    if (this.now() - (this.wakes.get(identity) ?? -Infinity) < interval) return;
    this.armed = null;
    this.wakes.delete(identity); this.wakes.set(identity, this.now());
    while (this.wakes.size > 64) this.wakes.delete(this.wakes.keys().next().value!);
    const intent = { key: current.key, controller: new AbortController() };
    this.pending = intent;
    void this.options.wake(intent.key, intent.controller.signal).catch(error => {
      if (!intent.controller.signal.aborted && this.options.current()?.key === intent.key) this.options.failed?.(intent.key, error);
    }).finally(() => {
      if (this.pending === intent) this.pending = null;
      this.refresh();
    });
  }

  refresh(): void {
    if (this.closed) return;
    const current = this.options.current();
    const available = this.options.visible() && this.options.focused() && this.options.available();
    if (!available || current?.key !== this.armed?.key) this.armed = null;
    if (this.pending && (current?.key !== this.pending.key || !available)) { this.pending.controller.abort(); this.pending = null; }
    const key = current && !current.document.deletedAt && ["ready", "busy"].includes(current.document.status) &&
      available && this.now() - this.lastInput < INPUT_RECENCY_MS
      ? current.key : null;
    if (this.presentKey && this.presentKey !== key) {
      this.options.presence(this.presentKey, false); this.presentKey = null; this.lastPresence = -Infinity;
    }
    if (key && (this.presentKey !== key || this.now() - this.lastPresence >= PRESENCE_INTERVAL_MS)) {
      if (this.options.presence(key, true)) { this.presentKey = key; this.lastPresence = this.now(); }
    }
    // A recent gesture can race a committed idle stop while the catalog still
    // says ready. Allow its 30-second refresh plus network delay, bounded by
    // the existing two-minute wake window, without changing wake throttling.
    this.wakeIfArmed();
  }
  reconnect(): void { this.lastPresence = -Infinity; this.refresh(); }
  close(): void {
    if (this.presentKey) this.options.presence(this.presentKey, false);
    this.pending?.controller.abort(); this.pending = null; this.presentKey = null; this.closed = true;
  }
}

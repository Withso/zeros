import { CloudRuntimeUpdateReplySchema, type CloudRuntimeUpdateRequest, type CloudRuntimeUpdateReply } from "@zeros/protocol/cloud-v2-relay";
import type { RuntimeQuiescence } from "./runtime-quiescence";
import type { RuntimePermit } from "./runtime-permit";
import { PUSH_SIGNALS_RUNTIME_CHECK_MS } from "@zeros/protocol/cloud-v2-relay";

interface Options {
  gate: RuntimeQuiescence;
  permit: RuntimePermit;
  instanceId: string;
  revision(): string | undefined;
  flush(): Promise<void>;
  request(input: CloudRuntimeUpdateRequest, signal?: AbortSignal): Promise<CloudRuntimeUpdateReply>;
}

export class RuntimeUpdate {
  private task?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly lifetime = new AbortController();
  private nextCheck = 0;
  /** push-signals-v1: the control plane hints when an update is ready, so the status check is only a 15 min fallback. */
  private checkMs = 60_000;
  private id?: string;
  private committed = false;

  constructor(private readonly options: Options) {}
  start(): void {
    if (this.timer || this.lifetime.signal.aborted) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick().finally(() => this.start());
    }, 1000);
    this.timer.unref();
  }
  setPushSignals(on: boolean): void {
    this.checkMs = on ? PUSH_SIGNALS_RUNTIME_CHECK_MS : 60_000;
    // Back on an older control plane (no hints): the next check is at most the old minute away.
    if (!on) this.nextCheck = Math.min(this.nextCheck, Date.now() + this.checkMs);
  }
  /** A pushed hint: check at the next tick. */
  hint(): void { this.nextCheck = 0; }
  tick(): Promise<void> {
    return this.task ??= this.check().catch(() => {}).finally(() => { this.task = undefined; });
  }
  stop(): void {
    clearTimeout(this.timer); this.lifetime.abort(); this.options.gate.activity();
    try { this.options.permit.revoke(); } catch { /* Native retirement must still run if disk cleanup fails. */ }
    // Stop must reach native retirement synchronously; it never waits on an
    // update's provider I/O. The server's Stop generation also fences the boot.
    this.options.gate.release();
  }
  private async request(input: CloudRuntimeUpdateRequest): Promise<CloudRuntimeUpdateReply> {
    return CloudRuntimeUpdateReplySchema.parse(await this.options.request(input, this.lifetime.signal));
  }
  private async check(): Promise<void> {
    if (this.lifetime.signal.aborted) return;
    const { gate } = this.options;
    if (this.committed && this.id) {
      const status = await this.request({ op: "status", id: this.id });
      if (status.status === "cancelled") { this.options.permit.revoke(); this.committed = false; this.id = undefined; gate.release(); }
      else if (status.status === "committed") await this.request({ op: "activate", id: this.id });
      return;
    }
    const ticket = gate.ticket(), revision = this.options.revision();
    if (!ticket || revision === undefined || Date.now() < this.nextCheck) return;
    this.nextCheck = Date.now() + this.checkMs;
    const target = await this.request({ op: "status" });
    if (target.status !== "target" || !gate.valid(ticket)) return;
    const prepared = await this.request({ op: "prepare", revision, generation: ticket.generation, instanceId: this.options.instanceId });
    if (prepared.status !== "prepared") return;
    this.id = prepared.id;
    try {
      if (prepared.sha256 !== target.sha256 || !gate.valid(ticket) || !gate.freeze(ticket)) return;
      await this.options.flush();
      if (!gate.valid(ticket) || this.options.revision() !== revision || this.lifetime.signal.aborted) return;
      const committed = await this.request({ op: "commit", id: prepared.id, revision, generation: ticket.generation });
      if (committed.status !== "committed" || committed.id !== prepared.id || this.options.revision() !== revision ||
          this.lifetime.signal.aborted || !gate.commit(ticket)) return;
      this.options.permit.arm(prepared.id);
      this.committed = true;
      // No await separates the last census check from activation admission.
      // A committed handoff owns later foreground work until promotion/abort.
      await this.request({ op: "activate", id: prepared.id });
    } finally {
      if (!this.committed) {
        const cancelled = await this.request({ op: "cancel", id: prepared.id }).catch(() => null);
        if (cancelled?.status === "cancelled") { this.options.permit.revoke(); this.id = undefined; gate.release(); }
        else { this.committed = true; }
      }
    }
  }
}

import type { CloudRecoveryHint, CloudRecoveryReply, CloudRecoveryRequest } from "@zeros/protocol/cloud-v2-relay";
import type { RuntimeQuiescence } from "./runtime-quiescence";

/** Quiet samples while waiting for a ticket; pending/lost replies retry the same binding; a sealed worker confirms. */
export const RECOVERY_SAMPLE_MS = 1_000;
export const RECOVERY_RETRY_MS = 5_000;
export const RECOVERY_STATUS_MS = 60_000;

interface Options {
  gate: RuntimeQuiescence;
  request(input: CloudRecoveryRequest): Promise<CloudRecoveryReply>;
  /** Persist sessions and history before the seal; the control plane checkpoints only a sealed worker. */
  flush(): Promise<void>;
  /** Stops (true) or resumes (false) prompt claims. */
  pausePrompts(paused: boolean): void;
}

/** recovery-quiesce-v1 (worker half). On the control plane's hint, wait for the recovery census (turns, setup, writes;
 * not clients or terminals) to be quiet, freeze admissions and prompt claims, flush, then seal over the outbound path.
 * Once a seal is sent the worker stays frozen until an explicit `cancelled` for that exact id and generation: a lost
 * reply, `pending`, an error or a binding refusal may all mean the control plane is already checkpointing. */
export class RecoveryQuiesce {
  private target?: string;
  private sealed?: { id: string; generation: number; confirmed: boolean };
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private stopped = false;

  constructor(private readonly options: Options) {}

  get frozen(): boolean { return this.sealed !== undefined; }

  requested(hint: CloudRecoveryHint): void {
    // A sent seal stays bound to its attempt until it is explicitly cancelled.
    if (this.stopped || this.sealed || this.target === hint.id) return;
    this.target = hint.id;
    this.schedule(0);
  }

  /** Shutdown only: the process is ending (a checkpoint stops it), so nothing is released here. */
  stop(): void { this.stopped = true; clearTimeout(this.timer); this.timer = undefined; }

  private schedule(ms: number | undefined): void {
    clearTimeout(this.timer); this.timer = undefined;
    if (this.stopped || ms === undefined) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.step(); }, ms);
    this.timer.unref?.();
  }

  private async step(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    let next: number | undefined = RECOVERY_RETRY_MS;
    try { next = await this.advance(); }
    catch { /* Unexpected: keep the current phase and retry. */ }
    finally { this.running = false; }
    this.schedule(next);
  }

  private async advance(): Promise<number | undefined> {
    const { gate } = this.options;
    if (!this.sealed) {
      if (!this.target) return undefined;
      const ticket = gate.ticket("recovery");
      if (!ticket || !gate.freeze(ticket)) return RECOVERY_SAMPLE_MS;
      this.options.pausePrompts(true);
      const flushed = await this.options.flush().then(() => true, () => false);
      if (!flushed || this.stopped || !gate.valid(ticket)) {
        // Nothing was sent: work arrived or persistence failed, so reopen and wait for quiet again.
        gate.release(); this.options.pausePrompts(false);
        return RECOVERY_SAMPLE_MS;
      }
      this.sealed = { id: this.target, generation: ticket.generation, confirmed: false };
    }
    const sealed = this.sealed;
    let reply: CloudRecoveryReply;
    try { reply = await this.options.request({ op: sealed.confirmed ? "status" : "seal", id: sealed.id, generation: sealed.generation }); }
    catch { return RECOVERY_RETRY_MS; }
    // A different binding is a refusal, never a cancellation of this still-sealed attempt.
    if (reply.id !== sealed.id || reply.generation !== sealed.generation) return RECOVERY_RETRY_MS;
    if (reply.status === "cancelled") {
      this.sealed = undefined; this.target = undefined;
      gate.release(); this.options.pausePrompts(false);
      return undefined;
    }
    if (reply.status === "sealed") { sealed.confirmed = true; return RECOVERY_STATUS_MS; }
    return RECOVERY_RETRY_MS;
  }
}

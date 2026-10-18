import { CLOUD_WORKSPACE_ENGINE_CHECKPOINT_PROGRESS_PATH, CloudCheckpointProgressSchema,
  CLOUD_CHECKPOINT_SEAL_REFUSAL_HEADER, CloudCheckpointSealRefusalSchema,
  type CloudCheckpointProgress, type CloudCheckpointSealRefusal } from "@zeros/protocol/cloud-checkpoint-progress";
import type { CloudDurabilityAuthority } from "./cloud-durability-runtime";
import type { CloudCheckpointDirective } from "./cloud-runtime-registration";

type Stage = CloudCheckpointProgress["stage"];
type Reason = CloudCheckpointProgress["reason"];

/** Closed, best-effort observations only. None of these reports prove custody,
 * complete a checkpoint, or grant the engine any additional lifetime. */
export class CloudCheckpointProgressReporter {
  private readonly started = performance.now();
  private readonly deadline: number;
  private readonly authority: CloudDurabilityAuthority;
  private readonly requestId: string;
  private endpoint: URL | null = null;
  private sequence = 0;
  private activeStage: Stage = "checkpoint_received";
  private last: CloudCheckpointProgress | null = null;
  private pending: CloudCheckpointProgress | null = null;
  private flight: { controller: AbortController; timer: ReturnType<typeof setTimeout> } | null = null;
  private stopped = false;
  private terminal = false;
  private refusal: CloudCheckpointSealRefusal | null = null;

  constructor(private readonly options: {
    authority: CloudDurabilityAuthority;
    directive: CloudCheckpointDirective;
    registrationEndpoint: string;
    current(): boolean;
    unsupported?(): void;
    requestFetch?: typeof fetch;
  }) {
    this.authority = Object.freeze({ ...options.authority });
    this.requestId = options.directive.id;
    this.deadline = this.started + Math.min(300_000, options.directive.deadlineAtMs - Date.now());
    try {
      const heartbeat = new URL(this.authority.heartbeatEndpoint), registration = new URL(options.registrationEndpoint);
      if (heartbeat.protocol !== "https:" || heartbeat.origin !== registration.origin ||
          heartbeat.username || heartbeat.password || heartbeat.search || heartbeat.hash ||
          heartbeat.pathname !== "/internal/v1/cloud-workspaces/engine/heartbeat" ||
          !/^zwh_[A-Za-z0-9_-]{43}$/.test(this.authority.heartbeatToken)) return;
      this.endpoint = new URL(CLOUD_WORKSPACE_ENGINE_CHECKPOINT_PROGRESS_PATH, heartbeat);
    } catch { /* Malformed optional diagnostics must not change checkpoint execution. */ }
  }

  stage(stage: Stage): void {
    if (this.terminal) return;
    this.activeStage = stage;
    this.publish("running", "none");
  }

  sealRefusal(value: unknown): void {
    if (this.terminal || this.refusal || this.activeStage !== "seal_ack" || !this.current()) return;
    try {
      const parsed = CloudCheckpointSealRefusalSchema.safeParse(value);
      if (parsed.success) this.refusal = Object.freeze(parsed.data);
    } catch { /* Optional closed evidence cannot change checkpoint execution. */ }
  }

  fail(error: unknown, reason = checkpointFailureReason(error, this.activeStage)): void {
    if (this.terminal) return;
    this.terminal = true;
    // Abort an obsolete running observation before dispatching the first
    // failure. Cleanup never waits for its transport or replaces its cause.
    this.cancelFlight();
    this.pending = null;
    this.publish("failed", reason === "none" ? "unknown" : reason);
  }

  complete(): void {
    if (this.terminal) return;
    this.terminal = true;
    this.publish("completed", "none");
  }

  dispose(): void {
    this.stopped = true;
    this.pending = null;
    this.cancelFlight();
  }

  private current(): boolean {
    try {
      if (!this.stopped && this.endpoint && Number.isFinite(this.deadline) &&
          performance.now() < this.deadline && this.options.current()) return true;
    } catch { /* An observer never escapes into lifecycle authority. */ }
    this.dispose();
    return false;
  }

  private publish(state: CloudCheckpointProgress["state"], reason: Reason): void {
    if (!this.current() || this.sequence >= 64 || state === "running" && this.sequence >= 63) return;
    if (this.last?.stage === this.activeStage && this.last.state === state && this.last.reason === reason) return;
    const { organizationId, workspaceId, generation, engineInstanceId } = this.authority;
    const parsed = CloudCheckpointProgressSchema.safeParse({ version: 1, organizationId, workspaceId, generation,
      engineInstanceId, requestId: this.requestId, sequence: this.sequence + 1, stage: this.activeStage, state, reason,
      elapsedMs: Math.max(0, Math.min(300_000, Math.floor(performance.now() - this.started))) });
    if (!parsed.success) { this.dispose(); return; }
    this.sequence++;
    this.pending = this.last = Object.freeze(parsed.data);
    this.flush();
  }

  private cancelFlight(): void {
    const flight = this.flight;
    this.flight = null;
    if (flight) { clearTimeout(flight.timer); flight.controller.abort(); }
  }

  private flush(): void {
    if (this.flight || !this.pending || !this.current()) return;
    const body = this.pending;
    this.pending = null;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      // An unresponsive optional endpoint cannot grow a queue or create a
      // chain of retry timers. A subsequent stage is not a transport retry.
      if (this.flight === flight) this.dispose();
    }, Math.max(1, Math.min(1_000, Math.floor(this.deadline - performance.now()))));
    timer.unref?.();
    const flight = { controller, timer };
    this.flight = flight;
    void this.send(body, flight);
  }

  private async send(body: CloudCheckpointProgress, flight: NonNullable<CloudCheckpointProgressReporter["flight"]>): Promise<void> {
    try {
      const response = await (this.options.requestFetch ?? fetch)(this.endpoint!, {
        method: "POST", redirect: "error", signal: flight.controller.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${this.authority.heartbeatToken}`,
          ...(body.state === "failed" && body.stage === "seal_ack" && this.refusal
            ? { [CLOUD_CHECKPOINT_SEAL_REFUSAL_HEADER]: JSON.stringify(this.refusal) } : {}) },
        body: JSON.stringify(body),
      });
      // No response body is needed, trusted, parsed, logged or allowed to keep
      // the reporter occupied. A late response cannot mutate a replacement.
      void response.body?.cancel().catch(() => undefined);
      if (this.flight !== flight || flight.controller.signal.aborted || !this.current()) return;
      if (response.status === 404) {
        this.dispose();
        try { this.options.unsupported?.(); } catch { /* Diagnostic-only callback. */ }
      }
    } catch { /* Network/auth/internal diagnostic failures never retire the engine. */ }
    finally {
      clearTimeout(flight.timer);
      if (this.flight === flight) {
        this.flight = null;
        this.flush();
      }
    }
  }
}

/** Never serialize an Error message, arbitrary code, native path or output. */
function checkpointFailureReason(error: unknown, stage: Stage): Reason {
  if (!error || typeof error !== "object") return "unknown";
  try {
    const { code, name } = error as { code?: unknown; name?: unknown };
    if (name === "CloudCheckpointDeadlineError") return "deadline";
    if (code === "cloud_containment_environment_not_ready") return "native_custody";
    if (code === "engine_authority_rejected" || code === "cloud_actor_authority_rejected" ||
        code === "credential_control_authority_rejected") return "authority_rejected";
    if (code === "checkpoint_pending_work" || code === "command_conflict" && stage === "command_drain") return "pending_work";
    if (code === "command_storage_unavailable" || typeof code === "string" && code.startsWith("checkpoint_")) return "storage";
    if (stage === "mirror_flush") return "mirror";
  } catch { /* Even hostile error properties reduce to a closed class. */ }
  return "unknown";
}

import { CloudWorkspaceEngineAuthorityError } from "../cloud-workspaces/engine-authority.js";
import type { DatabaseCloudIdleStop } from "../cloud-workspaces/idle-stop.js";
import type { UplinkIdentity } from "./uplink-authority.js";
import type { UplinkActivityReport } from "./uplink-protocol.js";

/** Quiet time before `realtime` requests an `idle.v1` uplink's stop; the
 * engine's own `CLOUD_IDLE_STOP_MS`. */
export const UPLINK_IDLE_STOP_MS = 10 * 60_000;

/** `requested`: an idle checkpoint request is open for this engine.
 * `declined`: the transaction found the engine too young, durable work or
 * another lifecycle intent. `authority`: the credential or engine is no
 * longer current. `unavailable`: the transaction did not complete. */
export type UplinkIdleStopResult = "requested" | "declined" | "unavailable" | "authority";

export interface UplinkIdleStopStore {
  request(identity: UplinkIdentity, heartbeatToken: string, attemptId: string): Promise<UplinkIdleStopResult>;
}

/** The HTTP idle-stop route's transaction, called by the uplink owner. */
export class DatabaseUplinkIdleStopStore implements UplinkIdleStopStore {
  constructor(private readonly service: DatabaseCloudIdleStop) {}

  async request(identity: UplinkIdentity, heartbeatToken: string, attemptId: string): Promise<UplinkIdleStopResult> {
    try {
      const directive = await this.service.request({
        workspaceId: identity.workspaceId, organizationId: identity.organizationId, generation: identity.generation,
        engineInstanceId: identity.engineInstanceId, heartbeatToken,
      }, attemptId);
      return directive ? "requested" : "declined";
    } catch (error) {
      return error instanceof CloudWorkspaceEngineAuthorityError ? "authority" : "unavailable";
    }
  }
}

const RETRY_BASE_MS = 15_000;
const RETRY_CAP_MS = 120_000;
/** Reports of one quiet stretch differ by transit time; a start later than
 * this means the engine saw activity its counts do not show. */
const QUIET_RESTART_SLACK_MS = 5_000;
/** `activity.report.windowMs` maximum: a capped window is still one stretch. */
const WINDOW_CAP_MS = 3_600_000;

/** Per-uplink idle decision. Only reports move it: no report means unknown,
 * and unknown never stops a workspace. */
export class UplinkIdleDecision {
  private quietSinceMs: number | null = null;
  private retryAtMs = 0;
  private attempts = 0;

  constructor(private readonly idleStopMs: number) {}

  /** Records a report received at `receivedAtMs`; returns when a stop may be
   * requested, or null while the engine is not quiet. */
  report(activity: UplinkActivityReport, receivedAtMs: number): number | null {
    const quiet = activity.clients === 0 && activity.runningTurns === 0 && activity.liveTerminals === 0 && activity.windowMs > 0;
    const since = receivedAtMs - activity.windowMs;
    const restarted = this.quietSinceMs !== null && since > this.quietSinceMs + QUIET_RESTART_SLACK_MS &&
      activity.windowMs < WINDOW_CAP_MS;
    if (!quiet || this.quietSinceMs === null || restarted) {
      this.quietSinceMs = quiet ? since : null;
      this.retryAtMs = 0;
      this.attempts = 0;
    }
    return this.dueAtMs();
  }

  dueAtMs(): number | null {
    return this.quietSinceMs === null ? null : Math.max(this.quietSinceMs + this.idleStopMs, this.retryAtMs);
  }

  attempted(nowMs: number, result: UplinkIdleStopResult): void {
    if (this.quietSinceMs === null) return;
    this.attempts += 1;
    this.retryAtMs = result === "authority" ? Number.POSITIVE_INFINITY
      : result === "requested" ? nowMs + this.idleStopMs
      : nowMs + Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.min(this.attempts - 1, 3));
  }
}

import { AsyncResource } from "node:async_hooks";
import type pg from "pg";
import { withSystemTx } from "../../db.js";
import { LOCAL_COMMAND_FAILURE_REASONS, LOCAL_COMMAND_OUTCOMES, type LocalCommandOutcome } from "./contract.js";

const TARGET_REASONS = ["sender_invalid", "not_connected", "not_reachable", "registration_changed", "ambiguous_name"] as const;
export type LocalTargetReason = typeof TARGET_REASONS[number];
const CHANNEL_REASONS = ["token_end", "revoked:session_revoked", "revoked:device_registration_changed", "client_closed", "signals_unhealthy", "error"] as const;
export type LocalChannelCloseReason = typeof CHANNEL_REASONS[number];
type Ids = { userId?: string | null; deviceId?: string | null; registrationId?: string; instanceId?: string; workspaceId?: string; requestId?: string };
export type LocalCommandDiagnostic = Ids & (
  | { event: "device_registered"; outcome: "new" | "replayed" }
  | { event: "channel_opened" }
  | { event: "channel_closed"; reason: LocalChannelCloseReason; secondsOpen: number }
  | { event: "request_created"; outcome: LocalCommandOutcome | "pending"; reason?: LocalTargetReason }
  | { event: "received" }
  | { event: "claimed"; decision: "approve" | "deny" }
  | { event: "terminal"; outcome: LocalCommandOutcome; reason?: string | null; durationMs: number }
  | { event: "diagnostics_unavailable" | "diagnostics_limited" }
);

// Payloads and caller-selected chat/execution IDs never cross this allowlist.
export function localCommandDiagnostic(value: LocalCommandDiagnostic): void {
  const record: Record<string, string | number> = {};
  for (const field of ["userId", "deviceId", "registrationId", "instanceId", "workspaceId", "requestId"] as const) {
    const id = value[field];
    if (typeof id === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) record[field] = id.slice(0, 8).toLowerCase();
  }
  const code = (field: string, candidate: unknown, allowed: readonly string[]) => {
    if (typeof candidate === "string" && allowed.includes(candidate)) record[field] = candidate;
  };
  const duration = (field: string, candidate: number) => {
    if (Number.isFinite(candidate)) record[field] = Math.max(0, Math.round(candidate * 1000) / 1000);
  };
  switch (value.event) {
    case "device_registered": code("outcome", value.outcome, ["new", "replayed"]); break;
    case "request_created":
      code("outcome", value.outcome, ["pending", ...LOCAL_COMMAND_OUTCOMES]);
      code("reason", value.reason, TARGET_REASONS); break;
    case "claimed": code("decision", value.decision, ["approve", "deny"]); break;
    case "terminal":
      code("outcome", value.outcome, LOCAL_COMMAND_OUTCOMES);
      code("reason", value.reason, ["not_delivered", ...LOCAL_COMMAND_FAILURE_REASONS]);
      duration("durationMs", value.durationMs); break;
    case "channel_closed":
      code("reason", value.reason, CHANNEL_REASONS);
      duration("secondsOpen", value.secondsOpen); break;
    case "channel_opened": case "received": case "diagnostics_unavailable": case "diagnostics_limited": break;
    default: return;
  }
  console.log(`[local-commands] ${value.event} ${JSON.stringify(record)}`);
}

type Terminal = { workspace_id: string; request_id: string; sender_user_id: string | null; target_device_id: string | null;
  outcome: LocalCommandOutcome; reason: string | null; duration_ms: string };

/** NOTIFY arrives after commit, including transitions made by fencing triggers.
 * This bounded, best-effort observer never participates in request authority. */
export class LocalCommandTerminalDiagnostics {
  private readonly pending = new Map<string, { workspaceId: string; requestId: string }>();
  private readonly logged = new Set<string>();
  private flight: Promise<void> | undefined;
  private closed = false;
  constructor(private readonly pool: pg.Pool) {}

  readonly changed = AsyncResource.bind((workspaceId: string, requestId: string): void => {
    const key = `${workspaceId}:${requestId}`;
    if (this.closed || this.logged.has(key) || this.pending.has(key)) return;
    if (this.pending.size >= 4096) { localCommandDiagnostic({ event: "diagnostics_limited" }); return; }
    this.pending.set(key, { workspaceId, requestId });
    this.start();
  }, "local-command-diagnostics");

  private start(): void {
    this.flight ??= this.drain().finally(() => {
      this.flight = undefined;
      if (this.pending.size) this.start();
    });
  }

  private async drain(): Promise<void> {
    while (this.pending.size) {
      const batch = [...this.pending.entries()].slice(0, 128);
      for (const [key] of batch) this.pending.delete(key);
      try {
        const { rows } = await withSystemTx(this.pool, tx => tx.query<Terminal>(`SELECT r.workspace_id,r.request_id,r.sender_user_id,r.target_device_id,r.outcome,
          CASE WHEN r.outcome='mac_not_connected' AND r.target_device_id IS NOT NULL AND r.delivered_at IS NULL
            AND r.terminal_at>=r.delivery_deadline THEN 'not_delivered'
            WHEN r.outcome='failed' THEN r.result_summary->>'error' END AS reason,
          extract(epoch FROM (r.terminal_at-r.created_at))*1000 AS duration_ms
          FROM unnest($1::uuid[],$2::uuid[]) AS changed(workspace_id,request_id)
          JOIN local_command_requests r USING(workspace_id,request_id) WHERE r.phase='terminal'`,
        [batch.map(([, row]) => row.workspaceId), batch.map(([, row]) => row.requestId)]), { consistentRead: true });
        for (const row of rows) {
          const key = `${row.workspace_id}:${row.request_id}`;
          if (this.logged.has(key)) continue;
          if (this.logged.size >= 8192) this.logged.delete(this.logged.values().next().value!);
          this.logged.add(key);
          localCommandDiagnostic({ event: "terminal", workspaceId: row.workspace_id, requestId: row.request_id,
            userId: row.sender_user_id, deviceId: row.target_device_id, outcome: row.outcome, reason: row.reason, durationMs: Number(row.duration_ms) });
        }
      } catch { localCommandDiagnostic({ event: "diagnostics_unavailable" }); }
    }
  }

  async close(): Promise<void> { this.closed = true; while (this.flight) await this.flight; }
}

import { performance } from "node:perf_hooks";
import type pg from "pg";
import type { AuthedUser } from "../../auth.js";
import { HttpError } from "../../authz.js";
import { withSystemTx, type Tx } from "../../db.js";
import type { CloudAgentCredentialKeys } from "../../agent-credentials/agent-credential-envelope.js";
import { CloudLocalDevices, notFound } from "../local-commands/devices.js";
import type { LocalDeviceBinding } from "../local-commands/contract.js";
import { RUNTIME_HANDOFF_SESSION } from "../runtime-handoff-store.js";
import type { CloudSourceContinuation, CloudSourceProof } from "../source-authority.js";
import type { CloudV2Store, CloudV2Workspace } from "../store.js";
import { hashCloudV2Token } from "../tokens.js";
import { CloudV2WorkerSigner } from "../worker-auth.js";
import { openPortToken } from "../worker-port-token.js";
import { CLOUD_V2_LIVE_ACCESS, cloudV2ActorAccess } from "../workspace-access.js";
import type { CloudExecutionContexts } from "../execution/store.js";
import { EXECUTION_MINIMUM_LIFETIME_MS, assertExecutionLifetime, withExecutionLifetimeRetry } from "../execution/lifetime.js";
import { SyncGrantReplySchema, type SyncGrantReply } from "./contract.js";

const notRunning = () => new HttpError(409, "cloud_workspace_not_running", "The cloud workspace is not running");
const unavailable = () => new HttpError(503, "cloud_sync_unavailable", "Workspace sync is temporarily unavailable");
type Route = { access_epoch: string; login_revision: string; stop_generation: string; worker_boot_id: string | null;
  boat_sandbox_id: string | null; worker_route_url: string | null; worker_port_token: unknown; worker_token_hash: string | null;
  state: string; archived: boolean; source_pending: boolean; capable: boolean | null; context_capable: boolean; blocked: boolean;
  connected: boolean; connected_at: string | null; device_current: boolean; session_current: boolean; execution_mode: string };

export class CloudWorkspaceSync {
  execution?: CloudExecutionContexts;
  constructor(private readonly pool: pg.Pool, private readonly devices: CloudLocalDevices,
    private readonly store: Pick<CloudV2Store, "promptContext">, private readonly keys: CloudAgentCredentialKeys,
    private readonly signer: CloudV2WorkerSigner,
    private readonly continueSource: (workspace: CloudV2Workspace, proof: CloudSourceProof) => Promise<CloudSourceContinuation>) {}

  private read(workspaceId: string, user: AuthedUser, binding: LocalDeviceBinding, transaction?: Tx): Promise<Route> {
    const read = async (tx: Tx) => {
      await this.devices.verify(tx, user, binding);
      // Recheck session and device in the route's statement snapshot too: the
      // earlier device read can have waited while either was revoked.
      const row = (await tx.query<Route>(`SELECT w.access_epoch::text,w.login_revision::text,w.stop_generation::text,
        w.worker_boot_id,w.boat_sandbox_id,w.worker_route_url,w.worker_port_token,encode(w.worker_token_hash,'hex') AS worker_token_hash,
        w.state,w.execution_mode,w.archived_at IS NOT NULL AS archived,w.source_pending,w.worker_boot_id=ANY(w.sync_boot_ids) AS capable,
        w.worker_boot_id=ANY(w.sync_context_boot_ids) AND w.worker_boot_id=ANY(w.acting_user_boot_ids) AS context_capable,
        EXISTS (SELECT 1 FROM cloud_worker_runtime_handoffs h WHERE h.workspace_id=w.id
          AND h.token_hash=w.worker_token_hash AND h.sandbox_id=w.boat_sandbox_id AND h.state IN ('committed','activating','rolling_back')) AS blocked,
        coalesce(c.disconnected_at IS NULL AND c.registration_id=d.registration_id
          AND (c.is_latest_sender OR greatest(c.connected_at,c.last_used_at)>clock_timestamp()-interval '12 hours'),false) AS connected,
        c.connected_at::text,d.revoked_at IS NULL AND d.provider_session_id=$6 AND d.registration_id=$4 AND d.instance_id=$5 AS device_current,
        EXISTS (SELECT 1 FROM auth_sessions s JOIN user_identities i ON i.user_id=s.user_id AND i.provider='workos' AND i.provider_sub=s.provider_sub
          JOIN users u ON u.id=s.user_id WHERE s.user_id=$2 AND s.provider='workos' AND s.provider_session_id=$6
            AND s.status='active' AND s.revoked_at IS NULL AND (s.provider_session_expires_at IS NULL OR s.provider_session_expires_at>clock_timestamp())
            AND i.provider_sub=$7 AND i.status='active' AND u.auth_revision=$8 AND u.auth_status='active' AND u.deleted_at IS NULL
            AND ($9::bigint IS NULL OR clock_timestamp()<to_timestamp($9::bigint))) AS session_current
        FROM cloud_v2_workspaces w JOIN local_command_devices d ON d.user_id=$2 AND d.device_id=$3
        LEFT JOIN cloud_v2_connected_macs c ON c.workspace_id=w.id AND c.user_id=d.user_id AND c.device_id=d.device_id
        WHERE w.id=$1 AND ${cloudV2ActorAccess("$2")} AND w.state NOT IN ('deleting','deleted') AND ${CLOUD_V2_LIVE_ACCESS}`,
      [workspaceId, user.id, binding.deviceId, binding.registrationId, binding.instanceId, user.authentication.sessionId,
        user.identity.subject, user.accountRevision, user.authentication.tokenExpiresAt])).rows[0];
      if (!row) throw notFound();
      if (!row.session_current) throw new HttpError(401, "session_revoked", "Authentication is no longer current");
      if (!row.device_current) throw new HttpError(409, "device_registration_changed", "This desktop registration is no longer current");
      if (!row.connected) throw new HttpError(403, "mac_not_connected", "Connect this Mac to the workspace before syncing");
      if (row.state !== "running" || row.archived || row.source_pending || row.blocked || !row.worker_boot_id || !row.worker_token_hash || !row.boat_sandbox_id)
        throw notRunning();
      if (!row.capable || row.execution_mode === "active" && !row.context_capable) throw new HttpError(409, "worker_update_required", "Update the workspace runtime before syncing");
      if (!row.worker_route_url || !row.worker_port_token) throw notRunning();
      return row;
    };
    return transaction ? read(transaction) : withSystemTx(this.pool, read);
  }

  async grant(workspaceId: string, user: AuthedUser, binding: LocalDeviceBinding): Promise<SyncGrantReply> {
    workspaceId = workspaceId.toLowerCase();
    const before = await this.read(workspaceId, user, binding);
    if (before.execution_mode === "active") return this.activeGrant(workspaceId, user, binding, before);
    const { workspace, proof } = await this.store.promptContext(workspaceId, user.id);
    if (workspace.state !== "running" || workspace.archivedAt || workspace.sourcePending ||
      before.access_epoch !== proof.accessEpoch || before.login_revision !== proof.loginRevision) throw notRunning();
    const source = await this.continueSource(workspace, proof);
    const until = Math.min(source.recheckAt, source.graceUntil ?? Infinity);
    const started = Date.now(), monotonic = performance.now();
    const after = await this.read(workspaceId, user, binding);
    for (const field of ["access_epoch", "login_revision", "stop_generation", "worker_boot_id", "boat_sandbox_id", "worker_token_hash",
      "worker_route_url", "connected_at"] as const) if (after[field] !== before[field]) throw notRunning();
    if (JSON.stringify(after.worker_port_token) !== JSON.stringify(before.worker_port_token)) throw notRunning();
    if (Date.now() >= until)
      throw new HttpError(503, "github_verification_expired", "Repository verification took too long. Try again.");
    const iat = Math.floor(started / 1000), expiresAt = (iat + 60) * 1000;
    if (Date.now() >= expiresAt || performance.now() - monotonic >= 60_000) throw unavailable();
    try {
      return SyncGrantReplySchema.parse({ url: after.worker_route_url, portAuth: openPortToken(after.worker_port_token, workspaceId, this.keys),
        grant: this.signer.mintSync(workspaceId, after.worker_boot_id!, user.id, binding.deviceId, iat), expiresAt: new Date(expiresAt).toISOString() });
    } catch { throw unavailable(); }
  }

  private async activeGrant(workspaceId: string, user: AuthedUser, binding: LocalDeviceBinding, before: Route): Promise<SyncGrantReply> {
    if (!this.execution) throw unavailable();
    const execution = this.execution;
    return withExecutionLifetimeRetry(async () => {
      const proof = await execution.deps.authority.admit(workspaceId, user.id, { user, minimumSourceMs: EXECUTION_MINIMUM_LIFETIME_MS });
      const started = Date.now(), monotonic = performance.now(), iat = Math.floor(started / 1000), expiresAt = (iat + 60) * 1000;
      return withSystemTx(this.pool, async tx => {
        await tx.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [workspaceId]);
        await this.devices.verify(tx, user, binding, true);
        const after = await this.read(workspaceId, user, binding, tx);
        for (const field of ["execution_mode", "access_epoch", "stop_generation", "worker_boot_id", "boat_sandbox_id", "worker_token_hash",
          "worker_route_url", "connected_at"] as const) if (after[field] !== before[field]) throw notRunning();
        if (JSON.stringify(after.worker_port_token) !== JSON.stringify(before.worker_port_token)) throw notRunning();
        await execution.deps.authority.assert(proof, tx);
        await execution.boots.assertClean(tx, { id: workspaceId, worker_boot_id: after.worker_boot_id!,
          access_epoch: after.access_epoch, stop_generation: after.stop_generation, worker_token_hash: Buffer.from(after.worker_token_hash!, "hex") });
        const context = await execution.sync.grant(tx, proof, user, binding, after.connected_at!, iat);
        const reply = SyncGrantReplySchema.parse({ url: after.worker_route_url, portAuth: openPortToken(after.worker_port_token, workspaceId, this.keys),
          grant: this.signer.mintSync(workspaceId, after.worker_boot_id!, user.id, binding.deviceId, iat, context.id), expiresAt: new Date(expiresAt).toISOString() });
        await execution.deps.authority.assert(proof, tx);
        await this.read(workspaceId, user, binding, tx);
        if (Date.now() >= expiresAt || performance.now() - monotonic >= 60_000) throw unavailable();
        assertExecutionLifetime(context.expires_at.getTime());
        return reply;
      });
    });
  }

  async advertise(token: string, bootId: string, supported: boolean, handoff?: string, contextSupported = false): Promise<boolean> {
    const bootIdsFor = (column: "sync_boot_ids" | "sync_context_boot_ids", supported: "$5" | "$6") => `ARRAY(
      SELECT DISTINCT id FROM unnest(${column} || CASE WHEN ${supported} THEN ARRAY[$2::uuid] ELSE '{}'::uuid[] END) AS boots(id)
      WHERE (id=w.worker_boot_id OR id=$2::uuid OR ($3::uuid IS NULL AND id=(
        SELECT CASE WHEN h.state='rolling_back' THEN h.rollback_boot_id ELSE h.next_boot_id END
        FROM cloud_worker_runtime_handoffs h WHERE h.workspace_id=w.id AND h.old_boot_id=w.worker_boot_id
          AND h.token_hash=w.worker_token_hash AND h.state IN ('activating','rolling_back')))) AND (id<>$2::uuid OR ${supported})
      ORDER BY id)`;
    const bootIds = bootIdsFor("sync_boot_ids", "$5"), contextBootIds = bootIdsFor("sync_context_boot_ids", "$6");
    const authority = `worker_token_hash=$1 AND state IN ('creating','starting','running') AND ${CLOUD_V2_LIVE_ACCESS}
      AND (($3::uuid IS NULL AND worker_boot_id=$2) OR ($3::uuid IS NOT NULL AND ${RUNTIME_HANDOFF_SESSION}))`;
    const parameters = [hashCloudV2Token(token), bootId, handoff ?? null, null, supported, supported && contextSupported];
    return withSystemTx(this.pool, async tx => {
      const row = (await tx.query<{ unchanged: boolean }>(`SELECT sync_boot_ids=${bootIds} AND sync_context_boot_ids=${contextBootIds} AS unchanged
        FROM cloud_v2_workspaces w WHERE ${authority}`, parameters)).rows[0];
      if (!row) return false;
      if (row.unchanged) return true;
      return Boolean((await tx.query(`UPDATE cloud_v2_workspaces w SET sync_boot_ids=${bootIds},sync_context_boot_ids=${contextBootIds} WHERE ${authority}`, parameters)).rowCount);
    });
  }
}

import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import type { AuthedUser } from "../../auth.js";
import { HttpError } from "../../authz.js";
import { withSystemTx, type Tx } from "../../db.js";
import { SECURITY_STREAM_AUTHORITY, securityStreamAuthority, securityStreamParameters } from "../../security-events.js";
import { CLOUD_V2_CREATOR_ACCESS_SQL, CLOUD_V2_LIVE_ACCESS, cloudV2ActorAccess } from "../workspace-access.js";
import type { CloudExecutionContexts } from "../execution/store.js";
import type { DeviceSyncConnectionsReply, SyncFlags } from "../workspace-sync/contract.js";
import { LOCAL_COMMANDS_FEATURE, LOCAL_COMMANDS_REASON_FEATURE, type ConnectedMac, type LocalDevice, type LocalDeviceBinding, type LocalDevicePresence, type LocalDeviceRegistration } from "./contract.js";
import { localCommandDiagnostic } from "./diagnostics.js";

export const DEVICE_HEARTBEAT_MS = 25_000;
export const DEVICE_LEASE_MS = 65_000;
export const notFound = () => new HttpError(404, "not_found", "Local command resource not found");
const changed = () => new HttpError(409, "device_registration_changed", "This desktop registration is no longer current");
export const limited = () => new HttpError(429, "local_commands_limited", "Local command capacity is temporarily full");
export type DeviceRow = { user_id: string; device_id: string; provider_session_id: string; registration_id: string; instance_id: string;
  registration_request_id: string; registration_hash: Buffer; name: string; revoked_at: Date | null; reachable_until: Date | null;
  presence_required: boolean; has_requests: boolean; checked_at: Date; reason_instance_id: string | null };
const connectionLive = `(c.disconnected_at IS NULL AND c.registration_id=d.registration_id
  AND (c.is_latest_sender OR greatest(c.connected_at,c.last_used_at)>clock_timestamp()-interval '12 hours'))`;
const presenceSql = `EXISTS (SELECT 1 FROM cloud_v2_connected_macs c JOIN cloud_v2_workspaces w ON w.id=c.workspace_id
  WHERE c.user_id=d.user_id AND c.device_id=d.device_id AND ${connectionLive} AND w.state NOT IN ('deleting','deleted')
    AND ${CLOUD_V2_LIVE_ACCESS} AND EXISTS (SELECT 1 FROM organization_members m WHERE m.org_id=w.org_id AND m.user_id=d.user_id))`;
const device = (row: DeviceRow): LocalDevice => ({ deviceId: row.device_id, registrationId: row.registration_id, instanceId: row.instance_id,
  name: row.name, capabilities: row.reason_instance_id === row.instance_id
    ? [LOCAL_COMMANDS_FEATURE, LOCAL_COMMANDS_REASON_FEATURE] : [LOCAL_COMMANDS_FEATURE] });
const presence = (row: DeviceRow): LocalDevicePresence => ({ presenceRequired: row.presence_required,
  reachableUntil: row.presence_required ? row.reachable_until?.toISOString() ?? null : null });

export async function localUserAuthority(tx: Tx, user: AuthedUser, desktop = false): Promise<void> {
  if (desktop && (user.authentication?.clientKind !== "desktop" || !user.authentication.sessionId))
    throw new HttpError(401, "unauthorized", "A signed-in desktop session is required");
  if (!await securityStreamAuthority(tx, user)) throw new HttpError(401, "session_revoked", "Authentication is no longer current");
}

export async function localWorkspace(tx: Tx, workspaceId: string, userId: string, lock = false): Promise<void> {
  const row = await tx.query(`SELECT id FROM cloud_v2_workspaces w WHERE id=$1 AND ${cloudV2ActorAccess("$2")}
    AND state NOT IN ('deleting','deleted') AND ${CLOUD_V2_LIVE_ACCESS} ${lock ? "FOR UPDATE OF w" : ""}`, [workspaceId, userId]);
  if (!row.rowCount) throw notFound();
  if (lock && !(await tx.query(`SELECT id FROM cloud_v2_workspaces w WHERE id=$1 AND ${cloudV2ActorAccess("$2")} AND ${CLOUD_V2_LIVE_ACCESS}`, [workspaceId,userId])).rowCount) throw notFound();
}

/** Device identity is account/session authority. Connection expiry is a
 * separate fact: a channel heartbeat cannot make a workspace connection live. */
export class CloudLocalDevices {
  execution?: CloudExecutionContexts;
  constructor(readonly pool: pg.Pool) {}

  private async workspace<T>(user: AuthedUser, workspaceId: string, action: (tx: Tx) => Promise<T>, read = false): Promise<T> {
    const proof = this.execution && await this.execution.active(workspaceId)
      ? await this.execution.deps.authority.admit(workspaceId, user.id, { user }) : undefined;
    return withSystemTx(this.pool, async tx => {
      if (proof) await this.execution!.deps.authority.assert(proof, tx);
      const result = await action(tx);
      if (proof) await this.execution!.deps.authority.assert(proof, tx);
      return result;
    }, { consistentRead: read && !proof });
  }

  async verify(tx: Tx, user: AuthedUser, binding: LocalDeviceBinding, lock = false): Promise<DeviceRow> {
    const row = (await tx.query<DeviceRow>(`SELECT d.*,clock_timestamp() AS checked_at,${presenceSql} AS presence_required,
      EXISTS (SELECT 1 FROM local_command_requests r WHERE r.sender_user_id=d.user_id AND r.target_device_id=d.device_id
        AND r.target_registration_id=d.registration_id AND r.device_ack_at IS NULL) AS has_requests FROM local_command_devices d
      WHERE user_id=$1 AND device_id=$2 ${lock ? "FOR UPDATE OF d" : ""}`, [user.id, binding.deviceId])).rows[0];
    if (!row) throw notFound();
    await localUserAuthority(tx, user, true);
    if (row.revoked_at || row.provider_session_id !== user.authentication.sessionId || row.registration_id !== binding.registrationId || row.instance_id !== binding.instanceId) throw changed();
    return row;
  }

  snapshot(user: AuthedUser, binding: LocalDeviceBinding) {
    return withSystemTx(this.pool, async tx => {
      const row = await this.verify(tx, user, binding);
      return { device: device(row), presence: presence(row), hasRequests: row.has_requests, checkedAt: row.checked_at.toISOString() };
    }, { consistentRead: true });
  }

  async register(user: AuthedUser, deviceId: string, input: LocalDeviceRegistration) {
    let replayed = false;
    const result = await withSystemTx(this.pool, async tx => {
      await localUserAuthority(tx, user, true);
      // The account row orders concurrent new installs against the device cap.
      await tx.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [user.id]);
      const old = (await tx.query<DeviceRow>("SELECT * FROM local_command_devices WHERE user_id=$1 AND device_id=$2 FOR UPDATE", [user.id, deviceId])).rows[0];
      await localUserAuthority(tx, user, true);
      const hash = createHash("sha256").update(JSON.stringify([input.name, input.capabilities])).digest();
      if (old?.registration_request_id === input.requestId) {
        if (old.revoked_at || old.provider_session_id !== user.authentication.sessionId) throw changed();
        if (!old.registration_hash.equals(hash)) throw new HttpError(409, "device_registration_conflict", "This registration request was already used");
        replayed = true;
      } else {
        if (Number((await tx.query(`SELECT count(*) FROM local_command_devices d
          JOIN auth_sessions s ON s.provider='workos' AND s.provider_session_id=d.provider_session_id AND s.user_id=d.user_id
          WHERE d.user_id=$1 AND d.device_id<>$2 AND d.revoked_at IS NULL AND s.status='active' AND s.revoked_at IS NULL
            AND (s.provider_session_expires_at IS NULL OR s.provider_session_expires_at>clock_timestamp())
            AND EXISTS (SELECT 1 FROM user_identities i WHERE i.user_id=d.user_id AND i.provider='workos' AND i.provider_sub=s.provider_sub AND i.status='active')`, [user.id, deviceId])).rows[0].count) >= 20) throw limited();
        const registrationId = old && !old.revoked_at && old.provider_session_id === user.authentication.sessionId ? old.registration_id : randomUUID();
        const instanceId = randomUUID();
        await tx.query(`INSERT INTO local_command_devices(user_id,device_id,provider_session_id,registration_id,instance_id,registration_request_id,registration_hash,name,reason_instance_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(user_id,device_id) DO UPDATE SET provider_session_id=EXCLUDED.provider_session_id,
            registration_id=EXCLUDED.registration_id,instance_id=EXCLUDED.instance_id,registration_request_id=EXCLUDED.registration_request_id,
            registration_hash=EXCLUDED.registration_hash,name=EXCLUDED.name,reason_instance_id=EXCLUDED.reason_instance_id,
            revoked_at=NULL,reachable_until=NULL,updated_at=clock_timestamp()`,
        [user.id, deviceId, user.authentication.sessionId, registrationId, instanceId, input.requestId, hash, input.name,
          input.capabilities.some(value => value === LOCAL_COMMANDS_REASON_FEATURE) ? instanceId : null]);
      }
      const row = (await tx.query<DeviceRow>(`SELECT d.*,${presenceSql} AS presence_required FROM local_command_devices d WHERE user_id=$1 AND device_id=$2`, [user.id, deviceId])).rows[0]!;
      return { device: device(row), presence: presence(row), heartbeatIntervalMs: DEVICE_HEARTBEAT_MS };
    });
    localCommandDiagnostic({ event: "device_registered", outcome: replayed ? "replayed" : "new", userId: user.id,
      deviceId, registrationId: result.device.registrationId, instanceId: result.device.instanceId });
    return result;
  }

  /** A NotifyUser hint reaches every live registration of the person. It
   * carries no text, and neither connections nor presence grant this delivery. */
  async notifyUser(tx: Tx, userId: string, workspaceId: string, notificationId: string): Promise<void> {
    await tx.query(`SELECT pg_notify('zeros_local_commands',json_build_object('userId',d.user_id,'deviceId',d.device_id,
      'registrationId',d.registration_id,'instanceId',d.instance_id,'workspaceId',$2::uuid,'notificationId',$3::uuid)::text)
      FROM local_command_devices d
      JOIN auth_sessions s ON s.provider='workos' AND s.provider_session_id=d.provider_session_id AND s.user_id=d.user_id
      WHERE d.user_id=$1 AND d.revoked_at IS NULL AND s.status='active' AND s.revoked_at IS NULL
        AND (s.provider_session_expires_at IS NULL OR s.provider_session_expires_at>clock_timestamp())
        AND EXISTS (SELECT 1 FROM user_identities i WHERE i.user_id=d.user_id AND i.provider='workos'
          AND i.provider_sub=s.provider_sub AND i.status='active') LIMIT 20`,[userId,workspaceId,notificationId]);
  }

  unregister(user: AuthedUser, binding: LocalDeviceBinding) {
    return withSystemTx(this.pool, async tx => {
      await this.verify(tx, user, binding, true);
      await tx.query("UPDATE local_command_devices SET revoked_at=clock_timestamp(),reachable_until=NULL,updated_at=clock_timestamp() WHERE user_id=$1 AND device_id=$2", [user.id, binding.deviceId]);
    });
  }

  heartbeat(user: AuthedUser, binding: LocalDeviceBinding) {
    return withSystemTx(this.pool, async tx => {
      const row = await this.verify(tx, user, binding);
      if (!row.presence_required) return presence(row);
      await tx.query(`UPDATE local_command_devices d SET reachable_until=clock_timestamp()+interval '65 seconds',updated_at=clock_timestamp()
        WHERE user_id=$1 AND device_id=$2 AND registration_id=$3 AND instance_id=$4 AND revoked_at IS NULL
          AND ${presenceSql} AND (reachable_until IS NULL OR reachable_until<clock_timestamp()+interval '50 seconds')`,
      [user.id, binding.deviceId, binding.registrationId, binding.instanceId]);
      return presence(await this.verify(tx, user, binding));
    });
  }

  async macs(tx: Tx, userId: string, workspaceId: string, includeSync = false, includeWanted = false): Promise<ConnectedMac[]> {
    const { rows } = await tx.query<{ device_id: string; name: string; connected: boolean; active: boolean; reachable: boolean; expires_at: Date | null; syncing: boolean | null; sync_wanted: boolean | null }>(
      `WITH devices AS (SELECT d.device_id,d.name,coalesce(${connectionLive},false) AS connected,
        coalesce(${connectionLive} AND c.is_latest_sender,false) AS active,d.reachable_until,c.syncing,
        (c.registration_id=d.registration_id AND c.disconnected_at IS NULL AND c.sync_wanted) AS sync_wanted,
        CASE WHEN ${connectionLive} AND NOT c.is_latest_sender THEN greatest(c.connected_at,c.last_used_at)+interval '12 hours' END AS expires_at
        FROM local_command_devices d JOIN auth_sessions s ON s.provider='workos' AND s.provider_session_id=d.provider_session_id AND s.user_id=d.user_id
        LEFT JOIN cloud_v2_connected_macs c ON c.user_id=d.user_id AND c.device_id=d.device_id AND c.workspace_id=$2
        WHERE d.user_id=$1 AND d.revoked_at IS NULL AND s.status='active' AND s.revoked_at IS NULL
          AND (s.provider_session_expires_at IS NULL OR s.provider_session_expires_at>clock_timestamp()))
       SELECT *,coalesce(connected AND reachable_until>clock_timestamp(),false) AS reachable FROM devices ORDER BY active DESC,name,device_id LIMIT 20`, [userId, workspaceId]);
    return rows.map(row => ({ deviceId: row.device_id, name: row.name, connected: row.connected, active: row.active,
      reachable: row.reachable, expiresAt: row.expires_at?.toISOString() ?? null,
      ...(includeSync ? { syncing: row.connected && row.syncing === true } : {}),
      ...(includeWanted ? { syncWanted: row.sync_wanted === true } : {}) }));
  }

  list(user: AuthedUser, workspaceId: string, includeSync = false, includeWanted = false) {
    return this.workspace(user, workspaceId, async tx => {
      await localUserAuthority(tx, user); await localWorkspace(tx, workspaceId, user.id);
      return { macs: await this.macs(tx, user.id, workspaceId, includeSync, includeWanted) };
    }, true);
  }

  connections(user: AuthedUser, binding: LocalDeviceBinding, cursor: string | null, includeSync = false): Promise<DeviceSyncConnectionsReply> {
    return withSystemTx(this.pool, async tx => {
      await this.verify(tx, user, binding);
      const { rows } = await tx.query<{ workspace_id: string; repository: string; number: number | null; name: string; sync_wanted: boolean; syncing: boolean; execution_mode: string }>(
        // One organization admission covers its workspaces in this read snapshot.
        `WITH live_organizations AS MATERIALIZED (
           SELECT w.org_id FROM (SELECT org_id,user_id AS creator_user_id FROM organization_members WHERE user_id=$1) w
           WHERE ${CLOUD_V2_CREATOR_ACCESS_SQL.text})
         SELECT w.id AS workspace_id,w.repository,w.number,w.name,c.sync_wanted,c.syncing,w.execution_mode
         FROM cloud_v2_connected_macs c JOIN local_command_devices d ON d.user_id=c.user_id AND d.device_id=c.device_id
         JOIN cloud_v2_workspaces w ON w.id=c.workspace_id JOIN live_organizations allowed ON allowed.org_id=w.org_id
         WHERE c.user_id=$1 AND c.device_id=$2 AND c.registration_id=$3
           AND d.registration_id=$3 AND d.instance_id=$4 AND d.provider_session_id=$5 AND d.revoked_at IS NULL
           AND ${connectionLive} AND (CASE WHEN w.creator_user_id=$1 THEN true
             ELSE w.execution_mode='active' AND ${CLOUD_V2_LIVE_ACCESS} END) AND w.state NOT IN ('deleting','deleted')
           AND ($6::uuid IS NULL OR c.workspace_id>$6) ORDER BY c.workspace_id LIMIT 201`,
      [user.id, binding.deviceId, binding.registrationId, binding.instanceId, user.authentication.sessionId, cursor]);
      const page = rows.slice(0, 200);
      const allowed = [];
      for (const row of page) {
        if (row.execution_mode === "active") {
          if (!this.execution) throw new HttpError(503, "cloud_sync_unavailable", "Sync discovery is temporarily unavailable");
          try { await this.execution.deps.authority.cached(tx, row.workspace_id, user.id); }
          catch (error) { if (error instanceof HttpError && [403,404].includes(error.status)) continue; throw error; }
        }
        allowed.push(row);
      }
      await this.verify(tx, user, binding);
      return { connections: allowed.map(row => ({ workspaceId: row.workspace_id, repository: row.repository, number: row.number,
        // Legacy workspace names can be 200 characters; this opt-in wire is bounded to 120.
        name: row.name.slice(0, 120), syncWanted: row.sync_wanted, ...(includeSync ? { syncing: row.syncing } : {}) })),
      nextCursor: rows.length > 200 ? page.at(-1)!.workspace_id : null };
    });
  }

  private async connectRow(tx: Tx, user: AuthedUser, workspaceId: string, binding: LocalDeviceBinding, appMessage: boolean) {
    await this.verify(tx, user, binding, true);
    if (appMessage) await tx.query(`UPDATE cloud_v2_connected_macs SET is_latest_sender=false
      WHERE workspace_id=$1 AND user_id=$2 AND device_id<>$3 AND is_latest_sender`, [workspaceId, user.id, binding.deviceId]);
    await tx.query(`INSERT INTO cloud_v2_connected_macs(workspace_id,user_id,device_id,registration_id,is_latest_sender)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,user_id,device_id) DO UPDATE SET registration_id=EXCLUDED.registration_id,
        syncing=CASE WHEN cloud_v2_connected_macs.registration_id=EXCLUDED.registration_id
          AND cloud_v2_connected_macs.disconnected_at IS NULL AND (cloud_v2_connected_macs.is_latest_sender
            OR greatest(cloud_v2_connected_macs.connected_at,cloud_v2_connected_macs.last_used_at)>clock_timestamp()-interval '12 hours')
          THEN cloud_v2_connected_macs.syncing ELSE false END,
        disconnected_at=NULL,connected_at=CASE WHEN $5 THEN cloud_v2_connected_macs.connected_at ELSE clock_timestamp() END,
        last_used_at=CASE WHEN $5 THEN clock_timestamp() ELSE cloud_v2_connected_macs.last_used_at END,
        is_latest_sender=$5 OR (cloud_v2_connected_macs.registration_id=EXCLUDED.registration_id AND cloud_v2_connected_macs.is_latest_sender)`,
    [workspaceId, user.id, binding.deviceId, binding.registrationId, appMessage]);
    await tx.query(`UPDATE local_command_devices SET reachable_until=clock_timestamp()+interval '65 seconds',updated_at=clock_timestamp()
      WHERE user_id=$1 AND device_id=$2`, [user.id, binding.deviceId]);
  }

  connect(user: AuthedUser, workspaceId: string, targetId: string, binding: LocalDeviceBinding, includeSync = false, includeWanted = false) {
    return this.workspace(user, workspaceId, async tx => {
      await localWorkspace(tx, workspaceId, user.id, true);
      if (targetId !== binding.deviceId) throw new HttpError(409, "device_mismatch", "Connect must be requested on that Mac");
      await this.connectRow(tx, user, workspaceId, binding, false);
      const mac = (await this.macs(tx, user.id, workspaceId, includeSync, includeWanted)).find(row => row.deviceId === targetId)!;
      return { mac, presence: presence(await this.verify(tx, user, binding)) };
    });
  }

  async connectMessage(tx: Tx, user: AuthedUser, workspaceId: string, binding: LocalDeviceBinding): Promise<void> {
    await this.connectRow(tx, user, workspaceId, binding, true);
  }

  disconnect(user: AuthedUser, workspaceId: string, targetId: string, binding: LocalDeviceBinding, includeSync = false, includeWanted = false) {
    return this.workspace(user, workspaceId, async tx => {
      await localWorkspace(tx, workspaceId, user.id, true);
      await this.verify(tx, user, binding);
      if (!(await tx.query("SELECT device_id FROM local_command_devices WHERE user_id=$1 AND device_id=$2 AND revoked_at IS NULL FOR UPDATE", [user.id, targetId])).rowCount) throw notFound();
      await this.verify(tx, user, binding);
      await tx.query("UPDATE cloud_v2_connected_macs SET disconnected_at=clock_timestamp(),syncing=false WHERE workspace_id=$1 AND user_id=$2 AND device_id=$3", [workspaceId, user.id, targetId]);
      await tx.query(`UPDATE local_command_requests SET phase='terminal',outcome='cancelled',terminal_at=clock_timestamp(),updated_at=clock_timestamp(),
        reserved_output_bytes=0,result_summary=jsonb_strip_nulls(jsonb_build_object('outcome','cancelled','mac',target_name))
        WHERE workspace_id=$1 AND sender_user_id=$2 AND target_device_id=$3 AND phase IN ('pending','claimed')`, [workspaceId, user.id, targetId]);
      return { mac: (await this.macs(tx, user.id, workspaceId, includeSync, includeWanted)).find(row => row.deviceId === targetId)! };
    });
  }

  setSync(user: AuthedUser, workspaceId: string, targetId: string, binding: LocalDeviceBinding, input: SyncFlags, includeWanted = false) {
    return this.workspace(user, workspaceId, async tx => {
      await localWorkspace(tx, workspaceId, user.id);
      const caller = await this.verify(tx, user, binding);
      if (input.syncing !== undefined && targetId !== binding.deviceId) throw new HttpError(409, "device_mismatch", "Sync must be requested on that Mac");
      const target = targetId === binding.deviceId ? caller : (await tx.query<{ registration_id: string }>(
        "SELECT registration_id FROM local_command_devices WHERE user_id=$1 AND device_id=$2 AND revoked_at IS NULL", [user.id, targetId])).rows[0];
      if (!target) throw notFound();
      await tx.query("SELECT workspace_id FROM cloud_v2_connected_macs WHERE workspace_id=$1 AND user_id=$2 AND device_id=$3 FOR UPDATE", [workspaceId, user.id, targetId]);
      await localWorkspace(tx, workspaceId, user.id);
      await this.verify(tx, user, binding);
      if (!(await tx.query("SELECT device_id FROM local_command_devices WHERE user_id=$1 AND device_id=$2 AND registration_id=$3 AND revoked_at IS NULL",
        [user.id, targetId, target.registration_id])).rowCount) throw changed();
      const current = (await this.macs(tx, user.id, workspaceId, true, includeWanted)).find(row => row.deviceId === targetId);
      if (!current) throw notFound();
      if ((input.syncing || input.wanted !== undefined) && !current.connected) throw new HttpError(403, "mac_not_connected", "Connect this Mac to the workspace before syncing");
      // The connection lock fences its fields, but membership and an unconnected caller can change during the reads.
      const admission = await tx.query<{ live: boolean }>(`WITH authority AS MATERIALIZED (
        SELECT ${SECURITY_STREAM_AUTHORITY}
          AND EXISTS (SELECT 1 FROM cloud_v2_workspaces w WHERE w.id=$7 AND ${cloudV2ActorAccess("$1")}
            AND w.state NOT IN ('deleting','deleted') AND ${CLOUD_V2_LIVE_ACCESS})
          AND EXISTS (SELECT 1 FROM local_command_devices d WHERE d.user_id=$1 AND d.device_id=$9 AND d.registration_id=$10
            AND d.instance_id=$11 AND d.provider_session_id=$5 AND d.revoked_at IS NULL)
          AND EXISTS (SELECT 1 FROM local_command_devices d
            JOIN auth_sessions s ON s.provider='workos' AND s.provider_session_id=d.provider_session_id AND s.user_id=d.user_id
            LEFT JOIN cloud_v2_connected_macs c ON c.user_id=d.user_id AND c.device_id=d.device_id AND c.workspace_id=$7
            WHERE d.user_id=$1 AND d.device_id=$8 AND d.registration_id=$12 AND d.revoked_at IS NULL
              AND s.status='active' AND s.revoked_at IS NULL AND (s.provider_session_expires_at IS NULL OR s.provider_session_expires_at>clock_timestamp())
              AND (($13::boolean IS NOT TRUE AND $14::boolean IS NULL) OR ${connectionLive})) AS live
        ), changed AS (UPDATE cloud_v2_connected_macs SET syncing=coalesce($13::boolean,syncing),sync_wanted=coalesce($14::boolean,sync_wanted)
          WHERE workspace_id=$7 AND user_id=$1 AND device_id=$8 AND (SELECT live FROM authority)
            AND (($13::boolean IS NOT NULL AND syncing IS DISTINCT FROM $13) OR ($14::boolean IS NOT NULL AND sync_wanted IS DISTINCT FROM $14))
          RETURNING 1)
        SELECT live FROM authority`,
      [...securityStreamParameters(user), workspaceId, targetId, binding.deviceId, binding.registrationId, binding.instanceId,
        target.registration_id, input.syncing ?? null, input.wanted ?? null]);
      if (!admission.rows[0]?.live) {
        await localWorkspace(tx, workspaceId, user.id); await this.verify(tx, user, binding);
        const latest = (await this.macs(tx, user.id, workspaceId)).find(row => row.deviceId === targetId);
        if (!latest) throw notFound();
        if (!latest.connected) throw new HttpError(403, "mac_not_connected", "Connect this Mac to the workspace before syncing");
        throw changed();
      }
      return { mac: { ...current, ...(input.syncing === undefined ? {} : { syncing: input.syncing }),
        ...(includeWanted && input.wanted !== undefined ? { syncWanted: input.wanted } : {}) } };
    });
  }
}

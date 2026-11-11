import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import type { AuthedUser } from "../../auth.js";
import { HttpError } from "../../authz.js";
import { withSystemTx, type Tx } from "../../db.js";
import { securityStreamAuthority } from "../../security-events.js";
import { CLOUD_V2_LIVE_ACCESS } from "../workspace-access.js";
import { LOCAL_COMMANDS_FEATURE, type ConnectedMac, type LocalDevice, type LocalDeviceBinding, type LocalDevicePresence, type LocalDeviceRegistration } from "./contract.js";

export const DEVICE_HEARTBEAT_MS = 25_000;
export const DEVICE_LEASE_MS = 65_000;
export const notFound = () => new HttpError(404, "not_found", "Local command resource not found");
const changed = () => new HttpError(409, "device_registration_changed", "This desktop registration is no longer current");
export const limited = () => new HttpError(429, "local_commands_limited", "Local command capacity is temporarily full");
export type DeviceRow = { user_id: string; device_id: string; provider_session_id: string; registration_id: string; instance_id: string;
  registration_request_id: string; registration_hash: Buffer; name: string; revoked_at: Date | null; reachable_until: Date | null;
  presence_required: boolean; has_requests: boolean; checked_at: Date };
const connectionLive = `(c.disconnected_at IS NULL AND c.registration_id=d.registration_id
  AND (c.is_latest_sender OR greatest(c.connected_at,c.last_used_at)>clock_timestamp()-interval '12 hours'))`;
const presenceSql = `EXISTS (SELECT 1 FROM cloud_v2_connected_macs c JOIN cloud_v2_workspaces w ON w.id=c.workspace_id
  WHERE c.user_id=d.user_id AND c.device_id=d.device_id AND ${connectionLive} AND w.state NOT IN ('deleting','deleted')
    AND ${CLOUD_V2_LIVE_ACCESS} AND EXISTS (SELECT 1 FROM organization_members m WHERE m.org_id=w.org_id AND m.user_id=d.user_id))`;
const device = (row: DeviceRow): LocalDevice => ({ deviceId: row.device_id, registrationId: row.registration_id, instanceId: row.instance_id,
  name: row.name, capabilities: [LOCAL_COMMANDS_FEATURE] });
const presence = (row: DeviceRow): LocalDevicePresence => ({ presenceRequired: row.presence_required,
  reachableUntil: row.presence_required ? row.reachable_until?.toISOString() ?? null : null });

export async function localUserAuthority(tx: Tx, user: AuthedUser, desktop = false): Promise<void> {
  if (desktop && (user.authentication?.clientKind !== "desktop" || !user.authentication.sessionId))
    throw new HttpError(401, "unauthorized", "A signed-in desktop session is required");
  if (!await securityStreamAuthority(tx, user)) throw new HttpError(401, "session_revoked", "Authentication is no longer current");
}

export async function localWorkspace(tx: Tx, workspaceId: string, userId: string, lock = false): Promise<void> {
  const row = await tx.query(`SELECT id FROM cloud_v2_workspaces w WHERE id=$1 AND creator_user_id=$2
    AND state NOT IN ('deleting','deleted') AND ${CLOUD_V2_LIVE_ACCESS} ${lock ? "FOR UPDATE OF w" : ""}`, [workspaceId, userId]);
  if (!row.rowCount) throw notFound();
  if (lock && !(await tx.query(`SELECT id FROM cloud_v2_workspaces w WHERE id=$1 AND ${CLOUD_V2_LIVE_ACCESS}`, [workspaceId])).rowCount) throw notFound();
}

/** Device identity is account/session authority. Connection expiry is a
 * separate fact: a channel heartbeat cannot make a workspace connection live. */
export class CloudLocalDevices {
  constructor(readonly pool: pg.Pool) {}

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

  register(user: AuthedUser, deviceId: string, input: LocalDeviceRegistration) {
    return withSystemTx(this.pool, async tx => {
      await localUserAuthority(tx, user, true);
      // The account row orders concurrent new installs against the device cap.
      await tx.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [user.id]);
      const old = (await tx.query<DeviceRow>("SELECT * FROM local_command_devices WHERE user_id=$1 AND device_id=$2 FOR UPDATE", [user.id, deviceId])).rows[0];
      await localUserAuthority(tx, user, true);
      const hash = createHash("sha256").update(JSON.stringify([input.name, input.capabilities])).digest();
      if (old?.registration_request_id === input.requestId) {
        if (old.revoked_at || old.provider_session_id !== user.authentication.sessionId) throw changed();
        if (!old.registration_hash.equals(hash)) throw new HttpError(409, "device_registration_conflict", "This registration request was already used");
      } else {
        if (Number((await tx.query(`SELECT count(*) FROM local_command_devices d
          JOIN auth_sessions s ON s.provider='workos' AND s.provider_session_id=d.provider_session_id AND s.user_id=d.user_id
          WHERE d.user_id=$1 AND d.device_id<>$2 AND d.revoked_at IS NULL AND s.status='active' AND s.revoked_at IS NULL
            AND (s.provider_session_expires_at IS NULL OR s.provider_session_expires_at>clock_timestamp())
            AND EXISTS (SELECT 1 FROM user_identities i WHERE i.user_id=d.user_id AND i.provider='workos' AND i.provider_sub=s.provider_sub AND i.status='active')`, [user.id, deviceId])).rows[0].count) >= 20) throw limited();
        const registrationId = old && !old.revoked_at && old.provider_session_id === user.authentication.sessionId ? old.registration_id : randomUUID();
        await tx.query(`INSERT INTO local_command_devices(user_id,device_id,provider_session_id,registration_id,instance_id,registration_request_id,registration_hash,name)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(user_id,device_id) DO UPDATE SET provider_session_id=EXCLUDED.provider_session_id,
            registration_id=EXCLUDED.registration_id,instance_id=EXCLUDED.instance_id,registration_request_id=EXCLUDED.registration_request_id,
            registration_hash=EXCLUDED.registration_hash,name=EXCLUDED.name,revoked_at=NULL,reachable_until=NULL,updated_at=clock_timestamp()`,
        [user.id, deviceId, user.authentication.sessionId, registrationId, randomUUID(), input.requestId, hash, input.name]);
      }
      const row = (await tx.query<DeviceRow>(`SELECT d.*,${presenceSql} AS presence_required FROM local_command_devices d WHERE user_id=$1 AND device_id=$2`, [user.id, deviceId])).rows[0]!;
      return { device: device(row), presence: presence(row), heartbeatIntervalMs: DEVICE_HEARTBEAT_MS };
    });
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

  async macs(tx: Tx, userId: string, workspaceId: string): Promise<ConnectedMac[]> {
    const { rows } = await tx.query<{ device_id: string; name: string; connected: boolean; active: boolean; reachable: boolean; expires_at: Date | null }>(
      `WITH devices AS (SELECT d.device_id,d.name,coalesce(${connectionLive},false) AS connected,
        coalesce(${connectionLive} AND c.is_latest_sender,false) AS active,d.reachable_until,
        CASE WHEN ${connectionLive} AND NOT c.is_latest_sender THEN greatest(c.connected_at,c.last_used_at)+interval '12 hours' END AS expires_at
        FROM local_command_devices d JOIN auth_sessions s ON s.provider='workos' AND s.provider_session_id=d.provider_session_id AND s.user_id=d.user_id
        LEFT JOIN cloud_v2_connected_macs c ON c.user_id=d.user_id AND c.device_id=d.device_id AND c.workspace_id=$2
        WHERE d.user_id=$1 AND d.revoked_at IS NULL AND s.status='active' AND s.revoked_at IS NULL
          AND (s.provider_session_expires_at IS NULL OR s.provider_session_expires_at>clock_timestamp()))
       SELECT *,coalesce(connected AND reachable_until>clock_timestamp(),false) AS reachable FROM devices ORDER BY active DESC,name,device_id LIMIT 20`, [userId, workspaceId]);
    return rows.map(row => ({ deviceId: row.device_id, name: row.name, connected: row.connected, active: row.active,
      reachable: row.reachable, expiresAt: row.expires_at?.toISOString() ?? null }));
  }

  list(user: AuthedUser, workspaceId: string) {
    return withSystemTx(this.pool, async tx => {
      await localUserAuthority(tx, user); await localWorkspace(tx, workspaceId, user.id);
      return { macs: await this.macs(tx, user.id, workspaceId) };
    }, { consistentRead: true });
  }

  private async connectRow(tx: Tx, user: AuthedUser, workspaceId: string, binding: LocalDeviceBinding, appMessage: boolean) {
    await this.verify(tx, user, binding, true);
    if (appMessage) await tx.query(`UPDATE cloud_v2_connected_macs SET is_latest_sender=false
      WHERE workspace_id=$1 AND user_id=$2 AND device_id<>$3 AND is_latest_sender`, [workspaceId, user.id, binding.deviceId]);
    await tx.query(`INSERT INTO cloud_v2_connected_macs(workspace_id,user_id,device_id,registration_id,is_latest_sender)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,user_id,device_id) DO UPDATE SET registration_id=EXCLUDED.registration_id,
        disconnected_at=NULL,connected_at=CASE WHEN $5 THEN cloud_v2_connected_macs.connected_at ELSE clock_timestamp() END,
        last_used_at=CASE WHEN $5 THEN clock_timestamp() ELSE cloud_v2_connected_macs.last_used_at END,
        is_latest_sender=$5 OR (cloud_v2_connected_macs.registration_id=EXCLUDED.registration_id AND cloud_v2_connected_macs.is_latest_sender)`,
    [workspaceId, user.id, binding.deviceId, binding.registrationId, appMessage]);
    await tx.query(`UPDATE local_command_devices SET reachable_until=clock_timestamp()+interval '65 seconds',updated_at=clock_timestamp()
      WHERE user_id=$1 AND device_id=$2`, [user.id, binding.deviceId]);
  }

  connect(user: AuthedUser, workspaceId: string, targetId: string, binding: LocalDeviceBinding) {
    return withSystemTx(this.pool, async tx => {
      await localWorkspace(tx, workspaceId, user.id, true);
      if (targetId !== binding.deviceId) throw new HttpError(409, "device_mismatch", "Connect must be requested on that Mac");
      await this.connectRow(tx, user, workspaceId, binding, false);
      const mac = (await this.macs(tx, user.id, workspaceId)).find(row => row.deviceId === targetId)!;
      return { mac, presence: presence(await this.verify(tx, user, binding)) };
    });
  }

  async connectMessage(tx: Tx, user: AuthedUser, workspaceId: string, binding: LocalDeviceBinding): Promise<void> {
    await this.connectRow(tx, user, workspaceId, binding, true);
  }

  disconnect(user: AuthedUser, workspaceId: string, targetId: string, binding: LocalDeviceBinding) {
    return withSystemTx(this.pool, async tx => {
      await localWorkspace(tx, workspaceId, user.id, true);
      await this.verify(tx, user, binding);
      if (!(await tx.query("SELECT device_id FROM local_command_devices WHERE user_id=$1 AND device_id=$2 AND revoked_at IS NULL FOR UPDATE", [user.id, targetId])).rowCount) throw notFound();
      await this.verify(tx, user, binding);
      await tx.query("UPDATE cloud_v2_connected_macs SET disconnected_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2 AND device_id=$3", [workspaceId, user.id, targetId]);
      await tx.query(`UPDATE local_command_requests SET phase='terminal',outcome='cancelled',terminal_at=clock_timestamp(),updated_at=clock_timestamp(),
        reserved_output_bytes=0,result_summary=jsonb_strip_nulls(jsonb_build_object('outcome','cancelled','mac',target_name))
        WHERE workspace_id=$1 AND sender_user_id=$2 AND target_device_id=$3 AND phase IN ('pending','claimed')`, [workspaceId, user.id, targetId]);
      return { mac: (await this.macs(tx, user.id, workspaceId)).find(row => row.deviceId === targetId)! };
    });
  }
}

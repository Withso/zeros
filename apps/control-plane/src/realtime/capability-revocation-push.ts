import type pg from "pg";

import { withSystemTx } from "../db.js";
import type { RolloutFlagReader } from "../rollout-flags.js";
import type { CapabilityRevokedScope } from "./device-stream-protocol.js";
import type { RealtimeSecurityEvent, RealtimeSecurityEventFeed, SecurityEventGapReason } from "./security-event-feed.js";
import { UPLINK_AUTH_REVOCATION_RETENTION_MS, type UplinkAuthSource } from "./uplink-auth-source.js";
import type { UplinkIdentity } from "./uplink-authority.js";
import type { UplinkAuthDelta } from "./uplink-protocol.js";

/**
 * The S1 revocation producer on `realtime`. It consumes the process's
 * security-event feed, maps each event to the workspaces whose uplinks this
 * process owns, re-reads each workspace's current epochs and revocations
 * (never values from the event) and pushes them as `auth.epochs`; the uplink
 * server records `capability_revocation_push_ms` at the engine's
 * `auth.applied` from the event's `created_at`. Epoch-bump events (0155)
 * also send `capability.revoked` to device streams. The device stream
 * already re-checks access for the account, session, organization and
 * workspace authorization kinds itself, so those never reach it from here.
 */

export const CAPABILITY_EPOCH_EVENT_KIND = "capability.epochs_changed";

/** A pass whose reads failed is retried as a full re-read of every owned
 * uplink, doubling the delay while it keeps failing. */
export const CAPABILITY_REVOCATION_RETRY_MIN_MS = 1_000;
export const CAPABILITY_REVOCATION_RETRY_MAX_MS = 30_000;

/** Kinds that can change an epoch or a revocation an engine verifies. */
const UPLINK_KINDS: ReadonlySet<string> = new Set([
  CAPABILITY_EPOCH_EVENT_KIND, "account.revoked", "account.authorization_changed", "session.revoked",
  "organization.access_revoked", "organization.authorization_changed", "workspace.authorization_changed",
]);

export type CapabilityEpochKey = "me" | "ac" | "dk" | "wa" | "wr";

export type CapabilityEventDetail = Readonly<{
  createdAtMs: number;
  epoch?: CapabilityEpochKey;
  workspaceId?: string;
}>;

export type CapabilityUserTarget = Readonly<{ userId: string; organizationId: string | null }>;

/** Durable reads behind the producer, injectable for tests. */
export interface CapabilityRevocationSource {
  /** `created_at` and the 0155 routing payload for delivered events. */
  details(sequences: readonly number[]): Promise<ReadonlyMap<number, CapabilityEventDetail>>;
  /** For each target, the workspaces of `workspaceIds` (in the target's
   * organization when it names one) the user has or lost within the
   * revocation retention window: the S1 snapshot scope. */
  workspacesForUsers(targets: readonly CapabilityUserTarget[], workspaceIds: readonly string[]):
    Promise<Array<{ userId: string; organizationId: string | null; workspaceId: string }>>;
}

export interface RevocationUplinks {
  ownedEngineInstances(): string[];
  session(engineInstanceId: string): { readonly identity: UplinkIdentity } | null;
  pushAuthEpochs(workspaceId: string, delta: UplinkAuthDelta, createdAtMs: number): void;
}

export interface RevocationDeviceStreams {
  revokeCapabilities(target: { accountUserId?: string; workspaceId?: string; organizationId?: string },
    scope: CapabilityRevokedScope, reason: string): void;
}

export type CapabilityRevocationPushOptions = {
  feed: Pick<RealtimeSecurityEventFeed, "subscribe">;
  source: CapabilityRevocationSource;
  flags: RolloutFlagReader;
  /** The mounted uplink server and its snapshot source, when mounted. */
  uplink: () => { server: RevocationUplinks; auth: Pick<UplinkAuthSource, "snapshot"> } | null | undefined;
  deviceStreams: () => RevocationDeviceStreams | null | undefined;
  now?: () => number;
  logger?: Pick<Console, "warn">;
  /** Snapshot reads in flight at once. */
  concurrency?: number;
};

type Pending = { events: RealtimeSecurityEvent[]; resync: boolean };

export class CapabilityRevocationPush {
  private pending: Pending = { events: [], resync: false };
  private running: Promise<void> | null = null;
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelayMs = CAPABILITY_REVOCATION_RETRY_MIN_MS;
  private readonly unsubscribe: () => void;
  private readonly now: () => number;
  private readonly logger: Pick<Console, "warn">;
  readonly counters = { pushes: 0, snapshotFailures: 0, readFailures: 0, deviceRevocations: 0 };

  constructor(private readonly options: CapabilityRevocationPushOptions) {
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? console;
    this.unsubscribe = options.feed.subscribe({
      events: batch => this.events(batch),
      gap: reason => this.gap(reason),
    });
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** Resolves once queued work has been pushed. */
  async settled(): Promise<void> {
    while (this.running) await this.running;
  }

  private events(batch: readonly RealtimeSecurityEvent[]): void {
    const relevant = batch.filter(event => UPLINK_KINDS.has(event.kind));
    if (!relevant.length || this.stopped) return;
    this.pending.events.push(...relevant);
    this.schedule();
  }

  /** Events in between may be lost: every owned uplink gets a fresh push.
   * The device stream repairs its own state on the same gap. */
  private gap(_reason: SecurityEventGapReason): void {
    if (this.stopped) return;
    this.pending.resync = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.running) return;
    this.running = (async () => {
      while (!this.stopped && (this.pending.events.length || this.pending.resync)) {
        const work = this.pending;
        this.pending = { events: [], resync: false };
        let clean = false;
        try { clean = await this.process(work); }
        catch { this.counters.readFailures += 1; this.logger.warn("[realtime] capability revocation push failed"); }
        if (clean) this.retryDelayMs = CAPABILITY_REVOCATION_RETRY_MIN_MS;
        else this.retryLater();
      }
    })().finally(() => { this.running = null; });
  }

  /** The failed pass may have lost events: re-read every owned uplink. */
  private retryLater(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(CAPABILITY_REVOCATION_RETRY_MAX_MS, delay * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.stopped) return;
      this.pending.resync = true;
      this.schedule();
    }, delay);
    this.retryTimer.unref?.();
  }

  private async process(work: Pending): Promise<boolean> {
    if (!this.options.flags.anyEnabled("capabilities")) return true;
    const { flags } = this.options;
    const capabilityEvents = work.events.filter(event => event.kind === CAPABILITY_EPOCH_EVENT_KIND);
    const details = work.events.length
      ? await this.options.source.details(work.events.map(event => event.sequence))
      : new Map<number, CapabilityEventDetail>();
    this.revokeDeviceCapabilities(capabilityEvents, details);

    const uplink = this.options.uplink();
    if (!uplink) return true;
    const owned = new Map<string, UplinkIdentity>();
    for (const engineInstanceId of uplink.server.ownedEngineInstances()) {
      const identity = uplink.server.session(engineInstanceId)?.identity;
      if (identity && flags.enabled(identity.organizationId, "capabilities")) owned.set(identity.workspaceId, identity);
    }
    if (!owned.size) return true;

    // Workspace -> earliest event time it has to answer for.
    const due = new Map<string, number>();
    const mark = (workspaceId: string, at: number) => {
      if (owned.has(workspaceId)) due.set(workspaceId, Math.min(due.get(workspaceId) ?? Number.POSITIVE_INFINITY, at));
    };
    if (work.resync) for (const workspaceId of owned.keys()) mark(workspaceId, this.now());
    const byUser = new Map<string, { userId: string; organizationId: string | null; at: number }>();
    for (const event of work.events) {
      const detail = details.get(event.sequence);
      const at = detail?.createdAtMs ?? this.now();
      const workspaceId = event.workspaceId ?? detail?.workspaceId;
      if (workspaceId) mark(workspaceId, at);
      else if (event.userId) {
        const key = `${event.userId}\n${event.organizationId ?? ""}`;
        const entry = byUser.get(key);
        if (!entry) byUser.set(key, { userId: event.userId, organizationId: event.organizationId, at });
        else entry.at = Math.min(entry.at, at);
      } else if (event.organizationId) {
        for (const [id, identity] of owned) if (identity.organizationId === event.organizationId) mark(id, at);
      } else {
        // A session revocation without an account names no workspace.
        for (const id of owned.keys()) mark(id, at);
      }
    }
    if (byUser.size) {
      const targets = [...byUser.values()].map(({ userId, organizationId }) => ({ userId, organizationId }));
      for (const row of await this.options.source.workspacesForUsers(targets, [...owned.keys()])) {
        const entry = byUser.get(`${row.userId}\n${row.organizationId ?? ""}`);
        if (entry) mark(row.workspaceId, entry.at);
      }
    }
    return (await this.pushAll(uplink, owned, due)) === 0;
  }

  private async pushAll(uplink: NonNullable<ReturnType<CapabilityRevocationPushOptions["uplink"]>>,
    owned: ReadonlyMap<string, UplinkIdentity>, due: ReadonlyMap<string, number>): Promise<number> {
    const queue = [...due];
    let failures = 0;
    const worker = async () => {
      for (let next = queue.shift(); next && !this.stopped; next = queue.shift()) {
        const [workspaceId, createdAtMs] = next;
        try {
          const snapshot = await uplink.auth.snapshot(owned.get(workspaceId)!, undefined);
          if (this.stopped) return;
          // Routed by workspace at send time, so an engine that reconnected
          // during the read gets it too (held until its own auth.applied).
          uplink.server.pushAuthEpochs(workspaceId,
            { epochs: snapshot.epochs, revocations: snapshot.revocations, authCursor: snapshot.authCursor }, createdAtMs);
          this.counters.pushes += 1;
        } catch {
          // The workspace's next auth.sync (reconnect) carries the same state.
          this.counters.snapshotFailures += 1;
          failures += 1;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.options.concurrency ?? 8, queue.length) }, worker));
    return failures;
  }

  private revokeDeviceCapabilities(events: readonly RealtimeSecurityEvent[], details: ReadonlyMap<number, CapabilityEventDetail>): void {
    const streams = this.options.deviceStreams();
    if (!streams || !events.length) return;
    const { flags } = this.options;
    const sent = new Set<string>();
    const revoke = (target: { accountUserId?: string; workspaceId?: string; organizationId?: string },
      scope: CapabilityRevokedScope, reason: string) => {
      const key = JSON.stringify([target.accountUserId, target.workspaceId, target.organizationId, scope, reason]);
      if (sent.has(key)) return;
      sent.add(key);
      streams.revokeCapabilities(target, scope, reason);
      this.counters.deviceRevocations += 1;
    };
    for (const event of events) {
      const detail = details.get(event.sequence);
      const organizationId = event.organizationId;
      if (organizationId ? !flags.enabled(organizationId, "capabilities") : !flags.anyEnabled("capabilities")) continue;
      switch (detail?.epoch) {
        case "me":
          if (event.userId && organizationId) revoke({ accountUserId: event.userId, organizationId }, "organization", "membership_changed");
          break;
        case "ac":
          if (event.userId) revoke({ accountUserId: event.userId }, "account", "account_changed");
          break;
        case "dk":
          // The target names no device, so every device session of the
          // account renews; only the rotated or revoked key fails to.
          if (event.userId) revoke({ accountUserId: event.userId }, "device", "device_key_changed");
          break;
        case "wa":
          if (detail.workspaceId) revoke({ workspaceId: detail.workspaceId }, "workspace", "workspace_authority_changed");
          break;
        case "wr":
          if (detail.workspaceId) revoke({ workspaceId: detail.workspaceId }, "workspace", "workspace_access_changed");
          break;
        default:
          break;
      }
    }
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EPOCHS: ReadonlySet<string> = new Set(["me", "ac", "dk", "wa", "wr"]);
export const CAPABILITY_USER_TARGETS_PER_READ = 500;

export class DatabaseCapabilityRevocationSource implements CapabilityRevocationSource {
  constructor(private readonly pool: pg.Pool) {}

  async details(sequences: readonly number[]): Promise<ReadonlyMap<number, CapabilityEventDetail>> {
    if (!sequences.length) return new Map();
    const rows = await withSystemTx(this.pool, async tx => (await tx.query<{
      sequence: string; created_ms: string; epoch: string | null; workspace_id: string | null;
    }>(`SELECT delivery_sequence AS sequence, floor(extract(epoch FROM created_at) * 1000)::bigint AS created_ms,
        CASE WHEN kind::text = 'capability.epochs_changed' THEN payload->>'epoch' END AS epoch,
        CASE WHEN kind::text = 'capability.epochs_changed' THEN payload->>'workspaceId' END AS workspace_id
      FROM security_events WHERE delivery_sequence = ANY($1::bigint[])`, [sequences])).rows);
    return new Map(rows.map(row => [Number(row.sequence), {
      createdAtMs: Number(row.created_ms),
      ...(row.epoch && EPOCHS.has(row.epoch) ? { epoch: row.epoch as CapabilityEpochKey } : {}),
      ...(row.workspace_id && UUID.test(row.workspace_id) ? { workspaceId: row.workspace_id.toLowerCase() } : {}),
    }]));
  }

  async workspacesForUsers(targets: readonly CapabilityUserTarget[], workspaceIds: readonly string[]):
    Promise<Array<{ userId: string; organizationId: string | null; workspaceId: string }>> {
    if (!targets.length || !workspaceIds.length) return [];
    const rows: Array<{ user_id: string; org_id: string | null; workspace_id: string }> = [];
    for (let start = 0; start < targets.length; start += CAPABILITY_USER_TARGETS_PER_READ) {
      const chunk = targets.slice(start, start + CAPABILITY_USER_TARGETS_PER_READ);
      rows.push(...await withSystemTx(this.pool, async tx => (await tx.query<{ user_id: string; org_id: string | null; workspace_id: string }>(`SELECT target.user_id::text AS user_id, target.org_id::text AS org_id, workspace.id::text AS workspace_id
        FROM unnest($1::uuid[], $2::uuid[]) AS target(user_id, org_id)
        JOIN cloud_workspaces workspace ON workspace.id = ANY($3::uuid[])
          AND (target.org_id IS NULL OR workspace.org_id = target.org_id)
        WHERE EXISTS (SELECT 1 FROM cloud_workspace_members member WHERE member.workspace_id = workspace.id AND member.user_id = target.user_id)
          OR EXISTS (SELECT 1 FROM cloud_workspace_guest_grants grant_row WHERE grant_row.workspace_id = workspace.id AND grant_row.user_id = target.user_id)
          OR (workspace.sharing_mode = 'organization' AND EXISTS (SELECT 1 FROM organization_members member
            WHERE member.org_id = workspace.org_id AND member.user_id = target.user_id))
          OR EXISTS (SELECT 1 FROM cloud_capability_access_losses loss WHERE loss.workspace_id = workspace.id AND loss.user_id = target.user_id
            AND loss.lost_at > clock_timestamp() - make_interval(secs => $4::double precision / 1000))`,
      [chunk.map(target => target.userId), chunk.map(target => target.organizationId), workspaceIds, UPLINK_AUTH_REVOCATION_RETENTION_MS])).rows));
    }
    return rows.map(row => ({ userId: row.user_id, organizationId: row.org_id, workspaceId: row.workspace_id }));
  }
}

import type pg from "pg";
import { z } from "zod";

import { withSystemStatement } from "../db.js";
import { SqlFragment, sql } from "../sql-fragment.js";
import type { UplinkIdentity } from "./uplink-authority.js";
import { UplinkCodeSchema } from "./uplink-protocol.js";
import type { UplinkExtension, UplinkSession } from "./uplink-server.js";

/** The negotiated feature for credential-control push (S2 cred channel). */
export const UPLINK_CRED_FEATURE = "cred.v1";

const CredAckSchema = z.object({
  kind: z.enum(["agent-controls", "repository"]),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  result: z.enum(["applied", "failed"]),
  code: UplinkCodeSchema.optional(),
}).strict();
export type UplinkCredAck = z.infer<typeof CredAckSchema>;

/** Reads `cloud_agent_boot_bindings.desired_cache_revision`. The table is
 * FORCE ROW LEVEL SECURITY with system-only policies, so every read must go
 * through `withSystemStatement`; a raw pool query (the runtime role without
 * `app.system`) silently sees no row. */
export class DatabaseUplinkCredentialStore {
  constructor(private readonly pool: pg.Pool) {}

  /** Current desired agent-controls revision of the engine's live binding,
   * or null when none is live. */
  async desiredRevision(engineInstanceId: string): Promise<number | null> {
    return (await this.desiredRevisions([engineInstanceId])).get(engineInstanceId) ?? null;
  }

  /** Desired revisions of many engines' live bindings (engines without one
   * are absent), one system statement per chunk of ids. */
  async desiredRevisions(engineInstanceIds: readonly string[]): Promise<Map<string, number>> {
    const ids = [...new Set(engineInstanceIds)];
    const revisions = new Map<string, number>();
    for (let start = 0; start < ids.length; start += DESIRED_REVISION_CHUNK) {
      const chunk = SqlFragment.list(ids.slice(start, start + DESIRED_REVISION_CHUNK).map(id => SqlFragment.uuid(id)));
      const result = await withSystemStatement<{ engine_instance_id: string; desired_cache_revision: string }>(this.pool,
        sql`SELECT engine_instance_id, desired_cache_revision FROM cloud_agent_boot_bindings WHERE engine_instance_id IN (${chunk}) AND retired_at IS NULL`);
      for (const row of result.rows) {
        const revision = Number(row.desired_cache_revision);
        if (Number.isSafeInteger(revision) && revision >= 1) revisions.set(row.engine_instance_id, revision);
      }
    }
    return revisions;
  }
}

/** Bounds the simple-protocol statement text (one uuid literal is ~45 bytes). */
const DESIRED_REVISION_CHUNK = 1_000;

/** Credential-control push (S2: `cred.revision` / `cred.ack`, replacing the
 * engine's 500 ms credential-control poll while the uplink is up). On the
 * gate the extension pushes the binding's current desired revision (the
 * contract's resync rule), and the notification listener calls
 * `revisionChanged` whenever any mutation path bumps it. `cred.ack` is the
 * engine's applied/failed report after its exchange with `api`; the frames
 * are reliable, so the exchange itself needs no CP-side retry state. */
export class UplinkCredentialPush implements UplinkExtension {
  readonly feature = UPLINK_CRED_FEATURE;
  private readonly sessionFor: (engineInstanceId: string) => UplinkSession | null;
  private readonly readRevision: (identity: UplinkIdentity) => Promise<number | null>;
  private readonly readRevisions: ((engineInstanceIds: readonly string[]) => Promise<ReadonlyMap<string, number>>) | undefined;
  private readonly onAck: ((session: UplinkSession, ack: UplinkCredAck) => void) | undefined;

  constructor(options: {
    sessionFor: (engineInstanceId: string) => UplinkSession | null;
    readRevision: (identity: UplinkIdentity) => Promise<number | null>;
    /** Batch read for `resync`; without it `resync` is a no-op. */
    readRevisions?: (engineInstanceIds: readonly string[]) => Promise<ReadonlyMap<string, number>>;
    onAck?: (session: UplinkSession, ack: UplinkCredAck) => void;
  }) {
    this.sessionFor = options.sessionFor;
    this.readRevision = options.readRevision;
    this.readRevisions = options.readRevisions;
    this.onAck = options.onAck;
  }

  /** The gate opened (handshake step 4 done, retransmit sent): push the
   * current revision, on a fresh lineage and on a resume alike — the engine
   * dedupes by revision, so a resume re-push is one idempotent frame. */
  onOpen(session: UplinkSession, _resumed: boolean): void {
    void this.readRevision(session.identity).then(revision => {
      if (revision !== null)
        session.sendReliable("cred.revision", { kind: "agent-controls", revision });
    }).catch(() => { /* the engine's fallback poll converges */ });
  }

  /** A committed mutation bumped the binding's desired revision. Only an
   * uplink that negotiated cred.v1 is pushed; the payload is a hint, and
   * the engine's exchange re-reads authority, so a stale or foreign
   * notification costs one harmless exchange at most. */
  revisionChanged(engineInstanceId: string, revision: number): void {
    const session = this.sessionFor(engineInstanceId);
    if (!session || !session.features.has(UPLINK_CRED_FEATURE)) return;
    session.sendReliable("cred.revision", { kind: "agent-controls", revision });
  }

  /** The notification listener (re)connected: a bump committed while it
   * was down never notified, and an engine whose gate is already open never
   * re-gates. Push the current revision of every given engine that
   * negotiated cred.v1, read in one batch; the engine acks a revision it
   * already applied without running an exchange. */
  async resync(engineInstanceIds: readonly string[]): Promise<void> {
    if (!this.readRevisions) return;
    const targets = engineInstanceIds.filter(id => this.sessionFor(id)?.features.has(UPLINK_CRED_FEATURE));
    if (!targets.length) return;
    for (const [engineInstanceId, revision] of await this.readRevisions(targets))
      this.revisionChanged(engineInstanceId, revision);
  }

  onFrame(session: UplinkSession, t: string, d: Record<string, unknown>): boolean | "invalid" {
    if (t !== "cred.ack") return false;
    const ack = CredAckSchema.safeParse(d);
    if (!ack.success) return "invalid";
    try {
      this.onAck?.(session, ack.data);
    } catch { /* an observer must not fail the frame */ }
    return true;
  }
}

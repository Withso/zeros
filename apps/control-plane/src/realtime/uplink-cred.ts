import { z } from "zod";

import type { UplinkIdentity } from "./uplink-authority.js";
import type { UplinkExtension, UplinkSession } from "./uplink-server.js";

/** The negotiated feature for credential-control push (S2 cred channel). */
export const UPLINK_CRED_FEATURE = "cred.v1";

const CredAckSchema = z.object({
  kind: z.enum(["agent-controls", "repository"]),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  result: z.enum(["applied", "failed"]),
  code: z.string().min(1).max(64).optional(),
}).strict();
export type UplinkCredAck = z.infer<typeof CredAckSchema>;

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
  private readonly onAck: ((session: UplinkSession, ack: UplinkCredAck) => void) | undefined;

  constructor(options: {
    sessionFor: (engineInstanceId: string) => UplinkSession | null;
    readRevision: (identity: UplinkIdentity) => Promise<number | null>;
    onAck?: (session: UplinkSession, ack: UplinkCredAck) => void;
  }) {
    this.sessionFor = options.sessionFor;
    this.readRevision = options.readRevision;
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

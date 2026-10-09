import { CloudActorProvenanceSchema, CloudAgentBootScopeSchema, type CloudActorProvenance, type CloudAgentBootScope } from "@zeros/protocol/cloud-agent-bootstrap";
import { cloudActorCan } from "@zeros/protocol/cloud-actors";
import { CloudCommandFailureError, type CloudCommandFailureCause } from "@zeros/protocol/cloud-commands";
import { isDeepStrictEqual } from "node:util";
import { freezeCloudSnapshot } from "./cloud-mcp";

type Capability = "read" | "run" | "edit";
type Clock = { wall(): number; monotonic(): number };
const clock: Clock = { wall: () => Date.now(), monotonic: () => performance.now() };
/** Matches the bounded transport authority window; confirmation never grants
 * an independent long-lived permission merely because a boot cache exists. */
export const CLOUD_ACTOR_AUTHORITY_MAX_MS = 10_000;
declare const authorizedActor: unique symbol;
export interface CloudAuthorizedActor {
  readonly [authorizedActor]: true;
  readonly provenance: CloudActorProvenance;
  readonly signal: AbortSignal;
  assertLive(capability?: Capability): void;
}
type Record = {
  registry: CloudActorAuthorityRegistry; actor: CloudAuthorizedActor;
  controller: AbortController; confirmation: CloudActorProvenance;
  deadline: number; timer: ReturnType<typeof setTimeout> | null; cause: Error | null;
};
const authorized = new WeakMap<object, Record>();
const registries = new WeakSet<object>();
export const isCloudActorAuthorityRegistry = (value: unknown): value is CloudActorAuthorityRegistry =>
  !!value && typeof value === "object" && registries.has(value);
export function isCloudAuthorizedActor(value: unknown): value is CloudAuthorizedActor {
  return !!value && typeof value === "object" && authorized.has(value);
}
function failure(category: CloudCommandFailureCause["category"]): Error {
  return new CloudCommandFailureError({ stage: "validation", category });
}
function sameBinding(left: CloudActorProvenance, right: CloudActorProvenance): boolean {
  return left.actorSessionId === right.actorSessionId && left.authorityEpoch === right.authorityEpoch &&
    left.fundingConsentVersion === right.fundingConsentVersion && isDeepStrictEqual(left.scope, right.scope) &&
    isDeepStrictEqual(left.actor, right.actor) && isDeepStrictEqual(left.fundingGrant, right.fundingGrant);
}

/** Only the trusted engine's verified CP admission/renewal path calls confirm.
 * Parsing provenance, a renderer session ID, or an open websocket does not
 * mint one of these opaque principals. Accepted intent stores provenance only
 * and reauthorizes it against this registry immediately before dispatch. */
export class CloudActorAuthorityRegistry {
  readonly scope: CloudAgentBootScope;
  private readonly records = new Map<string, Record>();
  private readonly revoked = new Set<string>();
  private disposed = false;
  private readonly time: Clock;
  private readonly maxEntries: number;
  constructor(private readonly options: { scope: CloudAgentBootScope; engineLive(): boolean; time?: Clock; maxEntries?: number }) {
    const scope = CloudAgentBootScopeSchema.safeParse(options.scope);
    if (!scope.success || (options.maxEntries !== undefined && (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 1 || options.maxEntries > 1024)))
      throw failure("authority_response_invalid");
    this.scope = freezeCloudSnapshot(scope.data);
    this.time = options.time ?? clock;
    this.maxEntries = options.maxEntries ?? 256;
    registries.add(this);
  }

  private assertEngine(): void {
    let live = false;
    try { live = !this.disposed && this.options.engineLive(); } catch { /* An unavailable authority predicate fails closed. */ }
    if (!live) {
      this.dispose();
      throw failure("lifecycle_superseded");
    }
  }
  private retire(record: Record, cause: Error): void {
    record.cause ??= cause;
    if (record.timer) { clearTimeout(record.timer); record.timer = null; }
    if (!record.controller.signal.aborted) record.controller.abort(record.cause);
  }
  private assertRecord(record: Record, capability: Capability): void {
    this.assertEngine();
    if (record.cause) throw record.cause;
    if (this.time.monotonic() >= record.deadline || this.time.wall() >= record.confirmation.confirmedUntilMs) {
      this.retire(record, failure("session_expired"));
      throw record.cause;
    }
    const current = this.records.get(record.confirmation.actorSessionId);
    if (current !== record) {
      this.retire(record, failure("lifecycle_superseded"));
      throw record.cause;
    }
    const provenance = record.confirmation;
    if (!cloudActorCan(provenance.actor.role, capability) ||
      (capability !== "read" && (provenance.fundingConsentVersion !== 1 || !provenance.fundingGrant)))
      throw failure("access_denied");
  }
  private schedule(record: Record): void {
    if (record.timer) clearTimeout(record.timer);
    record.timer = setTimeout(() => {
      record.timer = null;
      this.retire(record, failure("session_expired"));
    }, Math.max(0, record.deadline - this.time.monotonic()));
    record.timer.unref?.();
  }

  confirm(value: unknown): CloudAuthorizedActor {
    this.assertEngine();
    const parsed = CloudActorProvenanceSchema.safeParse(value);
    if (!parsed.success) throw failure("authority_response_invalid");
    const provenance = freezeCloudSnapshot(parsed.data);
    if (!isDeepStrictEqual(provenance.scope, this.scope)) throw failure("access_denied");
    if (this.revoked.has(provenance.actorSessionId)) throw failure("access_denied");
    const previous = this.records.get(provenance.actorSessionId);
    if (previous && (provenance.actor.userId !== previous.confirmation.actor.userId ||
      provenance.actor.deviceId !== previous.confirmation.actor.deviceId)) {
      // A CP recorded actor session never changes its user or device. An
      // epoch/grant/key advance cannot authorize replacing either identity.
      this.retire(previous, failure("access_denied"));
      this.revoked.add(provenance.actorSessionId);
      throw failure("authority_response_invalid");
    }
    if (previous && provenance.authorityEpoch < previous.confirmation.authorityEpoch) throw failure("lifecycle_superseded");
    if (previous && (provenance.actor.deviceKeyVersion < previous.confirmation.actor.deviceKeyVersion ||
      (provenance.fundingGrant?.kind === previous.confirmation.fundingGrant?.kind &&
       provenance.fundingGrant?.kind !== "owner" && previous.confirmation.fundingGrant?.kind !== "owner" &&
       provenance.fundingGrant && previous.confirmation.fundingGrant &&
       provenance.fundingGrant.grantId === previous.confirmation.fundingGrant.grantId &&
       provenance.fundingGrant.grantRevision < previous.confirmation.fundingGrant.grantRevision)))
      throw failure("lifecycle_superseded");
    if (previous && !previous.cause && (this.time.monotonic() >= previous.deadline ||
      this.time.wall() >= previous.confirmation.confirmedUntilMs)) this.retire(previous, failure("session_expired"));
    if (previous && sameBinding(previous.confirmation, provenance) && !previous.cause &&
        provenance.confirmedUntilMs <= previous.confirmation.confirmedUntilMs) {
      this.assertRecord(previous, "read");
      return previous.actor;
    }
    const remaining = provenance.confirmedUntilMs - this.time.wall();
    if (remaining <= 0) throw failure("session_expired");
    if (remaining > CLOUD_ACTOR_AUTHORITY_MAX_MS) throw failure("authority_response_invalid");
    if (previous && sameBinding(previous.confirmation, provenance) && !previous.cause) {
      previous.confirmation = provenance;
      previous.deadline = this.time.monotonic() + remaining;
      this.schedule(previous);
      return previous.actor;
    }
    const newerKey = previous && provenance.actor.userId === previous.confirmation.actor.userId &&
      provenance.actor.deviceId === previous.confirmation.actor.deviceId &&
      provenance.actor.deviceKeyVersion > previous.confirmation.actor.deviceKeyVersion;
    const newerGrant = previous && provenance.fundingGrant && previous.confirmation.fundingGrant &&
      provenance.fundingGrant.kind !== "owner" && previous.confirmation.fundingGrant.kind !== "owner" &&
      provenance.fundingGrant.kind === previous.confirmation.fundingGrant.kind &&
      provenance.fundingGrant.grantId === previous.confirmation.fundingGrant.grantId &&
      provenance.fundingGrant.grantRevision > previous.confirmation.fundingGrant.grantRevision;
    if (previous && provenance.authorityEpoch === previous.confirmation.authorityEpoch && !sameBinding(previous.confirmation, provenance) && !newerKey && !newerGrant) {
      // A renewal cannot replace its recorded user/device/role/grant identity.
      // Require a fresh CP admission, not a delayed conflicting confirmation.
      this.retire(previous, failure("access_denied"));
      this.revoked.add(provenance.actorSessionId);
      throw failure("authority_response_invalid");
    }
    if (!previous) {
      // Retain each session's epoch/key/grant high-water for the whole boot.
      // Even an expired newer proof may replace an older still-future proof.
      // Capacity is finite; exhaustion refuses new sessions, never evicts a
      // replay fence, switches writer, or falls back to a legacy admission.
      if (this.records.size >= this.maxEntries) throw failure("execution_limit");
    }
    if (previous) this.retire(previous, failure("lifecycle_superseded"));
    const controller = new AbortController();
    let record: Record;
    const actor = Object.freeze({ provenance, signal: controller.signal,
      assertLive: (capability: Capability = "run") => this.assertRecord(record, capability) }) as CloudAuthorizedActor;
    record = { registry: this, actor, controller, confirmation: provenance,
      deadline: this.time.monotonic() + remaining, timer: null, cause: null };
    this.records.set(provenance.actorSessionId, record);
    authorized.set(actor, record);
    this.schedule(record);
    return actor;
  }

  authorizeCurrent(actorSessionId: string, capability: Capability): CloudAuthorizedActor {
    this.assertEngine();
    const record = this.records.get(actorSessionId);
    if (!record) throw failure("access_denied");
    this.assertRecord(record, capability);
    return record.actor;
  }
  assertActor(actor: CloudAuthorizedActor, capability: Capability = "run"): void {
    this.assertEngine();
    const record = authorized.get(actor);
    if (!record || record.registry !== this) throw failure("access_denied");
    this.assertRecord(record, capability);
  }
  reauthorizeRecorded(value: unknown, capability: Capability = "run"): CloudAuthorizedActor {
    this.assertEngine();
    const parsed = CloudActorProvenanceSchema.safeParse(value);
    if (!parsed.success) throw failure("authority_response_invalid");
    const record = this.records.get(parsed.data.actorSessionId);
    if (!record || !sameBinding(record.confirmation, parsed.data)) throw failure("access_denied");
    this.assertRecord(record, capability);
    return record.actor;
  }
  revoke(actorSessionId: string): void {
    // Tombstones are retained for this boot: a late positive renewal cannot
    // undo an explicit revoke. Fresh transport admission uses a new session ID.
    if (!this.revoked.has(actorSessionId) && this.revoked.size >= this.maxEntries) {
      this.dispose();
      throw failure("execution_limit");
    }
    this.revoked.add(actorSessionId);
    const record = this.records.get(actorSessionId);
    if (record) this.retire(record, failure("access_denied"));
  }
  dispose(): void {
    this.disposed = true;
    for (const record of this.records.values()) this.retire(record, failure("lifecycle_superseded"));
  }
}

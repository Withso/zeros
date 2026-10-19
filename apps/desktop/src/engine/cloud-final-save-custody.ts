import { createHash, randomUUID } from "node:crypto";
import { canonicalFinalSaveJson, canonicalFinalSaveSource, CloudFinalSaveDirectiveSchema, CloudFinalSaveResponseSchema,
  type CloudFinalSaveCommit, type CloudFinalSaveResponse } from "@zeros/protocol/cloud-final-save";
import type { CloudCheckpointDirective, CloudDurabilityAuthority } from "./cloud-durability-runtime";

export class CloudFinalSaveCustodyError extends Error {
  readonly code = "engine_authority_rejected";
  constructor() { super("cloud final save custody is no longer current"); this.name = "CloudFinalSaveCustodyError"; }
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function freeze(directive: CloudCheckpointDirective): Readonly<CloudCheckpointDirective> {
  const value = structuredClone(directive);
  if (value.finalSave) {
    value.finalSave = CloudFinalSaveDirectiveSchema.parse(value.finalSave);
    if (sha(canonicalFinalSaveSource(value.finalSave.source)) !== value.finalSave.sourceSha256) throw new CloudFinalSaveCustodyError();
    Object.freeze(value.finalSave.source); Object.freeze(value.finalSave);
  }
  return Object.freeze(value);
}

/** In-memory proof owner. Neither a journal nor server metadata can construct
 * this with a successor or replace its original native object identities. */
export class CloudFinalSaveCustody {
  readonly custodyId = randomUUID();
  readonly authority: Readonly<CloudDurabilityAuthority>;
  private current: Readonly<CloudCheckpointDirective>;
  private retirement: string | null = null;
  private nativeControls: (() => boolean) | null = null;
  private failures = 0;
  constructor(directive: CloudCheckpointDirective, authority: CloudDurabilityAuthority, private readonly nativeCurrent: (mutation: boolean) => boolean) {
    this.current = freeze(directive); this.authority = Object.freeze({ ...authority });
    if (this.current.finalSave && this.current.finalSave.attemptOrdinal !== 0) throw new CloudFinalSaveCustodyError();
    this.assert(false);
  }
  get directive() { return this.current; }
  get retired() { return this.retirement !== null; }
  /** Original drain tickets are allocated synchronously before preparation I/O.
   * A retry may recheck them but can never replace their pinned identities. */
  pinNativeControls(current: () => boolean): void {
    this.assert(false);
    this.nativeControls ??= current;
    this.assert(false);
  }
  assert(requireLiveDeadline = true): void {
    const source = this.current.finalSave?.source, authority = this.authority;
    if (!this.nativeCurrent(requireLiveDeadline) || (this.nativeControls && !this.nativeControls()) ||
      (requireLiveDeadline && (this.retired || this.current.deadlineAtMs <= Date.now())) ||
      (source && (source.organizationId !== authority.organizationId || source.workspaceId !== authority.workspaceId ||
        source.generation !== authority.generation || source.engineInstanceId !== authority.engineInstanceId))) throw new CloudFinalSaveCustodyError();
  }
  accept(directive: CloudCheckpointDirective, authority: CloudDurabilityAuthority): void {
    this.assert(false);
    if (canonicalFinalSaveJson(authority) !== canonicalFinalSaveJson(this.authority)) throw new CloudFinalSaveCustodyError();
    const next = freeze(directive), before = this.current;
    if (next.id === before.id) {
      if (canonicalFinalSaveJson(next) !== canonicalFinalSaveJson(before)) throw new CloudFinalSaveCustodyError();
      return;
    }
    const old = before.finalSave, offered = next.finalSave;
    if (!old || !offered || !this.retirement || next.reason !== before.reason || next.idleStop ||
      offered.recoveryId !== old.recoveryId || offered.sourceSha256 !== old.sourceSha256 ||
      canonicalFinalSaveJson(offered.source) !== canonicalFinalSaveJson(old.source) ||
      offered.attemptOrdinal !== old.attemptOrdinal + 1 || offered.predecessorRequestId !== before.id ||
      offered.retirementId !== this.retirement || offered.custodyId !== this.custodyId ||
      next.deadlineAtMs <= Date.now() || next.deadlineAtMs > Date.now() + 300_000 || !this.nativeCurrent(true))
      throw new CloudFinalSaveCustodyError();
    this.current = next; this.retirement = null;
  }
  report(kind: "retry" | "reconcile", commit: CloudFinalSaveCommit | null) {
    this.assert(false);
    const finalSave = this.current.finalSave;
    if (!finalSave) throw new CloudFinalSaveCustodyError();
    const { organizationId,workspaceId,generation,engineInstanceId } = this.authority;
    const common = { organizationId,workspaceId,generation,engineInstanceId,version:1 as const,recoveryId:finalSave.recoveryId,
      requestId:this.current.id,attemptOrdinal:finalSave.attemptOrdinal,sourceSha256:finalSave.sourceSha256,custodyId:this.custodyId,commit };
    return kind === "reconcile" ? { ...common,kind } : { ...common,kind,failure:commit ? "commit_ambiguous" as const : "capture_failed" as const };
  }
  validateResponse(raw: unknown): CloudFinalSaveResponse {
    this.assert(false);
    const response = CloudFinalSaveResponseSchema.parse(raw), offer = this.current.finalSave;
    if (!offer || response.recoveryId !== offer.recoveryId || response.requestId !== this.current.id ||
      response.attemptOrdinal !== offer.attemptOrdinal || response.sourceSha256 !== offer.sourceSha256 || response.custodyId !== this.custodyId)
      throw new CloudFinalSaveCustodyError();
    return response;
  }
  consumeRetirement(response: CloudFinalSaveResponse): void {
    const checked = this.validateResponse(response);
    if (checked.state !== "retired" || (this.retirement && this.retirement !== checked.retirementId)) throw new CloudFinalSaveCustodyError();
    this.retirement = checked.retirementId;
  }
  retryAt(): number {
    const delay = [5_000,15_000,30_000,60_000,120_000,300_000][Math.min(this.failures++,5)]!;
    return Date.now() + delay;
  }
}

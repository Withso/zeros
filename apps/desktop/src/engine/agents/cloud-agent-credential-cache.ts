import {
  CloudAgentBootCredentialResponseSchema, CloudAgentBootScopeSchema, CloudAgentBootRefreshResponseSchema,
  type CloudAgentBootScope, type CloudAgentBootCredentialResponse, type CloudAgentBootProviderReady,
  type CloudAgentBootSyncRequest, type CloudAgentCredentialRunInfo, type CloudAgentBootConversation,
  type CloudAgentBootRefreshRequest, type CloudAgentBootRefreshResponse,
} from "@zeros/protocol/cloud-agent-bootstrap";
import type { CloudAgentAccessMaterial, CloudAgentAdmissionCode } from "@zeros/protocol/cloud-agent-execution";
import { CloudCommandFailureError, type CloudCommandFailureCause } from "@zeros/protocol/cloud-commands";
import { isDeepStrictEqual } from "node:util";
import { freezeCloudSnapshot } from "./cloud-mcp";

type Provider = CloudAgentBootProviderReady["provider"];
type Clock = { wall(): number; monotonic(): number };
const clock: Clock = { wall: () => Date.now(), monotonic: () => performance.now() };
const failure = (category: CloudCommandFailureCause["category"]) => new CloudCommandFailureError({ stage: "validation", category });
const admissionFailure = (code: CloudAgentAdmissionCode) => Object.assign(new Error("Cloud provider credentials are unavailable"), { code });
const credentialCapture: unique symbol = Symbol("cloud-agent-credential-capture");
export interface CloudAgentCredentialCapture {
  readonly [credentialCapture]: true;
  readonly scope: CloudAgentBootScope;
  readonly runInfo: CloudAgentCredentialRunInfo;
  readonly credentialKind: CloudAgentAccessMaterial["kind"];
  readonly models: readonly string[];
  readonly nativeCapabilities: Readonly<CloudAgentBootProviderReady["nativeCapabilities"]>;
  readonly credentialVersion: number;
  readonly signal: AbortSignal;
  assertLive(): void;
  takeMaterial(): CloudAgentAccessMaterial;
  codexAuth(): { material: Extract<CloudAgentAccessMaterial, { kind: "codex-chatgpt" }>; credentialVersion: number } | null;
  refreshCodex(version: number, previousAccountId?: string | null): Promise<{
    material: Extract<CloudAgentAccessMaterial, { kind: "codex-chatgpt" }>; credentialVersion: number;
  }>;
  /** Called only after the native owner proves exact retirement. */
  release(): void;
}
type Capture = {
  cache: CloudAgentCredentialCache; public: CloudAgentCredentialCapture; controller: AbortController;
  provider: CloudAgentBootProviderReady | null; consumed: boolean; cause: Error | null;
  deadline: number; timer: ReturnType<typeof setTimeout> | null;
};
const captures = new WeakMap<object, Capture>();
const caches = new WeakSet<object>();
export const isCloudAgentCredentialCache = (value: unknown): value is CloudAgentCredentialCache =>
  !!value && typeof value === "object" && caches.has(value);
export const isCloudAgentCredentialCapture = (value: unknown): value is CloudAgentCredentialCapture =>
  !!value && typeof value === "object" && captures.has(value);
type Metadata = CloudAgentBootConversation;
type ProviderDeadline = {
  expiry: number; deadline: number; authorityExpiry: number; authorityDeadline: number;
  refreshAt: number | null; refreshDeadline: number | null;
};
export type CloudBootCredentialBackgroundWork = Readonly<{
  synchronizeInMs: number | null; codexRefreshInMs: number | null;
}>;
export type CloudBootCredentialReadiness =
  | { readonly state: "ready" | "pending"; readonly cacheRevision: number; readonly desiredCacheRevision: number }
  | { readonly state: "unavailable"; readonly code: CloudAgentAdmissionCode };
export type CloudCredentialAssociationFloor = Readonly<{ cacheRevision: number; connectionRevision: number }>;
type RetiredAssociation = { cacheRevision: number; connectionRevision: number | null };

/** Engine memory only. initialize/synchronize are explicit background work;
 * synchronous readiness/capture/native callbacks never call their requesters.
 * Current material is bounded to three slots; old material survives only in a
 * live captured native scope and is released after its owner's exit proof. */
export class CloudAgentCredentialCache {
  readonly scope: CloudAgentBootScope;
  private readonly time: Clock;
  private readonly controller = new AbortController();
  private readonly active = new Set<Capture>();
  private readonly revoked = new Set<string>();
  private readonly retiredAssociations = new Map<string, RetiredAssociation>();
  private readonly providerDeadlines = new Map<Provider, ProviderDeadline>();
  private snapshot: CloudAgentBootCredentialResponse | null = null;
  private desired = 0;
  private initializing: Promise<void> | null = null;
  private synchronizing: Promise<void> | null = null;
  private refreshing: Promise<void> | null = null;
  private disposed = false;
  private readonly maxCaptures: number;
  constructor(private readonly options: {
    scope: CloudAgentBootScope; engineLive(): boolean; time?: Clock; maxCaptures?: number;
    request: {
      bootstrap(signal: AbortSignal): Promise<unknown>;
      sync(request: CloudAgentBootSyncRequest, signal: AbortSignal): Promise<unknown>;
      refresh?(request: CloudAgentBootRefreshRequest, signal: AbortSignal): Promise<unknown>;
    };
  }) {
    const scope = CloudAgentBootScopeSchema.safeParse(options.scope);
    if (!scope.success || (options.maxCaptures !== undefined && (!Number.isSafeInteger(options.maxCaptures) || options.maxCaptures < 1 || options.maxCaptures > 64)))
      throw failure("authority_response_invalid");
    this.scope = freezeCloudSnapshot(scope.data); this.time = options.time ?? clock;
    this.maxCaptures = options.maxCaptures ?? 16;
    caches.add(this);
  }
  private assertEngine(): void {
    let live = false;
    try { live = !this.disposed && this.options.engineLive(); } catch { /* unavailable authority fails closed */ }
    if (!live) { this.dispose(); throw failure("lifecycle_superseded"); }
  }
  get metadata(): Metadata {
    this.assertEngine();
    if (!this.snapshot) throw admissionFailure("cloud_agent_credential_refresh_required");
    const { providers: _providers, ...metadata } = this.snapshot;
    return freezeCloudSnapshot({ ...metadata, desiredCacheRevision: this.desired });
  }
  initialize(signal: AbortSignal = this.controller.signal): Promise<void> {
    this.assertEngine();
    if (this.snapshot) return Promise.resolve();
    if (this.initializing) return this.initializing;
    const starting = (async () => {
      const value = await this.options.request.bootstrap(AbortSignal.any([signal, this.controller.signal]));
      this.assertEngine(); signal.throwIfAborted(); this.install(value);
    })();
    this.initializing = starting;
    void starting.finally(() => { if (this.initializing === starting) this.initializing = null; }).catch(() => {});
    return starting;
  }
  /** The mutation/control channel supplies only a verified current boot epoch.
   * This does not fetch, launch, revoke an active ordinary run or lower state. */
  markDesired(revision: number): void {
    this.assertEngine();
    if (!Number.isSafeInteger(revision) || revision < 1) throw failure("authority_response_invalid");
    this.desired = Math.max(this.desired, revision);
  }
  synchronize(signal: AbortSignal = this.controller.signal): Promise<void> {
    this.assertEngine();
    if (this.refreshing) return this.refreshing;
    if (!this.snapshot) return this.initialize(signal);
    if (this.synchronizing) return this.synchronizing;
    const syncing = this.synchronizeSnapshot(signal);
    this.synchronizing = syncing;
    void syncing.finally(() => { if (this.synchronizing === syncing) this.synchronizing = null; }).catch(() => {});
    return syncing;
  }
  private async synchronizeSnapshot(signal: AbortSignal, refreshed?: CloudAgentBootRefreshResponse): Promise<void> {
    const request: CloudAgentBootSyncRequest = { version: 1, mode: "boot-owner-v1",
      organizationId: this.scope.organizationId, workspaceId: this.scope.workspaceId, generation: this.scope.generation,
      engineInstanceId: this.scope.engineInstanceId, bootId: this.scope.bootId, writerEpoch: this.scope.writerEpoch,
      expectedCacheRevision: Math.max(this.snapshot!.cacheRevision, refreshed?.cacheRevision ?? 0) };
    const value = await this.options.request.sync(request, AbortSignal.any([signal, this.controller.signal]));
    this.assertEngine(); signal.throwIfAborted();
    if (refreshed) {
      const parsed = CloudAgentBootCredentialResponseSchema.safeParse(value);
      const current = parsed.success ? parsed.data.providers.find(provider => provider.provider === "codex") : undefined;
      if (!parsed.success || parsed.data.cacheRevision < refreshed.cacheRevision || parsed.data.authorityEpoch < refreshed.authorityEpoch ||
          (parsed.data.cacheRevision === refreshed.cacheRevision && !isDeepStrictEqual(current, refreshed.provider)) ||
          (current?.status === "ready" && this.sameCodexSelection(refreshed.provider, current) &&
            (current.materialVersion < refreshed.provider.materialVersion ||
              (current.materialVersion === refreshed.provider.materialVersion && !isDeepStrictEqual(current.material, refreshed.provider.material)))))
        throw failure("credential_refresh_invalid");
    }
    this.install(value);
  }
  /** Engine-owned timer hints, with no credential material or HTTP work.
   * Source grants renew independently from Codex token expiry. Both wall and
   * monotonic clocks bound scheduling; clock rollback cannot postpone it. */
  get backgroundWork(): CloudBootCredentialBackgroundWork {
    this.assertEngine();
    if (!this.snapshot || this.desired > this.snapshot.cacheRevision)
      return Object.freeze({ synchronizeInMs: 0, codexRefreshInMs: null });
    let synchronizeInMs: number | null = null, codexRefreshInMs: number | null = null;
    for (const provider of this.snapshot.providers) {
      if (provider.status !== "ready" || this.revoked.has(provider.credentialId) || this.associationRetired(provider, this.snapshot.cacheRevision)) continue;
      const timing = this.providerDeadlines.get(provider.provider)!;
      const authorityRemaining = Math.min(timing.authorityExpiry - this.time.wall(), timing.authorityDeadline - this.time.monotonic());
      if (Number.isFinite(authorityRemaining))
        synchronizeInMs = Math.min(synchronizeInMs ?? Infinity, Math.max(0, Math.min(2_147_483_647, authorityRemaining / 2)));
      if (provider.material.kind === "codex-chatgpt" && authorityRemaining > 0 && timing.refreshAt !== null && timing.refreshDeadline !== null)
        codexRefreshInMs = Math.max(0, Math.min(2_147_483_647, timing.refreshAt - this.time.wall(), timing.refreshDeadline - this.time.monotonic()));
    }
    return Object.freeze({ synchronizeInMs, codexRefreshInMs });
  }
  private assertSourceAuthority(provider: CloudAgentBootProviderReady): void {
    if (this.revoked.has(provider.credentialId) || this.associationRetired(provider, this.snapshot?.cacheRevision ?? 0))
      throw admissionFailure("cloud_agent_credential_revoked");
    const timing = this.providerDeadlines.get(provider.provider);
    if (!timing || this.time.wall() >= timing.authorityExpiry || this.time.monotonic() >= timing.authorityDeadline)
      throw admissionFailure("cloud_agent_credential_expired");
  }
  /** Explicit background work only. A one-provider refresh proof is never a
   * full cache snapshot: park new starts, then fetch all three current slots.
   * The native auth callback only consumes already-published access. */
  refreshCodexAccess(signal: AbortSignal = this.controller.signal): Promise<void> {
    this.assertEngine();
    if (this.refreshing) return this.refreshing;
    const refreshing = Promise.resolve().then(async () => {
      if (this.synchronizing) await this.synchronizing;
      this.assertEngine(); signal.throwIfAborted();
      if (!this.snapshot || this.desired > this.snapshot.cacheRevision)
        throw admissionFailure("cloud_agent_credential_refresh_required");
      const selected = this.selected("codex");
      if (!selected || selected.status !== "ready") throw admissionFailure(selected?.code ?? "cloud_agent_credential_required");
      this.assertSourceAuthority(selected);
      if (selected.material.kind !== "codex-chatgpt" || this.backgroundWork.codexRefreshInMs !== 0)
        throw failure("credential_refresh_rejected");
      if (!this.options.request.refresh) throw failure("authority_unavailable");
      const request: CloudAgentBootRefreshRequest = { version: 1, mode: "boot-owner-v1", provider: "codex",
        organizationId: this.scope.organizationId, workspaceId: this.scope.workspaceId, generation: this.scope.generation,
        engineInstanceId: this.scope.engineInstanceId, bootId: this.scope.bootId, writerEpoch: this.scope.writerEpoch,
        credentialId: selected.credentialId, credentialRevision: selected.credentialRevision,
        expectedCacheRevision: this.snapshot.cacheRevision, expectedMaterialVersion: selected.materialVersion };
      const value = await this.options.request.refresh(request, AbortSignal.any([signal, this.controller.signal]));
      this.assertEngine(); signal.throwIfAborted(); this.assertSourceAuthority(selected);
      const parsed = CloudAgentBootRefreshResponseSchema.safeParse(value), current = this.selected("codex");
      if (!parsed.success || Object.entries(this.scope).some(([key, item]) => parsed.data[key as keyof typeof parsed.data] !== item) ||
          parsed.data.authorityEpoch < this.snapshot.authorityEpoch || parsed.data.cacheRevision <= request.expectedCacheRevision ||
          parsed.data.cacheRevision < this.desired || parsed.data.cacheRevision < this.snapshot.cacheRevision ||
          !this.sameCodexSelection(selected, parsed.data.provider) || parsed.data.provider.materialVersion <= request.expectedMaterialVersion ||
          !current || current.status !== "ready" || !this.sameCodexSelection(selected, current))
        throw failure("credential_refresh_invalid");
      this.markDesired(parsed.data.cacheRevision);
      await this.synchronizeSnapshot(signal, parsed.data);
    });
    this.refreshing = refreshing;
    void refreshing.finally(() => { if (this.refreshing === refreshing) this.refreshing = null; }).catch(() => {});
    return refreshing;
  }
  private install(value: unknown): void {
    const parsed = CloudAgentBootCredentialResponseSchema.safeParse(value);
    if (!parsed.success || Object.entries(this.scope).some(([key, item]) => parsed.data[key as keyof typeof parsed.data] !== item))
      throw failure("authority_response_invalid");
    const incoming = parsed.data, previous = this.snapshot;
    if (previous && (!isDeepStrictEqual(previous.initialAdoptions, incoming.initialAdoptions) || incoming.authorityEpoch < previous.authorityEpoch))
      throw failure("authority_response_invalid");
    if (incoming.desiredCacheRevision < this.desired || (previous && (incoming.cacheRevision < previous.cacheRevision ||
        (incoming.cacheRevision === previous.cacheRevision && !isDeepStrictEqual(incoming.providers, previous.providers)))) ||
        incoming.providers.some(provider => provider.status === "ready" &&
          (this.revoked.has(provider.credentialId) || this.associationRetired(provider, incoming.cacheRevision))))
      throw failure("credential_refresh_invalid");
    for (const provider of incoming.providers) {
      if (provider.status !== "ready") { this.providerDeadlines.delete(provider.provider); continue; }
      const expiry = this.expiry(provider), previousDeadline = this.providerDeadlines.get(provider.provider);
      const authorityExpiry = provider.authorityExpiresAt ? Date.parse(provider.authorityExpiresAt) : Infinity;
      const sourceDeadline = this.time.monotonic() + authorityExpiry - this.time.wall();
      const authorityDeadline = previousDeadline?.authorityExpiry === authorityExpiry ? Math.min(previousDeadline.authorityDeadline, sourceDeadline) : sourceDeadline;
      const deadline = Math.min(this.time.monotonic() + expiry - this.time.wall(), authorityDeadline);
      const refreshAt = provider.refreshAfter ? Date.parse(provider.refreshAfter) : null;
      const refreshDeadline = refreshAt === null ? null : this.time.monotonic() + refreshAt - this.time.wall();
      this.providerDeadlines.set(provider.provider, { expiry, deadline: previousDeadline?.expiry === expiry ? Math.min(previousDeadline.deadline, deadline) : deadline,
        authorityExpiry, authorityDeadline, refreshAt, refreshDeadline: refreshDeadline !== null && previousDeadline?.refreshAt === refreshAt && previousDeadline.refreshDeadline !== null
          ? Math.min(previousDeadline.refreshDeadline, refreshDeadline) : refreshDeadline });
    }
    this.snapshot = freezeCloudSnapshot(structuredClone(incoming));
    this.desired = Math.max(this.desired, incoming.desiredCacheRevision);
    // Positive same-account access can be adopted by the private auth owner;
    // replaced accounts keep their captured material and original deadline.
    for (const record of this.active) this.adoptPublishedCodex(record);
  }
  private expiry(provider: CloudAgentBootProviderReady): number {
    return Math.min(provider.expiresAt ? Date.parse(provider.expiresAt) : Infinity,
      provider.authorityExpiresAt ? Date.parse(provider.authorityExpiresAt) : Infinity);
  }
  private selected(provider: Provider): CloudAgentBootCredentialResponse["providers"][number] | undefined {
    return this.snapshot?.providers.find(value => value.provider === provider);
  }
  readiness(provider: Provider, model: string): CloudBootCredentialReadiness {
    this.assertEngine();
    if (!this.snapshot || this.desired > this.snapshot.cacheRevision)
      return { state: "pending", cacheRevision: this.snapshot?.cacheRevision ?? 0, desiredCacheRevision: this.desired };
    const selected = this.selected(provider);
    if (!selected || selected.status !== "ready") return { state: "unavailable", code: selected?.code ?? "cloud_agent_credential_required" };
    if (this.revoked.has(selected.credentialId) || this.associationRetired(selected, this.snapshot.cacheRevision))
      return { state: "unavailable", code: "cloud_agent_credential_revoked" };
    if (!selected.models.includes(model)) return { state: "unavailable", code: "cloud_agent_model_not_authorized" };
    if (this.time.wall() >= this.expiry(selected) || this.time.monotonic() >= (this.providerDeadlines.get(provider)?.deadline ?? -Infinity))
      return { state: "unavailable", code: "cloud_agent_credential_expired" };
    return { state: "ready", cacheRevision: this.snapshot.cacheRevision, desiredCacheRevision: this.desired };
  }
  capture(provider: Provider, model: string): CloudAgentCredentialCapture {
    const ready = this.readiness(provider, model);
    if (ready.state === "pending") throw admissionFailure("cloud_agent_credential_refresh_required");
    if (ready.state === "unavailable") throw admissionFailure(ready.code);
    if (this.active.size >= this.maxCaptures) throw failure("execution_limit");
    const selected = this.selected(provider) as CloudAgentBootProviderReady;
    const runInfo: CloudAgentCredentialRunInfo = freezeCloudSnapshot({ version: 1, bootId: this.scope.bootId,
      writerEpoch: this.scope.writerEpoch, cacheRevision: this.snapshot!.cacheRevision, provider,
      fundingOwnerUserId: this.scope.fundingOwnerUserId, fundingOwnerEpoch: this.scope.fundingOwnerEpoch,
      credentialId: selected.credentialId, credentialRevision: selected.credentialRevision, connectionRevision: selected.connectionRevision,
      adoptionId: selected.adoptionId, materialVersion: selected.materialVersion, displayName: selected.displayName });
    let record: Capture;
    const publicCapture = Object.freeze({ [credentialCapture]: true, scope: this.scope, runInfo, credentialKind: selected.kind,
      models: freezeCloudSnapshot([...selected.models]), nativeCapabilities: freezeCloudSnapshot({ ...selected.nativeCapabilities }),
      get credentialVersion() { return record.provider?.materialVersion ?? runInfo.materialVersion; },
      get signal() { return record.controller.signal; }, assertLive: () => this.assertCapture(record),
      takeMaterial: () => {
        this.assertCapture(record);
        if (record.consumed) throw failure("access_denied");
        record.consumed = true; return structuredClone(record.provider!.material);
      },
      codexAuth: () => {
        this.assertCapture(record); const provider = record.provider!;
        return provider.material.kind === "codex-chatgpt" ? { material: { ...provider.material }, credentialVersion: provider.materialVersion } : null;
      },
      refreshCodex: async (version: number, previousAccountId?: string | null) => {
        this.assertEngine();
        const old = record.provider;
        if (record.cause || !old || old.material.kind !== "codex-chatgpt" || !Number.isSafeInteger(version) || version < 1 ||
            version > old.materialVersion || (previousAccountId != null && previousAccountId !== old.material.accountId))
          throw failure("credential_refresh_invalid");
        const current = this.selected("codex");
        if (!current || current.status !== "ready" || !this.sameCodexSelection(old, current)) throw failure("credential_refresh_rejected");
        this.assertCapture(record);
        const updated = record.provider!;
        if (updated.material.kind !== "codex-chatgpt" || updated.materialVersion <= version) throw failure("credential_refresh_unchanged");
        return { material: { ...updated.material }, credentialVersion: updated.materialVersion };
      }, release: () => this.releaseCapture(record),
    } satisfies CloudAgentCredentialCapture);
    record = { cache: this, public: publicCapture, controller: new AbortController(), provider: structuredClone(selected),
      consumed: false, cause: null, deadline: this.providerDeadlines.get(provider)!.deadline, timer: null };
    this.active.add(record); captures.set(publicCapture, record); this.armExpiry(record);
    return publicCapture;
  }
  private sameCodexSelection(left: CloudAgentBootProviderReady, right: CloudAgentBootProviderReady): boolean {
    return left.material.kind === "codex-chatgpt" && right.material.kind === "codex-chatgpt" &&
      left.credentialId === right.credentialId && left.credentialRevision === right.credentialRevision &&
      left.connectionRevision === right.connectionRevision && left.material.accountId === right.material.accountId;
  }
  private adoptPublishedCodex(record: Capture): void {
    const old = record.provider, current = this.selected("codex");
    // A late background result cannot revive a native auth scope whose
    // positive source deadline already passed, even for the same account.
    if (!record.cause && old && (this.time.wall() >= this.expiry(old) || this.time.monotonic() >= record.deadline)) {
      this.retireCapture(record, admissionFailure("cloud_agent_credential_expired"));
      return;
    }
    if (record.cause || !old || !current || current.status !== "ready" || this.desired > (this.snapshot?.cacheRevision ?? 0) ||
        !this.sameCodexSelection(old, current) || current.materialVersion <= old.materialVersion) return;
    record.provider = structuredClone(current); record.deadline = this.providerDeadlines.get("codex")!.deadline;
    this.armExpiry(record);
  }
  private assertCapture(record: Capture): void {
    this.assertEngine(); if (record.cause) throw record.cause;
    this.adoptPublishedCodex(record);
    if (!record.provider || this.time.wall() >= this.expiry(record.provider) || this.time.monotonic() >= record.deadline) {
      this.retireCapture(record, admissionFailure("cloud_agent_credential_expired")); throw record.cause;
    }
  }
  private armExpiry(record: Capture): void {
    if (record.timer) clearTimeout(record.timer);
    if (record.cause || !Number.isFinite(record.deadline)) { record.timer = null; return; }
    record.timer = setTimeout(() => {
      record.timer = null;
      try { this.assertCapture(record); this.armExpiry(record); } catch { /* signal owns retirement */ }
    }, Math.max(0, Math.min(2_147_483_647, record.deadline - this.time.monotonic())));
    record.timer.unref?.();
  }
  private retireCapture(record: Capture, cause: Error): void {
    record.cause ??= cause;
    if (record.timer) { clearTimeout(record.timer); record.timer = null; }
    if (!record.controller.signal.aborted) record.controller.abort(record.cause);
  }
  private releaseCapture(record: Capture): void {
    this.retireCapture(record, failure("lifecycle_superseded")); record.provider = null; this.active.delete(record);
  }
  /** Private positive material identity, never a presentation alias. Current
   * actor/model/capability/context fences are separately checked by factory. */
  sameAuthScope(left: CloudAgentCredentialCapture, right: CloudAgentCredentialCapture): boolean {
    this.assertEngine(); const a = captures.get(left), b = captures.get(right);
    if (!a || !b || a.cache !== this || b.cache !== this) return false;
    this.assertCapture(a); this.assertCapture(b);
    const am = a.provider!.material, bm = b.provider!.material;
    if (am.kind !== bm.kind) return false;
    if (am.kind === "codex-chatgpt" && bm.kind === "codex-chatgpt") return am.accountId === bm.accountId;
    return isDeepStrictEqual(am, bm);
  }
  /** FIRST foreground handoff/warm-turn acquisition only. An entered run's
   * tools use assertLive instead, so background publication never hot-swaps
   * or interrupts that captured source. Global/unrelated revisions alone do
   * not make an unchanged provider selection stale. */
  assertCurrentSelection(capture: CloudAgentCredentialCapture, model: string): void {
    const record = captures.get(capture);
    if (!record || record.cache !== this) throw failure("access_denied");
    const ready = this.readiness(record.public.runInfo.provider, model);
    if (ready.state === "pending") throw admissionFailure("cloud_agent_credential_refresh_required");
    if (ready.state === "unavailable") throw admissionFailure(ready.code);
    this.assertCapture(record);
    const current = this.selected(record.public.runInfo.provider) as CloudAgentBootProviderReady, original = record.provider!;
    const captured = record.public;
    const sameMaterial = original.material.kind === "codex-chatgpt" && current.material.kind === "codex-chatgpt"
      ? original.material.accountId === current.material.accountId : isDeepStrictEqual(original.material, current.material);
    if (captured.runInfo.credentialId !== current.credentialId || captured.runInfo.credentialRevision !== current.credentialRevision ||
        captured.runInfo.connectionRevision !== current.connectionRevision || captured.credentialKind !== current.kind || !sameMaterial ||
        !isDeepStrictEqual(captured.models, current.models) || !isDeepStrictEqual(captured.nativeCapabilities, current.nativeCapabilities))
      throw failure("lifecycle_superseded");
  }
  private associationKey(provider: Provider, credentialId: string): string {
    if (!["claude", "codex", "cursor"].includes(provider) || !/^[0-9a-f-]{36}$/i.test(credentialId))
      throw failure("authority_response_invalid");
    return `${provider}:${credentialId}`;
  }
  private associationRetired(provider: CloudAgentBootProviderReady, cacheRevision: number): boolean {
    const floor = this.retiredAssociations.get(this.associationKey(provider.provider, provider.credentialId));
    return !!floor && (floor.connectionRevision === null || provider.connectionRevision <= floor.connectionRevision || cacheRevision <= floor.cacheRevision);
  }
  /** Pure nonsecret metadata for the durable engine retirement fence. Only
   * positive installed snapshots/captures contribute an association floor;
   * a desired revision or adoption ID is never positive source authority. */
  associationFloor(provider: Provider, credentialId: string): CloudCredentialAssociationFloor | null {
    this.assertEngine();
    const retired = this.retiredAssociations.get(this.associationKey(provider, credentialId));
    if (retired?.connectionRevision === null) return null;
    let connectionRevision = retired?.connectionRevision ?? null;
    let cacheRevision = Math.max(retired?.cacheRevision ?? 0, this.snapshot?.cacheRevision ?? 0);
    const selected = this.selected(provider);
    if (selected?.status === "ready" && selected.credentialId === credentialId)
      connectionRevision = Math.max(connectionRevision ?? 0, selected.connectionRevision);
    for (const record of this.active) if (record.provider?.provider === provider && record.provider.credentialId === credentialId) {
      connectionRevision = Math.max(connectionRevision ?? 0, record.provider.connectionRevision);
      cacheRevision = Math.max(cacheRevision, record.public.runInfo.cacheRevision);
    }
    return connectionRevision === null ? null : Object.freeze({ cacheRevision, connectionRevision });
  }
  /** Removing one organization association invalidates every old capture.
   * Its boot-long floors never disappear. Only a later full authenticated
   * publication above BOTH floors may create a new capture; the separate
   * durable start fence also requires positive whole-scope retirement. */
  retireAssociation(provider: Provider, credentialId: string): void {
    this.assertEngine(); const key = this.associationKey(provider, credentialId);
    if (!this.retiredAssociations.has(key) && this.retiredAssociations.size >= 1024) {
      this.dispose(); throw failure("execution_limit");
    }
    const floor = this.associationFloor(provider, credentialId);
    this.retiredAssociations.set(key, floor ?? { cacheRevision: this.snapshot?.cacheRevision ?? 0, connectionRevision: null });
    for (const record of this.active) if (record.provider?.provider === provider && record.provider.credentialId === credentialId)
      this.retireCapture(record, admissionFailure("cloud_agent_credential_revoked"));
  }
  /** Hard credential revocation is permanent, including any later connection
   * revision. Association re-admission never clears this source tombstone. */
  revokeCredential(credentialId: string): void {
    this.assertEngine();
    if (!/^[0-9a-f-]{36}$/i.test(credentialId)) throw failure("authority_response_invalid");
    if (!this.revoked.has(credentialId) && this.revoked.size >= 1024) { this.dispose(); throw failure("execution_limit"); }
    this.revoked.add(credentialId);
    for (const record of this.active) if (record.provider?.credentialId === credentialId)
      this.retireCapture(record, admissionFailure("cloud_agent_credential_revoked"));
  }
  dispose(): void {
    this.disposed = true; this.snapshot = null; this.providerDeadlines.clear(); this.controller.abort();
    for (const record of this.active) this.retireCapture(record, failure("lifecycle_superseded"));
  }
}

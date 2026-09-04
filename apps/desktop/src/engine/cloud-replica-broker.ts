import { createHash } from "node:crypto";

import {
  CloudReplicaApplyEngine,
  CloudReplicaApplyError,
  normalizeCloudReplicaPath,
  type CloudReplicaMutation,
} from "./cloud-replica-apply";
import type {
  CloudReplicaEventPage,
  CloudReplicaApi,
  CloudReplicaGrant,
  CloudReplicaRemoteState,
} from "./cloud-replica-client";
import { assertCloudReplicaEventPage } from "./cloud-replica-client";
import {
  DatabaseCloudReplicaState,
  cloudReplicaPathIncluded,
  parseCloudReplicaIgnorePolicy,
  type CloudReplicaLocalState,
} from "./cloud-replica-state";

const MAX_BOOTSTRAP_PAGES = 1_001;
const MAX_EVENT_PAGES_PER_RUN = 100;
const CHECKPOINT_MANIFEST_AUDIENCE =
  "zeros-cloud-workspace-checkpoint-manifest-v1";
const LEGACY_CHECKPOINT_MANIFEST_AUDIENCE =
  "zeros-local-to-cloud-fork-v1";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const FULL_COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

type GrantState = CloudReplicaGrant & { replicaId: string };

export type BootstrapManifestEntry = {
  entryType: "file" | "symlink";
  mode: 33188 | 33261 | 40960;
  contentSha256: string;
  sizeBytes: number;
};

export type BootstrapManifestBinding =
  | { kind: "legacy" }
  | {
      kind: "projection-v1";
      entries: ReadonlyMap<string, BootstrapManifestEntry>;
      deletions: ReadonlySet<string>;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isGitBaseCommit(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && FULL_COMMIT_PATTERN.test(value))
  );
}

function isGitHeadRef(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" &&
      value.length >= 1 &&
      value.length <= 512 &&
      // eslint-disable-next-line no-control-regex -- Git refs reject controls
      !/[\u0000-\u001f\u007f]/u.test(value))
  );
}

function isBootstrapEntryType(
  value: unknown,
): value is BootstrapManifestEntry["entryType"] {
  return typeof value === "string" && (value === "file" || value === "symlink");
}

function isBootstrapEntryMode(
  value: unknown,
): value is BootstrapManifestEntry["mode"] {
  return (
    typeof value === "number" &&
    (value === 33188 || value === 33261 || value === 40960)
  );
}

function compareUtf8Path(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function bootstrapProtocolError(message: string): never {
  throw new CloudReplicaBrokerError("remote_protocol_error", message);
}

export function parseBootstrapManifest(input: {
  bytes: Uint8Array;
  page: {
    integritySha256: string;
    fileCount: number;
    totalBytes: number;
    gitBaseCommit?: string | null;
    gitHeadRef?: string | null;
  };
}): BootstrapManifestBinding {
  if (
    !SHA256_PATTERN.test(input.page.integritySha256) ||
    !Number.isSafeInteger(input.page.fileCount) ||
    input.page.fileCount < 0 ||
    !Number.isSafeInteger(input.page.totalBytes) ||
    input.page.totalBytes < 0 ||
    createHash("sha256").update(input.bytes).digest("hex") !==
      input.page.integritySha256
  ) {
    bootstrapProtocolError("Cloud bootstrap manifest integrity is invalid");
  }

  let document: unknown;
  try {
    document = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(input.bytes),
    ) as unknown;
  } catch {
    bootstrapProtocolError("Cloud bootstrap manifest is unreadable");
  }
  if (!isRecord(document)) {
    bootstrapProtocolError("Cloud bootstrap manifest is invalid");
  }

  const audience = document.audience;
  if (typeof audience !== "string") {
    bootstrapProtocolError("Cloud bootstrap manifest audience is invalid");
  }
  if (audience === LEGACY_CHECKPOINT_MANIFEST_AUDIENCE) {
    // Existing local-to-cloud fork descriptors predate the self-describing
    // projection manifest. Their advertised SHA still pins these bytes and
    // page/count checks remain in force, but only the v1 audience can bind
    // each path descriptor. Keep this exact compatibility contract until all
    // retained descriptors under this audience expire.
    return { kind: "legacy" };
  }
  if (audience !== CHECKPOINT_MANIFEST_AUDIENCE) {
    bootstrapProtocolError("Cloud bootstrap manifest audience is invalid");
  }

  const gitBaseCommit = document.gitBaseCommit;
  const gitHeadRef = document.gitHeadRef;
  if (
    document.version !== 1 ||
    !Array.isArray(document.entries) ||
    !Array.isArray(document.deletions) ||
    !isGitBaseCommit(gitBaseCommit) ||
    !isGitHeadRef(gitHeadRef) ||
    gitBaseCommit !== (input.page.gitBaseCommit ?? null) ||
    gitHeadRef !== (input.page.gitHeadRef ?? null)
  ) {
    bootstrapProtocolError("Cloud bootstrap manifest metadata is invalid");
  }

  const entries = new Map<string, BootstrapManifestEntry>();
  let totalBytes = 0;
  for (const entry of document.entries) {
    if (!isRecord(entry)) {
      bootstrapProtocolError("Cloud bootstrap manifest entry is invalid");
    }
    const entryPathValue = entry.path;
    if (typeof entryPathValue !== "string") {
      bootstrapProtocolError("Cloud bootstrap manifest path is invalid");
    }
    let entryPath: string;
    try {
      entryPath = normalizeCloudReplicaPath(entryPathValue);
    } catch {
      bootstrapProtocolError("Cloud bootstrap manifest path is invalid");
    }
    const entryType = entry.entryType;
    const mode = entry.mode;
    const contentSha256 = entry.contentSha256;
    const sizeBytes = entry.sizeBytes;
    if (
      entries.has(entryPath) ||
      !isBootstrapEntryType(entryType) ||
      !isBootstrapEntryMode(mode) ||
      (entryType === "symlink") !== (mode === 40960) ||
      typeof contentSha256 !== "string" ||
      !SHA256_PATTERN.test(contentSha256) ||
      typeof sizeBytes !== "number" ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 0 ||
      sizeBytes > 64 * 1024 * 1024 ||
      (entryType === "symlink" && (sizeBytes < 1 || sizeBytes > 4_096))
    ) {
      bootstrapProtocolError("Cloud bootstrap manifest entry is invalid");
    }
    totalBytes += sizeBytes;
    if (
      !Number.isSafeInteger(totalBytes) ||
      totalBytes > input.page.totalBytes
    ) {
      bootstrapProtocolError("Cloud bootstrap manifest is too large");
    }
    entries.set(entryPath, {
      entryType: entryType as BootstrapManifestEntry["entryType"],
      mode: mode as BootstrapManifestEntry["mode"],
      contentSha256,
      sizeBytes,
    });
  }
  const deletions = new Set<string>();
  for (const deletion of document.deletions) {
    if (typeof deletion !== "string") {
      bootstrapProtocolError("Cloud bootstrap manifest deletion is invalid");
    }
    let deletionPath: string;
    try {
      deletionPath = normalizeCloudReplicaPath(deletion);
    } catch {
      bootstrapProtocolError("Cloud bootstrap manifest deletion is invalid");
    }
    if (entries.has(deletionPath) || deletions.has(deletionPath)) {
      bootstrapProtocolError("Cloud bootstrap manifest paths are duplicated");
    }
    deletions.add(deletionPath);
  }
  if (
    entries.size !== input.page.fileCount ||
    totalBytes !== input.page.totalBytes
  ) {
    bootstrapProtocolError("Cloud bootstrap manifest totals do not match");
  }
  return { kind: "projection-v1", entries, deletions };
}

export function assertBootstrapEntryMatchesManifest(
  binding: BootstrapManifestBinding,
  entry:
    | Omit<CloudReplicaMutation, "revision" | "sequence">
    | {
        operation: "upsert";
        path: string;
        entryType: "file" | "symlink";
        mode: 33188 | 33261 | 40960;
        contentSha256: string;
        sizeBytes: number;
      }
    | { operation: "delete"; path: string },
): void {
  if (binding.kind === "legacy") return;
  if (entry.operation === "delete") {
    if (!binding.deletions.has(entry.path)) {
      bootstrapProtocolError("Cloud bootstrap deletion is not in its manifest");
    }
    return;
  }
  const expected = binding.entries.get(entry.path);
  if (
    !expected ||
    expected.entryType !== entry.entryType ||
    expected.mode !== entry.mode ||
    expected.contentSha256 !== entry.contentSha256 ||
    expected.sizeBytes !== entry.sizeBytes
  ) {
    bootstrapProtocolError("Cloud bootstrap entry is not in its manifest");
  }
}

export class CloudReplicaBrokerError extends Error {
  constructor(
    public readonly code:
      | "replica_not_active"
      | "remote_identity_mismatch"
      | "remote_protocol_error"
      | "replica_apply_failed"
      | "replica_diverged"
      | "cancelled",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CloudReplicaBrokerError";
  }
}

function receiptKey(input: {
  replicaId: string;
  fromRevision: number;
  toRevision: number;
  manifestSha256: string;
  outcome: string;
  errorCode: string | null;
}): string {
  return `rr_${createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")}`;
}

function assertRemoteIdentity(
  local: CloudReplicaLocalState,
  remote: CloudReplicaRemoteState,
): void {
  if (
    remote.id !== local.replicaId ||
    remote.workspaceId !== local.workspaceId ||
    remote.organizationId !== local.organizationId ||
    remote.deviceId !== local.deviceId ||
    remote.mode !== "receive_only"
  ) {
    throw new CloudReplicaBrokerError(
      "remote_identity_mismatch",
      "Cloud replica response does not match this device binding",
    );
  }
}

function applyErrorCode(error: unknown): {
  outcome: "diverged" | "failed";
  errorCode: string;
} {
  if (error instanceof CloudReplicaApplyError) {
    if (error.code === "local_divergence") {
      return { outcome: "diverged", errorCode: "local_content_changed" };
    }
    const mapped: Record<CloudReplicaApplyError["code"], string> = {
      invalid_batch: "invalid_cloud_batch",
      path_rejected: "unsafe_cloud_path",
      unsupported_local_type: "unsupported_local_type",
      blob_integrity_failed: "blob_integrity_failed",
      symlink_rejected: "unsafe_cloud_symlink",
      local_divergence: "local_content_changed",
      apply_failed: "filesystem_apply_failed",
    };
    return { outcome: "failed", errorCode: mapped[error.code] };
  }
  return { outcome: "failed", errorCode: "replica_apply_failed" };
}

/** Receive-only synchronizer. It owns no persistent credential: WorkOS access,
 * the Ed25519 signer, and short-lived replica grants are supplied/in-memory.
 * SQLite advances only after the retry-safe server receipt succeeds. */
export class CloudReplicaSyncBroker {
  private readonly grants = new Map<string, GrantState>();
  private readonly inFlight = new Map<
    string,
    Promise<CloudReplicaLocalState>
  >();
  private cancelled = false;

  constructor(
    private readonly api: CloudReplicaApi,
    private readonly state: DatabaseCloudReplicaState,
    private readonly now: () => number = Date.now,
  ) {}

  seedGrant(replicaId: string, grant: CloudReplicaGrant): void {
    const expiry = Date.parse(grant.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= this.now()) {
      throw new CloudReplicaBrokerError(
        "remote_protocol_error",
        "Cloud replica grant is already expired",
      );
    }
    this.grants.set(replicaId, { ...grant, replicaId });
  }

  revokeLocalGrant(replicaId: string): void {
    this.grants.delete(replicaId);
  }

  /** Stop a session generation before it can commit a later receipt/local
   * cursor. In-flight HTTP implementations may finish their current request,
   * but every broker boundary below observes this latch before mutable state. */
  cancel(): void {
    this.cancelled = true;
    this.grants.clear();
  }

  private assertActive(): void {
    if (this.cancelled) {
      throw new CloudReplicaBrokerError(
        "cancelled",
        "Cloud replica synchronization was cancelled",
      );
    }
  }

  sync(replicaId: string): Promise<CloudReplicaLocalState> {
    try {
      this.assertActive();
    } catch (error) {
      return Promise.reject(error);
    }
    const current = this.inFlight.get(replicaId);
    if (current) return current;
    const work = this.syncExclusive(replicaId).finally(() => {
      if (this.inFlight.get(replicaId) === work)
        this.inFlight.delete(replicaId);
    });
    this.inFlight.set(replicaId, work);
    return work;
  }

  private local(replicaId: string): CloudReplicaLocalState {
    this.assertActive();
    const local = this.state.replica(replicaId);
    if (!local || local.desiredState !== "active") {
      throw new CloudReplicaBrokerError(
        "replica_not_active",
        "Local cloud replica is not active",
      );
    }
    return local;
  }

  private coordinates(local: CloudReplicaLocalState) {
    return {
      organizationId: local.organizationId,
      workspaceId: local.workspaceId,
      replicaId: local.replicaId,
    };
  }

  private updateRemote(
    local: CloudReplicaLocalState,
    remote: CloudReplicaRemoteState,
  ) {
    assertRemoteIdentity(local, remote);
    const locallyDiverged =
      remote.desiredState === "active" &&
      this.state.hasOpenDivergences(local.replicaId);
    return this.state.updateRemoteState({
      replicaId: local.replicaId,
      desiredState: remote.desiredState,
      observedState: locallyDiverged
        ? "diverged"
        : (remote.observedState as CloudReplicaLocalState["observedState"]),
      workspaceAuthorityEpoch: remote.workspaceAuthorityEpoch,
      grantEpoch: remote.grantEpoch,
      checkpointId: remote.checkpointId,
      manifestRevision: remote.manifestRevision,
      lastErrorCode: locallyDiverged
        ? "local_content_changed"
        : remote.lastErrorCode,
    });
  }

  private async activeGrant(local: CloudReplicaLocalState): Promise<string> {
    this.assertActive();
    const existing = this.grants.get(local.replicaId);
    if (existing && Date.parse(existing.expiresAt) > this.now() + 60_000) {
      return existing.token;
    }
    const renewed = await this.api.renewGrant(this.coordinates(local));
    this.assertActive();
    assertRemoteIdentity(local, renewed.replica);
    if (renewed.replica.desiredState !== "active") {
      throw new CloudReplicaBrokerError(
        "replica_not_active",
        "Cloud replica is not active",
      );
    }
    this.seedGrant(local.replicaId, renewed.grant);

    const projectionHash = this.state
      .projection(local.replicaId)
      .manifestSha256();
    if (renewed.replica.eventCursor > local.eventCursor) {
      if (renewed.replica.clientManifestSha256 !== projectionHash) {
        throw new CloudReplicaBrokerError(
          "remote_protocol_error",
          "Cloud and local replica receipts disagree",
        );
      }
      local = this.state.adoptRemoteCursor({
        replicaId: local.replicaId,
        fromRevision: local.eventCursor,
        toRevision: renewed.replica.eventCursor,
        manifestSha256: projectionHash,
        observedState:
          renewed.replica.observedState === "in_sync" ? "in_sync" : "syncing",
      });
    } else if (renewed.replica.eventCursor < local.eventCursor) {
      throw new CloudReplicaBrokerError(
        "remote_protocol_error",
        "Cloud replica cursor moved backwards",
      );
    }
    this.updateRemote(local, renewed.replica);
    return renewed.grant.token;
  }

  private blobFetcher(
    local: CloudReplicaLocalState,
    grantToken: string,
    mutations: readonly CloudReplicaMutation[],
  ): (blobId: string) => Promise<Uint8Array> {
    const sizes = new Map<string, number>();
    for (const mutation of mutations) {
      if (mutation.operation !== "upsert") continue;
      const existing = sizes.get(mutation.blobId!);
      if (existing !== undefined && existing !== mutation.sizeBytes) {
        throw new CloudReplicaBrokerError(
          "remote_protocol_error",
          "One cloud blob has conflicting descriptors",
        );
      }
      sizes.set(mutation.blobId!, mutation.sizeBytes!);
    }
    return async (blobId) => {
      this.assertActive();
      const expectedSizeBytes = sizes.get(blobId);
      if (expectedSizeBytes === undefined) {
        throw new CloudReplicaBrokerError(
          "remote_protocol_error",
          "Cloud replica requested an undeclared blob",
        );
      }
      const bytes = await this.api.readBlob({
        ...this.coordinates(local),
        grantToken,
        blobId,
        expectedSizeBytes,
      });
      this.assertActive();
      return bytes;
    };
  }

  private async reportApply(
    local: CloudReplicaLocalState,
    grantToken: string,
    input: {
      fromRevision: number;
      toRevision: number;
      manifestSha256: string;
      outcome: "applied" | "diverged" | "failed";
      errorCode: string | null;
    },
  ): Promise<CloudReplicaLocalState> {
    this.assertActive();
    let response: Awaited<ReturnType<CloudReplicaApi["recordReceipt"]>>;
    try {
      response = await this.api.recordReceipt({
        ...this.coordinates(local),
        grantToken,
        idempotencyKey: receiptKey({ replicaId: local.replicaId, ...input }),
        ...input,
      });
      this.assertActive();
    } catch (error) {
      // A timeout can mean the receipt committed but its response was lost.
      // Force a grant renewal next run; the returned server cursor plus the
      // complete manifest hash safely resolves that uncertainty.
      this.revokeLocalGrant(local.replicaId);
      throw error;
    }
    assertRemoteIdentity(local, response.replica);
    if (input.outcome === "applied") {
      const advanced = this.state.advanceReceipt({
        replicaId: local.replicaId,
        fromRevision: input.fromRevision,
        toRevision: input.toRevision,
        manifestSha256: input.manifestSha256,
        observedState:
          response.replica.observedState === "in_sync" ? "in_sync" : "syncing",
      });
      return this.updateRemote(advanced, response.replica);
    }
    this.revokeLocalGrant(local.replicaId);
    return this.updateRemote(local, response.replica);
  }

  private async applyOrReport(
    local: CloudReplicaLocalState,
    grantToken: string,
    input: {
      fromRevision: number;
      toRevision: number;
      mutations: readonly CloudReplicaMutation[];
    },
  ): Promise<{ local: CloudReplicaLocalState; manifestSha256: string }> {
    this.assertActive();
    const projection = this.state.projection(local.replicaId);
    try {
      const policy = parseCloudReplicaIgnorePolicy(local.ignorePolicy);
      // Validate every server path before applying the device-local policy.
      // A policy may omit ordinary project paths, but it must never turn a
      // server attempt to address .git, credentials, or an unsafe path into a
      // silently acknowledged event.
      for (const mutation of input.mutations) {
        normalizeCloudReplicaPath(mutation.path);
      }
      // A device-local ignore policy can remove the first (or all) mutation
      // in a remote revision. Filesystem apply still requires its own compact
      // sequence, while the unfiltered wire sequence was already checked by
      // the client/broker and is retained for the receipt below.
      let includedRevision = -1;
      let includedSequence = 0;
      const included = input.mutations
        .filter((mutation) => cloudReplicaPathIncluded(policy, mutation.path))
        .map((mutation) => {
          if (mutation.revision !== includedRevision) {
            includedRevision = mutation.revision;
            includedSequence = 0;
          }
          return { ...mutation, sequence: (includedSequence += 1) };
        });
      const applyToRevision = included.at(-1)?.revision ?? input.fromRevision;
      const result =
        included.length === 0
          ? { manifestSha256: projection.manifestSha256() }
          : await new CloudReplicaApplyEngine(
              projection,
              this.blobFetcher(local, grantToken, included),
            ).apply({
              replicaId: local.replicaId,
              rootPath: local.rootPath,
              fromRevision: input.fromRevision,
              toRevision: applyToRevision,
              mutations: included,
            });
      this.assertActive();
      return { local, manifestSha256: result.manifestSha256 };
    } catch (error) {
      if (
        error instanceof CloudReplicaBrokerError &&
        error.code === "cancelled"
      ) {
        throw error;
      }
      const failure = applyErrorCode(error);
      const manifestSha256 = projection.manifestSha256();
      try {
        await this.reportApply(local, grantToken, {
          fromRevision: input.fromRevision,
          toRevision: input.toRevision,
          manifestSha256,
          ...failure,
        });
      } catch {
        // Preserve the primary filesystem/integrity failure. Receipt retry is
        // deterministic and the next broker run can safely attempt it again.
      }
      if (failure.outcome === "failed") {
        try {
          this.state.markFailed(local.replicaId, failure.errorCode);
        } catch {
          // A concurrent pause/remove wins; do not hide the original failure.
        }
      }
      throw new CloudReplicaBrokerError(
        failure.outcome === "diverged"
          ? "replica_diverged"
          : "replica_apply_failed",
        failure.outcome === "diverged"
          ? "Local replica content changed and was preserved"
          : "Cloud replica update could not be applied",
        { cause: error },
      );
    }
  }

  private async bootstrap(
    local: CloudReplicaLocalState,
    grantToken: string,
  ): Promise<CloudReplicaLocalState> {
    this.assertActive();
    const seen = new Set<string>();
    let cursor: string | null = null;
    let descriptor: {
      checkpointId: string;
      revision: number;
      manifestBlobId: string;
      integritySha256: string;
      fileCount: number;
      totalBytes: number;
    } | null = null;
    let binding: BootstrapManifestBinding | null = null;
    let receivedCount = 0;
    let receivedBytes = 0;
    for (let pageIndex = 0; pageIndex < MAX_BOOTSTRAP_PAGES; pageIndex += 1) {
      const page = await this.api.readBootstrap({
        ...this.coordinates(local),
        grantToken,
        afterPath: cursor,
        limit: 500,
      });
      this.assertActive();
      const currentDescriptor = {
        checkpointId: page.checkpointId,
        revision: page.manifestRevision,
        manifestBlobId: page.manifestBlobId,
        integritySha256: page.integritySha256,
        fileCount: page.fileCount,
        totalBytes: page.totalBytes,
      };
      if (
        (descriptor &&
          JSON.stringify(descriptor) !== JSON.stringify(currentDescriptor)) ||
        page.checkpointId !== local.checkpointId ||
        page.manifestRevision !== local.manifestRevision ||
        (cursor !== null &&
          page.entries.length > 0 &&
          page.entries[0]!.path === cursor)
      ) {
        throw new CloudReplicaBrokerError(
          "remote_protocol_error",
          "Cloud bootstrap changed during pagination",
        );
      }
      descriptor ??= currentDescriptor;
      if (!binding) {
        const bytes = await this.api.readBlob({
          ...this.coordinates(local),
          grantToken,
          blobId: page.manifestBlobId,
        });
        this.assertActive();
        try {
          binding = parseBootstrapManifest({ bytes, page });
        } finally {
          bytes.fill(0);
        }
      }

      let previousPath = cursor;
      for (const entry of page.entries) {
        try {
          normalizeCloudReplicaPath(entry.path);
        } catch {
          throw new CloudReplicaBrokerError(
            "remote_protocol_error",
            "Cloud bootstrap path is invalid",
          );
        }
        if (
          previousPath !== null &&
          compareUtf8Path(entry.path, previousPath) <= 0
        ) {
          throw new CloudReplicaBrokerError(
            "remote_protocol_error",
            "Cloud bootstrap paths are not ordered",
          );
        }
        previousPath = entry.path;
        assertBootstrapEntryMatchesManifest(binding, entry);
      }
      const mutations = page.entries.map((entry, index) => ({
        ...entry,
        revision: page.manifestRevision,
        // Bootstrap pages are individually applied before their one final
        // receipt, so each synthetic local batch starts a fresh sequence.
        sequence: index + 1,
      }));
      for (const mutation of mutations) {
        if (seen.has(mutation.path)) {
          throw new CloudReplicaBrokerError(
            "remote_protocol_error",
            "Cloud bootstrap repeated a path",
          );
        }
        seen.add(mutation.path);
        receivedCount += mutation.operation === "upsert" ? 1 : 0;
        receivedBytes += mutation.sizeBytes ?? 0;
      }
      if (mutations.length > 0) {
        this.assertActive();
        await this.applyOrReport(local, grantToken, {
          fromRevision: local.eventCursor,
          toRevision: page.manifestRevision,
          mutations,
        });
        this.assertActive();
      }
      if (page.nextAfterPath === null) break;
      if (
        page.entries.length === 0 ||
        page.nextAfterPath !== page.entries[page.entries.length - 1]!.path ||
        page.nextAfterPath === cursor
      ) {
        throw new CloudReplicaBrokerError(
          "remote_protocol_error",
          "Cloud bootstrap cursor did not advance",
        );
      }
      cursor = page.nextAfterPath;
      if (pageIndex === MAX_BOOTSTRAP_PAGES - 1) {
        throw new CloudReplicaBrokerError(
          "remote_protocol_error",
          "Cloud bootstrap exceeded its file bound",
        );
      }
    }
    if (
      !descriptor ||
      !binding ||
      receivedCount !== descriptor.fileCount ||
      receivedBytes !== descriptor.totalBytes
    ) {
      throw new CloudReplicaBrokerError(
        "remote_protocol_error",
        "Cloud bootstrap totals do not match its checkpoint",
      );
    }
    if (
      binding.kind === "projection-v1" &&
      (seen.size !== binding.entries.size + binding.deletions.size ||
        [...binding.entries.keys()].some((entryPath) => !seen.has(entryPath)) ||
        [...binding.deletions].some((entryPath) => !seen.has(entryPath)))
    ) {
      throw new CloudReplicaBrokerError(
        "remote_protocol_error",
        "Cloud bootstrap pages do not match their manifest",
      );
    }

    const stale = this.state
      .projectionEntries(local.replicaId)
      .filter((entry) => !seen.has(entry.path));
    if (stale.length > 0) {
      for (let offset = 0; offset < stale.length; offset += 10_000) {
        const deletes: CloudReplicaMutation[] = stale
          .slice(offset, offset + 10_000)
          .map((entry, index) => ({
            revision: descriptor!.revision,
            sequence: index + 1,
            path: entry.path,
            operation: "delete",
            entryType: null,
            mode: null,
            blobId: null,
            contentSha256: null,
            sizeBytes: null,
          }));
        await this.applyOrReport(local, grantToken, {
          fromRevision: local.eventCursor,
          toRevision: descriptor.revision,
          mutations: deletes,
        });
        this.assertActive();
      }
    }
    const manifestSha256 = this.state
      .projection(local.replicaId)
      .manifestSha256();
    return this.reportApply(local, grantToken, {
      fromRevision: local.eventCursor,
      toRevision: descriptor.revision,
      manifestSha256,
      outcome: "applied",
      errorCode: null,
    });
  }

  private async refreshSnapshot(
    local: CloudReplicaLocalState,
  ): Promise<{ local: CloudReplicaLocalState; grantToken: string }> {
    this.assertActive();
    const response = await this.api.refreshSnapshot(this.coordinates(local));
    this.assertActive();
    assertRemoteIdentity(local, response.replica);
    if (
      !response.replica.checkpointId ||
      response.replica.manifestRevision === null
    ) {
      throw new CloudReplicaBrokerError(
        "remote_protocol_error",
        "Cloud snapshot response has no durable checkpoint",
      );
    }
    const reset = this.state.resetForSnapshot({
      replicaId: local.replicaId,
      checkpointId: response.replica.checkpointId,
      manifestRevision: response.replica.manifestRevision,
      workspaceAuthorityEpoch: response.replica.workspaceAuthorityEpoch,
      grantEpoch: response.replica.grantEpoch,
    });
    this.seedGrant(local.replicaId, response.grant);
    return { local: reset, grantToken: response.grant.token };
  }

  private async syncExclusive(
    replicaId: string,
  ): Promise<CloudReplicaLocalState> {
    this.assertActive();
    let local = this.local(replicaId);
    let grantToken = await this.activeGrant(local);
    this.assertActive();
    local = this.local(replicaId);
    if (
      local.manifestRevision !== null &&
      local.eventCursor < local.manifestRevision
    ) {
      local = await this.bootstrap(local, grantToken);
      this.assertActive();
    }
    for (
      let pageIndex = 0;
      pageIndex < MAX_EVENT_PAGES_PER_RUN;
      pageIndex += 1
    ) {
      local = this.local(replicaId);
      const page = await this.api.readEvents({
        ...this.coordinates(local),
        grantToken,
        afterRevision: local.eventCursor,
        limit: 100,
      });
      this.assertActive();
      if (page.snapshotRequired) {
        const refreshed = await this.refreshSnapshot(local);
        this.assertActive();
        local = await this.bootstrap(refreshed.local, refreshed.grantToken);
        grantToken = refreshed.grantToken;
        continue;
      }
      try {
        assertCloudReplicaEventPage(page as CloudReplicaEventPage, {
          afterRevision: local.eventCursor,
          limit: 100,
        });
      } catch {
        throw new CloudReplicaBrokerError(
          "remote_protocol_error",
          "Cloud event page is not contiguous",
        );
      }
      if (page.events.length === 0 && page.toRevision === page.fromRevision) {
        return local;
      }
      const result = await this.applyOrReport(local, grantToken, {
        fromRevision: page.fromRevision,
        toRevision: page.toRevision,
        mutations: page.events,
      });
      this.assertActive();
      local = await this.reportApply(local, grantToken, {
        fromRevision: page.fromRevision,
        toRevision: page.toRevision,
        manifestSha256: result.manifestSha256,
        outcome: "applied",
        errorCode: null,
      });
      this.assertActive();
      if (!page.hasMore) return local;
    }
    return local;
  }
}

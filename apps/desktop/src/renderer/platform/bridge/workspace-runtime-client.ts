import { CloudAgentBootIdentitySchema, type CloudAgentBootConversation } from "@zeros/protocol/cloud-agent-bootstrap";
import type { BridgeMessage } from "./messages";
import { WORKSPACE_RESOURCE_USAGE_CAPABILITY } from "@zeros/protocol/workspace-resource-usage";
import { isCloudGithubWriteOperation } from "@zeros/protocol/github-auth";
import { RuntimeClient, type ConnectionStatus } from "./ws-client";
import type { CloudAgentConnection, CloudConversationAttachment } from "./cloud-agent-connection";
import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";
import { CloudHistoryRestoreTracker, type CloudHistoryRestoreTicket } from "../../state/cloud-transcript-cache";
import { CloudHistoryRestoreMetadataSchema, type CloudHistoryRestoreMetadata, type CloudHistoryRestoreFence } from "../cloud-transcript-cache-contract";
import { installCloudHistoryRestoreMetadata, captureCloudHistoryRestoreRead, assertCloudHistoryRestoreResult } from "../cloud-transcript-cache";
import {
  cloudWorkspaceKey,
  isCloudRepositorySlug,
  parseCloudWorkspaceKey,
  parseCloudScopedId,
  type CloudWorkspaceTarget,
} from "./cloud-workspace-key";
import {
  cloudIncoming,
  cloudOutgoing,
  cloudRequestTarget,
  record,
  type CloudRuntimeScope,
  type WireRecord,
} from "./cloud-runtime-wire";

type Message = Partial<BridgeMessage> & { type: string };
/** Renderer-only refresh ownership; never sent to an engine. */
export type ChatSnapshotRefresh = "all" | "local" | "retained" | readonly string[];
type RequestOptions = Exclude<
  Parameters<RuntimeClient["request"]>[1],
  number | undefined
>;
export interface CloudPeer {
  client: RuntimeClient;
  scope: CloudRuntimeScope;
  release: () => void;
  runtimeId?: string;
  /** Native admission's exact generation; renderer-only, never inferred from
   * a catalog update that can race the connection's final reply. */
  generation?: number;
  agents?: CloudAgentConnection;
  events?: Pick<RuntimeClient, "on">;
  /** Serialize explicit work with idle capture and revalidate the admission.
   * False means the drain retired this connection and a fresh one is needed. */
  prepareForRun?: (signal: AbortSignal, reason?: "interaction") => Promise<boolean>;
}
export interface CloudResourceUsageConnection extends CloudWorkspaceTarget {
  generation: number;
  engineInstanceId: string;
  authorityEpoch: number;
  admissionId: string;
}
export interface WorkspaceRuntimeOptions {
  open: (target: CloudWorkspaceTarget, options?: { signal: AbortSignal; wake?: boolean; reason?: "interaction" }) => Promise<CloudPeer>;
  /** Account/catalog epoch and generation; never a credential or admission. */
  identity?: (target: CloudWorkspaceTarget) => string;
  /** Explicit wake ownership follows replacements and in-progress rollbacks.
   * Undefined revokes run access; passive connections remain exact-generation. */
  wakeOwner?: (target: CloudWorkspaceTarget) => WakeOwner | undefined;
  workspaces: () => readonly WireRecord[];
  /** Complete catalog confirmation includes an authoritative empty list. */
  workspacesConfirmed?: () => boolean;
  canAccess?: (target: CloudWorkspaceTarget) => boolean;
  manage?: (target: CloudWorkspaceTarget, op: string, params?: WireRecord) => Promise<WireRecord>;
  /** Authorized database reads that do not require a worker connection. */
  readHistory?: (target: CloudWorkspaceTarget, op: string, params: WireRecord) => Promise<WireRecord>;
  /** Desktop durable cache: checkpoint passive projections at turn/departure boundaries. */
  checkpointHistory?: boolean;
  /** Passive authenticated head publications, including before a later page or
   * optional disk write fails. No connection/wake/recovery is opened here. */
  onHistoryRestoreHead?: (listener: (chatId: string, head: CloudHistoryRestoreFence) => void) => () => void;
  prepareGithubWrite?: (target: CloudWorkspaceTarget, op: string, params: WireRecord) => Promise<string>;
}
interface WakeOwner { account: string; generation: number; stopVersion: number; lifecyclePending?: boolean; retargetVersion?: number }
class CloudAdmissionGenerationChangedError extends Error {
  constructor(readonly generation: number) { super("Cloud workspace generation changed during admission"); }
}
function cloudHistoryReadError(response: BridgeMessage, invalidResponseMessage: string): Error {
  if (response.type !== "WORKSPACE_ERROR") return new Error(invalidResponseMessage);
  return Object.assign(new Error(response.message), {
    name: "WorkspaceOpError",
    code: response.code,
    ...(response.remediation !== undefined ? { remediation: response.remediation } : {}),
  });
}
interface PeerEntry extends CloudPeer {
  unsubscribers: Map<string, () => void>;
  stopStatus: () => void;
  snapshot: WireRecord;
  hasChatSnapshot: boolean;
  retired: boolean;
  epoch: number;
  identity: string;
  snapshotRevision: number;
  attachments?: readonly CloudConversationAttachment[];
}
interface LocalListEntry {
  result?: WireRecord;
  epoch: number;
  kind: "chats" | "workspaces";
  mutation: number;
  confirmedMutation?: number;
  pending?: Promise<void>;
  pendingEpoch?: number;
  error?: unknown;
}
interface OpeningPeer {
  promise: Promise<PeerEntry>;
  identity: string;
  target: CloudWorkspaceTarget;
  controller: AbortController;
  wake: boolean;
  consumers: number;
  owner?: WakeOwner;
}

/** One renderer protocol boundary, multiple independently owned connections.
 * Unscoped host operations remain local. Every cloud operation carries its
 * semantic owner, so focus changes cannot redirect an outstanding request.
 * Existing transcript/workbench consumers subscribe to this same client. */
export class WorkspaceRuntimeClient extends RuntimeClient {
  private readonly peers = new Map<string, PeerEntry>();
  private readonly opening = new Map<string, OpeningPeer>();
  private readonly speculative = new Map<string, ReturnType<typeof setTimeout>>();
  private ongoingOpens = 0;
  private readonly historyIntents = new Map<string, number>();
  private readonly routedHandlers = new Map<
    string,
    Set<(message: BridgeMessage) => void>
  >();
  private accountEpoch = 0;
  private workspaceStatusListeners = new Map<string, Set<() => void>>();
  private closed = false;
  private readonly history = new KeyedAsyncCache<WireRecord>({
    maxEntries: 64, maxWeight: 24 * 1024 * 1024,
    weightOf: value => JSON.stringify(value).length * 2,
  });
  private readonly historyWorkspaces = new Map<string, CloudWorkspaceTarget>();
  private readonly historyWarmups = new Map<string, Promise<WireRecord>>();
  private readonly projectionCheckpoints = new Map<string, { until: number; pending: boolean }>();
  private localEpoch = 0;
  private readonly localLists = new Map<string, LocalListEntry>();
  private readonly cloudRepositorySlugs = new Set<string>();
  private sawCloudCatalog = false;
  private readonly stopLocalStatus: () => void;
  private readonly stopLocalChanges: () => void;
  private readonly historyRestore = new CloudHistoryRestoreTracker();
  private readonly nativeHistoryRestore = new CloudHistoryRestoreTracker();
  private readonly stopHistoryRestore: () => void;

  constructor(private readonly routing: WorkspaceRuntimeOptions) {
    super({ kind: "local" });
    this.historyRestore.setAccount(String(this.accountEpoch));
    this.nativeHistoryRestore.setAccount(String(this.accountEpoch));
    this.stopHistoryRestore = routing.onHistoryRestoreHead?.((chatId, fence) => {
      const target = parseCloudScopedId(chatId);
      if (!target || this.closed || this.routing.canAccess?.(target) === false) return;
      const ticket = this.captureHistoryRestore(target);
      if (!ticket) return;
      const metadata = CloudHistoryRestoreMetadataSchema.parse({ projection: fence.projection,
        historyHeads: fence.head ? [fence.head] : [] });
      this.installHistoryRestore(target, ticket, metadata, [target.id]);
    }) ?? (() => {});
    this.stopLocalStatus = super.onStatusChange(() => { this.localEpoch++; });
    // Subscribe directly to the Local transport before consumer subscriptions.
    // Renderer snapshot publications use emit(), so cannot invalidate themselves.
    this.stopLocalChanges = super.on("DB_CHANGED", message => {
      const { kinds } = message as unknown as WireRecord;
      for (const entry of this.localLists.values())
        if (!Array.isArray(kinds) || kinds.includes(entry.kind)) entry.mutation++;
    });
  }

  private confirmedCloudChats(): Map<string, WireRecord> {
    const confirmed = new Map([...this.peers.values()]
      .filter(entry => entry.hasChatSnapshot && (!this.routing.canAccess || this.routing.canAccess(entry.scope)))
      .map(entry => [cloudWorkspaceKey(entry.scope), entry.snapshot]));
    if (this.routing.readHistory) for (const [key, target] of this.historyWorkspaces) {
      if (this.routing.canAccess && !this.routing.canAccess(target)) continue;
      const data = this.history.peekSnapshot(this.historyKey(target, "chats.list", {})).data;
      if (data) confirmed.set(key, data);
    }
    return confirmed;
  }

  /** Revalidate Local without making another backend wait for its transport.
   * A failed read retains the exact-key snapshot and never confirms emptiness. */
  private localList(message: Message, options: number | RequestOptions, refresh = true): LocalListEntry {
    const wire = message as unknown as WireRecord;
    const key = JSON.stringify([wire.op, Object.entries(record(wire.params)).sort(([a], [b]) => a.localeCompare(b))]);
    const entry: LocalListEntry = this.localLists.get(key) ?? {
      epoch: -1, kind: wire.op === "chats.list" ? "chats" : "workspaces", mutation: 0,
    };
    this.localLists.delete(key);
    this.localLists.set(key, entry);
    if (!refresh) return entry;
    if (entry.pending && entry.pendingEpoch === this.localEpoch) return entry;
    const epoch = this.localEpoch;
    entry.pendingEpoch = epoch;
    const flight = (async () => {
      // Like KeyedAsyncCache's queued refresh, one shared flight owns the slot
      // until the newest mutation is read. A burst queues one successor, and a
      // later mutation during that successor can queue the following generation.
      while (epoch === this.localEpoch && !this.closed) {
        const mutation = entry.mutation;
        try {
          const response = await super.request(message, options);
          if (epoch !== this.localEpoch || this.closed) return;
          if (mutation !== entry.mutation) continue;
          const result = record((response as unknown as WireRecord).result);
          if (response.type !== "WORKSPACE_RESPONSE" || !Array.isArray(result[entry.kind]))
            throw new Error("Could not read the Local workspace snapshot");
          const changed = JSON.stringify(entry.result) !== JSON.stringify(result);
          if (changed) entry.result = result;
          const becameReady = entry.epoch !== epoch || entry.error !== undefined || entry.confirmedMutation !== mutation;
          entry.epoch = epoch;
          entry.confirmedMutation = mutation;
          entry.error = undefined;
          if (changed || becameReady) this.emit("DB_CHANGED", {
            type: "DB_CHANGED", kinds: [entry.kind], snapshotPublication: true,
          });
        } catch (error) {
          if (epoch !== this.localEpoch || this.closed) return;
          if (mutation !== entry.mutation) continue;
          entry.error = error;
        }
        if (mutation === entry.mutation) return;
      }
    })().finally(() => {
      if (entry.pending === flight) entry.pending = undefined;
      // Bound inactive exact-key Local lists without discarding an active read.
      for (const [oldKey, old] of this.localLists) {
        if (this.localLists.size <= 64) break;
        if (oldKey !== key && !old.pending) this.localLists.delete(oldKey);
      }
    });
    entry.pending = flight;
    return entry;
  }

  private async aggregateList(message: Message, options: number | RequestOptions, refresh: ChatSnapshotRefresh = "all"): Promise<BridgeMessage> {
    const wire = message as unknown as WireRecord;
    const params = record(wire.params);
    const epoch = this.accountEpoch;
    const catalogRows = this.routing.workspaces();
    if (catalogRows.length) this.sawCloudCatalog = true;
    // Retain bounded ownership for injected/legacy catalogs with opaque slugs.
    // Production slugs carry their backend independently of row membership.
    for (const row of catalogRows) if (typeof row.repoSlug === "string") {
      this.cloudRepositorySlugs.delete(row.repoSlug);
      this.cloudRepositorySlugs.add(row.repoSlug);
    }
    while (this.cloudRepositorySlugs.size > 128)
      this.cloudRepositorySlugs.delete(this.cloudRepositorySlugs.values().next().value!);
    const catalogConfirmed = this.routing.workspacesConfirmed?.() ?? this.sawCloudCatalog;
    const cloudRows = () => this.routing.workspaces().filter(row =>
      (!params.repoSlug || row.repoSlug === params.repoSlug) &&
      (!params.status || row.status === params.status) &&
      (params.archived === undefined || Boolean(row.archivedAt) === params.archived));
    // An exact cloud repository listing is already confirmed by the catalog.
    // Do not ask the Local engine about an organization-owned repository.
    const cloudOnly = wire.op === "workspace.list" && typeof params.repoSlug === "string" &&
      (isCloudRepositorySlug(params.repoSlug) || this.cloudRepositorySlugs.has(params.repoSlug));
    if (cloudOnly && !catalogConfirmed && !catalogRows.some(row => row.repoSlug === params.repoSlug))
      throw new Error("Cloud workspace catalog is not confirmed");
    const refreshLocal = refresh === "all" || refresh === "local";
    const local = cloudOnly ? undefined : this.localList(message, options, refreshLocal);
    const cloudRefresh = wire.op === "chats.list" && !this.routing.readHistory
      ? [...this.peers.values()].filter(entry => !entry.retired &&
          (refresh === "all" || (Array.isArray(refresh) && refresh.includes(cloudWorkspaceKey(entry.scope)))))
        .map(async entry => {
          const before = entry.snapshot;
          await this.readChats(entry);
          if (entry.snapshot !== before) this.changed(cloudWorkspaceKey(entry.scope), ["chats"]);
        }) : [];
    const hasCloud = () => wire.op === "chats.list" ? this.confirmedCloudChats().size > 0 :
      (!params.repoSlug && catalogConfirmed) || cloudRows().length > 0;
    // A warm snapshot publishes immediately; each cold backend publishes its
    // own completion nudge. No cold Local read can block confirmed cloud data.
    if (!hasCloud() && !cloudOnly) {
      // Local-only reads preserve their awaited refresh contract. If cold
      // cloud peers are also loading, publish the first confirmed backend.
      await Promise.any([
        ...(refreshLocal && local?.pending ? [local.pending.then(() => {
          if (!local?.result) throw local?.error;
        })] : []),
        ...cloudRefresh.map(async read => {
          await read;
          if (!hasCloud()) throw new Error("Cloud history is still cold");
        }),
      ]).catch(() => {});
    } else {
      void Promise.allSettled(cloudRefresh);
      await Promise.resolve();
    }
    if (epoch !== this.accountEpoch || this.closed)
      throw new Error("Cloud account changed while loading conversations");
    if (!local?.result && !hasCloud() && !cloudOnly)
      throw local?.error ?? new Error("No confirmed workspace snapshot is available");
    const result = local?.result ?? {};
    const confirmedLocal = !!local?.result && local.epoch === this.localEpoch &&
      local.confirmedMutation === local.mutation && !local.error;
    // Retention is not a new authoritative response. Without another confirmed
    // backend to publish, surface the failure so consumers retain their newer
    // mutation receipts and retry instead of committing this older list.
    if (!confirmedLocal && !hasCloud() && !cloudOnly)
      throw local?.error ?? new Error("Local workspace snapshot is not confirmed");
    if (wire.op === "workspace.list") return {
      type: "WORKSPACE_RESPONSE", op: wire.op, result: {
        ...result, confirmedLocalWorkspaces: confirmedLocal,
        confirmedCloudWorkspaces: cloudOnly || catalogConfirmed,
        workspaces: [...(Array.isArray(result.workspaces) ? result.workspaces : []), ...cloudRows()],
      },
    } as unknown as BridgeMessage;
    const confirmed = this.confirmedCloudChats();
    const snapshots = [...confirmed.values()];
    return {
      type: "WORKSPACE_RESPONSE", op: wire.op, result: {
        ...result, confirmedLocalChats: confirmedLocal,
        confirmedCloudWorkspaces: [...confirmed.keys()],
        chats: [...(Array.isArray(result.chats) ? result.chats : []),
          ...snapshots.flatMap(s => Array.isArray(s.chats) ? s.chats : [])],
        chatDeletions: [...(Array.isArray(result.chatDeletions) ? result.chatDeletions : []),
          ...snapshots.flatMap(s => Array.isArray(s.chatDeletions) ? s.chatDeletions : [])],
      },
    } as unknown as BridgeMessage;
  }

  async chatSnapshot(refresh: ChatSnapshotRefresh): Promise<WireRecord> {
    const response = await this.aggregateList({ type: "WORKSPACE_REQUEST", op: "chats.list" } as Message, 10_000, refresh);
    return record((response as unknown as WireRecord).result);
  }

  async warmWorkspace(target: CloudWorkspaceTarget, options?: { intent: boolean }): Promise<void> {
    const key = cloudWorkspaceKey(target);
    if (options?.intent) this.rememberHistoryIntent(target);
    if (options?.intent && !this.peers.has(key) && !this.opening.has(key)) {
      // Speculation owns at most four sockets, and never evicts a selected or
      // executing peer. A click promotes its in-flight connection synchronously.
      while (this.speculative.size >= 4) this.discardSpeculative(this.speculative.keys().next().value!);
      this.speculative.set(key, setTimeout(() => this.discardSpeculative(key), 15_000));
    } else if (!options?.intent) this.claimPeer(key);
    await this.peer(target);
  }

  /** Presence is receive-only lifecycle evidence on an existing admission.
   * Never open/refresh a peer or enqueue across a disconnected transport. */
  sendWorkspacePresence(target: CloudWorkspaceTarget, present: boolean): boolean {
    const peer = this.peers.get(cloudWorkspaceKey(target));
    if (this.closed || !peer || peer.retired || peer.identity !== this.identity(target) ||
        peer.client.status !== "connected" || this.routing.canAccess?.(target) === false) return false;
    void peer.client.request({ type: "WORKSPACE_REQUEST", op: "cloudPresence.update", params: { present } }, 5_000).catch(() => {});
    return true;
  }

  /** Explicit navigation and message preparation share one wake/admission.
   * Each caller owns cancellation; a navigation away cannot cancel a send. */
  async openWorkspace(target: CloudWorkspaceTarget, options?: { signal?: AbortSignal; reason?: "interaction" }): Promise<void> {
    const controller = new AbortController();
    const cancel = () => controller.abort(options?.signal?.reason);
    options?.signal?.addEventListener("abort", cancel, { once: true });
    if (options?.signal?.aborted) cancel();
    // Bound the whole intent, including native admission and retargeting N+1;
    // compute progress never starts a fresh short deadline at each stage.
    const safety = setTimeout(() => controller.abort(new Error("The cloud workspace is still starting after fifteen minutes. Try again when it is ready.")), 15 * 60_000);
    try { await this.openWorkspaceIntent(target, { signal: controller.signal, reason: options?.reason }); }
    finally { clearTimeout(safety); options?.signal?.removeEventListener("abort", cancel); }
  }

  private async openWorkspaceIntent(target: CloudWorkspaceTarget, options: { signal: AbortSignal; reason?: "interaction" }): Promise<void> {
    const cancelled = () => options.signal.reason instanceof Error && options.signal.reason.name !== "AbortError"
      ? options.signal.reason : new Error("Cloud workspace open cancelled");
    const key = cloudWorkspaceKey(target);
    const identity = this.identity(target);
    const pending = this.opening.get(key);
    const requestedOwner = this.routing.wakeOwner?.(target);
    const owner = pending?.wake && pending.owner && requestedOwner &&
      pending.owner.account === requestedOwner.account && pending.owner.stopVersion === requestedOwner.stopVersion
      ? pending.owner : requestedOwner;
    const epoch = this.accountEpoch;
    const current = () => epoch === this.accountEpoch && (owner
      ? this.continuesWake(target, owner) : identity === this.identity(target));
    this.claimPeer(key);
    const open = () => {
      if (options.signal.aborted) return Promise.reject(cancelled());
      if (!current()) return Promise.reject(new Error("Cloud account changed while connecting"));
      const promise = this.peer(target, true, options?.reason, owner);
      const flight = this.opening.get(key);
      if (flight) flight.consumers++;
      return new Promise<PeerEntry>((resolve, reject) => {
        let settled = false;
        const finish = (cancelled: boolean) => {
          if (settled) return false;
          settled = true;
          options?.signal?.removeEventListener("abort", abort);
          if (flight && --flight.consumers === 0 && cancelled) {
            flight.controller.abort();
            if (this.opening.get(key) === flight) this.opening.delete(key);
            this.workspaceStatusChanged(key);
          }
          return true;
        };
        const abort = () => {
          if (finish(true)) reject(cancelled());
        };
        options?.signal?.addEventListener("abort", abort, { once: true });
        if (options?.signal?.aborted) abort();
        promise.then(value => { if (finish(false)) resolve(value); }, error => { if (finish(false)) reject(error); });
      });
    };
    if (pending?.identity === identity && !pending.wake) {
      // Even a successful passive attachment did not serialize with capture.
      // Await it, then prepare explicitly; never retry a submitted command.
      try { await open(); }
      catch (error) {
        if (options?.signal?.aborted || !current()) throw error;
      }
    }
    let generation = owner?.generation;
    let retargetVersion = owner?.retargetVersion ?? 0;
    let retiredAdmission: number | undefined;
    for (;;) {
      try { await open(); return; }
      catch (error) {
        const next = this.routing.wakeOwner?.(target);
        // Admission for N can lose to N+1 or a rollback. Dispose the old peer and
        // retarget the still-undispatched intent; never retry any command here.
        const admitted = error instanceof CloudAdmissionGenerationChangedError ? error.generation : undefined;
        // N -> N+1 -> N can finish at the original number while a late N+1
        // admission arrives. Retire it and re-admit; bound duplicate stale replies.
        if (options?.signal?.aborted || !current() || !this.continuesWake(target, owner) || !next || generation === undefined ||
            next.generation === generation && (owner?.retargetVersion ?? 0) === retargetVersion &&
              (admitted === undefined || admitted === next.generation || admitted === retiredAdmission)) throw error;
        retiredAdmission = admitted;
        generation = next.generation;
        retargetVersion = owner?.retargetVersion ?? 0;
      }
    }
  }

  async warmHistoryWorkspace(target: CloudWorkspaceTarget, options?: { intent: boolean }): Promise<void> {
    if (!this.routing.readHistory) return;
    if (options?.intent) this.rememberHistoryIntent(target);
    await this.warmHistorySnapshot(target);
  }

  private rememberHistoryIntent(target: CloudWorkspaceTarget): void {
    const now = performance.now();
    for (const [key, expires] of this.historyIntents) if (expires < now) this.historyIntents.delete(key);
    const key = this.historyKey(target, "chats.list", {});
    this.historyIntents.delete(key);
    this.historyIntents.set(key, now + 15_000);
    while (this.historyIntents.size > 32) this.historyIntents.delete(this.historyIntents.keys().next().value!);
  }

  private identity(target: CloudWorkspaceTarget): string {
    return `${this.accountEpoch}:${this.routing.identity?.(target) ?? ""}`;
  }

  private warmHistorySnapshot(target: CloudWorkspaceTarget): Promise<WireRecord> {
    const key = cloudWorkspaceKey(target);
    const historyKey = this.historyKey(target, "chats.list", {});
    const pending = this.historyWarmups.get(historyKey);
    if (pending) return pending;
    if (this.historyWarmups.size >= 32) return Promise.reject(new Error("Too many cloud history reads"));
    const before = this.history.peekSnapshot(historyKey).data;
    const flight = this.readHistory(target, "chats.list", {}).then(snapshot => {
      // Catalog polling is not a database change. Repeated warm reads must not
      // invalidate every retained transcript, file and Git surface.
      if (snapshot !== before && this.history.peekSnapshot(historyKey).data === snapshot)
        this.changed(key, ["chats", "messages"]);
      return snapshot;
    }).finally(() => {
      if (this.historyWarmups.get(historyKey) === flight) this.historyWarmups.delete(historyKey);
    });
    this.historyWarmups.set(historyKey, flight);
    return flight;
  }

  private historyKey(target: CloudWorkspaceTarget, op: string, params: WireRecord): string {
    return `${cloudWorkspaceKey(target)}\0${this.identity(target)}\0${op}\0${JSON.stringify(params)}`;
  }
  private captureHistoryRestore(target: CloudWorkspaceTarget): CloudHistoryRestoreTicket | null {
    return this.historyRestore.capture({ accountId: String(this.accountEpoch),
      organizationId: target.organizationId, workspaceId: target.workspaceId });
  }
  private historyMetadata(value: WireRecord): CloudHistoryRestoreMetadata | null {
    return value.projection === undefined && value.historyHeads === undefined ? null
      : CloudHistoryRestoreMetadataSchema.parse({ projection: value.projection, historyHeads: value.historyHeads });
  }
  private historyConversations(op: string, params: WireRecord, value: WireRecord): string[] {
    const ids = new Set<string>();
    const add = (id: unknown) => {
      const scoped = parseCloudScopedId(id);
      if (scoped) ids.add(scoped.id);
    };
    add(params.chatId);
    if (op === "chats.list") {
      for (const row of Array.isArray(value.chats) ? value.chats : []) add(record(row).id);
      for (const id of Array.isArray(value.chatDeletions) ? value.chatDeletions : []) add(id);
    }
    if (op === "messages.search") for (const row of Array.isArray(value.hits) ? value.hits : []) add(record(row).chatId);
    return [...ids];
  }
  private installHistoryRestore(target: CloudWorkspaceTarget, ticket: CloudHistoryRestoreTicket,
    metadata: CloudHistoryRestoreMetadata, conversations: readonly string[]): void {
    const changed = this.historyRestore.install(ticket, metadata, conversations);
    if (!changed.length) return;
    const ids = new Set(changed.map(head => head.conversationId)), prefix = `${cloudWorkspaceKey(target)}\0`;
    for (const key of this.history.keys()) {
      if (!key.startsWith(prefix)) continue;
      const parts = key.split("\0");
      // A proven live engine is a separate lineage. CP restore revisions cannot
      // retire its native transcript or stream merely because they are larger.
      if (parts.slice(4).some(part => part.startsWith("runtime:"))) continue;
      const op = parts[2], params = record(JSON.parse(parts[3] ?? "{}"));
      const chat = parseCloudScopedId(params.chatId);
      if (op === "chats.list" || op === "messages.search" && (!chat || ids.has(chat.id)) || chat && ids.has(chat.id))
        this.history.forget(key);
    }
    this.changed(cloudWorkspaceKey(target), ["chats", "messages"]);
  }

  private captureNativeHistoryRestore(entry: PeerEntry): CloudHistoryRestoreTicket | null {
    return this.nativeHistoryRestore.capture({ accountId: String(this.accountEpoch),
      organizationId: entry.scope.organizationId, workspaceId: entry.scope.workspaceId });
  }
  private installNativeHistoryRestore(entry: PeerEntry, ticket: CloudHistoryRestoreTicket,
    metadata: CloudHistoryRestoreMetadata, conversations: readonly string[]): void {
    this.assertCurrent(entry);
    const binding = this.cloudAgentBootBinding(cloudWorkspaceKey(entry.scope));
    if (!binding || (["organizationId", "workspaceId", "generation", "engineInstanceId", "bootId", "writerEpoch",
      "fundingOwnerUserId", "fundingOwnerEpoch"] as const).some(key => binding[key] !== metadata.projection[key]) ||
        metadata.historyHeads.some(head => !conversations.includes(head.conversationId)))
      throw new Error("Live cloud restore belongs to another admitted writer or page.");
    const changed = this.nativeHistoryRestore.install(ticket, metadata, conversations);
    this.nativeHistoryRestore.assertResult(ticket, metadata, conversations);
    if (changed.length) {
      const ids = new Set(changed.map(head => head.conversationId)), prefix = `${cloudWorkspaceKey(entry.scope)}\0`;
      for (const key of this.history.keys()) {
        if (!key.startsWith(prefix)) continue;
        const parts = key.split("\0"), op = parts[2], params = record(JSON.parse(parts[3] ?? "{}"));
        const chat = parseCloudScopedId(params.chatId);
        if (op === "chats.list" || op === "messages.search" && (!chat || ids.has(chat.id)) || chat && ids.has(chat.id)) this.history.forget(key);
      }
    }
    // The independently verified live binding installs memory/disk/visible
    // fences synchronously before the optional durable-cache I/O awaits.
    // CP projection revisions and VM record/event cursors remain independent.
    const cacheTicket = captureCloudHistoryRestoreRead(entry.scope);
    void installCloudHistoryRestoreMetadata(entry.scope, metadata, conversations, cacheTicket, "native").catch(() => {});
    // Optional disk persistence may fail later. Original head validation must
    // still succeed synchronously before a snapshot or page can be forwarded.
    assertCloudHistoryRestoreResult(cacheTicket, metadata, conversations);
  }

  private async readHistory(target: CloudWorkspaceTarget, op: string, params: WireRecord): Promise<WireRecord> {
    const epoch = this.accountEpoch;
    const identity = this.identity(target);
    const assertAccess = () => {
      if (this.closed || epoch !== this.accountEpoch || identity !== this.identity(target) || (this.routing.canAccess && !this.routing.canAccess(target)))
        throw new Error("Cloud history access changed");
    };
    assertAccess();
    const restoreRead = this.captureHistoryRestore(target);
    const key = cloudWorkspaceKey(target);
    const attached = this.peers.get(key);
    const peer = attached && (op === "messages.window" || op === "messages.windowOlder" || this.cloudAgentBootBinding(key)) &&
      attached.identity === identity && !attached.retired && attached.client.status === "connected"
      ? attached : undefined;
    const nativeRead = peer ? this.captureNativeHistoryRestore(peer) : null;
    const globalNativeRead = peer ? captureCloudHistoryRestoreRead(target) : null;
    // Cloud-owned records remain readable without a worker. An already attached
    // worker has the newer normalized transcript while its cloud projection is
    // committing a turn; never overwrite streamed text with that older copy.
    // Separate cache identities also prevent a cold read from winning on attach.
    const cacheKey = this.historyKey(target, op, params) + (peer ? `\0runtime:${peer.runtimeId}` : "");
    const snapshot = await this.history.load(cacheKey, async () => {
      assertAccess();
      let result: WireRecord;
      if (peer) {
        this.assertCurrent(peer);
        const response = await peer.client.request(cloudOutgoing(peer.scope, {
          type: "WORKSPACE_REQUEST", op, params,
        }) as Message);
        this.assertCurrent(peer);
        const rows = op === "chats.list" ? "chats" : op === "messages.search" ? "hits" : "messages";
        if (response.type !== "WORKSPACE_RESPONSE" || !Array.isArray(record(record(response).result)[rows]))
          throw cloudHistoryReadError(response, "Could not read the current cloud transcript");
        result = record(cloudIncoming(peer.scope, response as unknown as WireRecord).result);
        const metadata = this.historyMetadata(result);
        if (metadata && nativeRead) this.installNativeHistoryRestore(peer, nativeRead, metadata, this.historyConversations(op, params, result));
        else if (this.cloudAgentBootBinding(key)) throw new Error("Live cloud restore is missing its current head.");
      } else {
        result = await this.routing.readHistory!(target, op, params);
        const metadata = this.historyMetadata(result);
        if (metadata && restoreRead) this.installHistoryRestore(target, restoreRead, metadata, this.historyConversations(op, params, result));
      }
      assertAccess();
      if (op === "chats.list") {
        const previous = this.history.peekSnapshot(this.historyKey(target, op, params)).data;
        if (previous && !this.historyMetadata(result) && !this.historyMetadata(previous) &&
            typeof result.revision === "number" && previous.revision === result.revision) return previous;
        if (previous && JSON.stringify(previous) === JSON.stringify(result)) return previous;
      }
      return result;
    }, { maxAgeMs: (this.historyIntents.get(cacheKey) ?? -1) >= performance.now() ? 15_000 : 1000 });
    assertAccess();
    if (peer && nativeRead) {
      this.assertCurrent(peer);
      const metadata = this.historyMetadata(snapshot);
      if (metadata) this.nativeHistoryRestore.assertResult(nativeRead, metadata, this.historyConversations(op, params, snapshot));
      else if (this.cloudAgentBootBinding(key)) throw new Error("Live cloud restore is missing its current head.");
      // Cached pages and shared flights may skip the loader's publication.
      // Recheck their original global head before returning any native rows.
      assertCloudHistoryRestoreResult(globalNativeRead, metadata, this.historyConversations(op, params, snapshot));
      if (metadata && this.history.peekSnapshot(cacheKey).data !== snapshot) this.history.setData(cacheKey, snapshot);
    }
    if (!peer && restoreRead) {
      const metadata = this.historyMetadata(snapshot);
      // KeyedAsyncCache fences replacement, but still returns a retired
      // fetch's value to its caller. Check its exact immutable head again here.
      this.historyRestore.assertResult(restoreRead, metadata, this.historyConversations(op, params, snapshot));
      if (metadata && this.history.peekSnapshot(cacheKey).data !== snapshot) this.history.setData(cacheKey, snapshot);
    }
    // A cold projection may finish after a user attaches the newer runtime.
    // Reuse that peer; never open/wake one to reconcile a passive history read.
    const currentPeer = this.peers.get(key);
    if (!peer && (op === "messages.window" || op === "messages.windowOlder" || this.cloudAgentBootBinding(key)) && currentPeer &&
        currentPeer.identity === identity && !currentPeer.retired && currentPeer.client.status === "connected")
      return this.readHistory(target, op, params);
    if (op === "chats.list") {
      this.historyWorkspaces.delete(key);
      this.historyWorkspaces.set(key, target);
      while (this.historyWorkspaces.size > 32) this.historyWorkspaces.delete(this.historyWorkspaces.keys().next().value!);
    }
    return snapshot;
  }

  /** Passive CP checkpoint; call only for a terminal turn or chat departure.
   * It never connects, wakes, or delays the authoritative native response. */
  checkpointCloudTranscript(chatId: string): void {
    if (!this.routing.checkpointHistory || !this.routing.readHistory || this.closed) return;
    let target: ReturnType<typeof parseCloudScopedId>;
    try { target = parseCloudScopedId(chatId); } catch { return; }
    if (!target || this.routing.canAccess && !this.routing.canAccess(target)) return;
    const epoch = this.accountEpoch, identity = this.identity(target);
    const params = { chatId, limit: 200 };
    const key = `${this.historyKey(target, "messages.window", params)}\0projection-checkpoint`;
    const attemptKey = JSON.stringify([epoch, cloudWorkspaceKey(target), target.id]);
    const now = performance.now();
    // Attempt timestamps are separate from payload retention/invalidation:
    // DB_CHANGED, generation changes, failures and eviction cannot reset it.
    for (const [oldKey, attempt] of this.projectionCheckpoints)
      if (!attempt.pending && attempt.until <= now) this.projectionCheckpoints.delete(oldKey);
    if (this.projectionCheckpoints.has(attemptKey) || this.projectionCheckpoints.size >= 64) return;
    const attempt = { until: now + 30_000, pending: true };
    this.projectionCheckpoints.set(attemptKey, attempt);
    const assertAccess = () => {
      if (this.closed || epoch !== this.accountEpoch || identity !== this.identity(target) ||
          this.routing.canAccess && !this.routing.canAccess(target)) throw new Error("Cloud history access changed");
    };
    void this.history.load(key, async () => {
      assertAccess();
      const result = await this.routing.readHistory!(target, "messages.window", params);
      assertAccess();
      return result;
    }, { force: true }).catch(() => {}).finally(() => { attempt.pending = false; });
  }

  private invalidateHistory(target: CloudWorkspaceTarget): void {
    const prefix = `${cloudWorkspaceKey(target)}\0`;
    for (const key of this.history.keys()) if (key.startsWith(prefix)) this.history.invalidate(key);
  }

  hasChatSnapshot(folder: string): boolean {
    const target = parseCloudWorkspaceKey(folder);
    return !!target && (this.history.peekSnapshot(this.historyKey(target, "chats.list", {})).data !== undefined ||
      this.peers.get(cloudWorkspaceKey(target))?.hasChatSnapshot === true);
  }

  hasCloudMessageSnapshot(chatId: string, limit: number): boolean {
    const target = parseCloudScopedId(chatId);
    if (!target || this.closed || this.routing.canAccess && !this.routing.canAccess(target)) return false;
    const entry = this.peers.get(cloudWorkspaceKey(target));
    const peer = entry && entry.identity === this.identity(target) && !entry.retired && entry.client.status === "connected" ? entry : null;
    const key = this.historyKey(target, "messages.window", { chatId, limit }) + (peer ? `\0runtime:${peer.runtimeId}` : "");
    return this.history.peekSnapshot(key).data !== undefined;
  }

  /** Existing current peer only. CP mirror revisions and disk cache cannot
   * prove this native transcript lineage, and this never opens a connection. */
  hasCloudNativeTranscript(chatId: string, executionId: string | null | undefined, limit: number): boolean {
    const target = parseCloudScopedId(chatId);
    if (!target || this.closed || this.routing.canAccess && !this.routing.canAccess(target)) return false;
    const entry = this.peers.get(cloudWorkspaceKey(target));
    if (!entry || entry.retired || entry.identity !== this.identity(target) || entry.client.status !== "connected") return false;
    const execution = executionId ? parseCloudScopedId(executionId) : null;
    if (execution && execution.organizationId === target.organizationId && execution.workspaceId === target.workspaceId &&
        entry.agents?.hasCurrentExecution(target.id, execution.id)) return true;
    const key = this.historyKey(target, "messages.window", { chatId, limit }) + `\0runtime:${entry.runtimeId}`;
    return this.history.peekSnapshot(key).data !== undefined;
  }

  statusForWorkspace(folder?: string | null): ConnectionStatus {
    const target = parseCloudWorkspaceKey(folder);
    if (!target) return this.status;
    const key = cloudWorkspaceKey(target);
    if (this.opening.has(key)) return "connecting";
    const entry = this.peers.get(key);
    return entry && !entry.retired ? entry.client.status : "disconnected";
  }

  /** Cached presentation identity from a connected, actor-confirmed peer.
   * Does not open, wake, read CP state, or authorize an agent command. */
  cloudAgentBootBinding(folder: string): CloudAgentBootConversation | null {
    const target = parseCloudWorkspaceKey(folder);
    if (!target || this.closed || this.routing.canAccess?.(target) === false) return null;
    const entry = this.peers.get(cloudWorkspaceKey(target));
    if (!entry || entry.retired || entry.epoch !== this.accountEpoch || entry.identity !== this.identity(target) ||
        entry.client.status !== "connected") return null;
    const binding = entry.client.activatedCloudAgentBootBinding;
    const identity = entry.client.executionIdentity;
    if (!binding || !identity || identity.kind !== "cloud" || !identity.bootScope ||
        binding.organizationId !== target.organizationId || binding.workspaceId !== target.workspaceId ||
        binding.authorityEpoch !== identity.authorityEpoch ||
        Object.entries(identity.bootScope).some(([key, value]) => binding[key as keyof CloudAgentBootConversation] !== value)) return null;
    return binding;
  }

  /** Safe metadata from an already admitted peer. Does not connect or adopt. */
  cloudResourceUsageConnection(folder: string): CloudResourceUsageConnection | null {
    const target = parseCloudWorkspaceKey(folder);
    if (!target) return null;
    const entry = this.peers.get(cloudWorkspaceKey(target));
    if (!entry || entry.retired || entry.epoch !== this.accountEpoch || !entry.runtimeId ||
        entry.identity !== this.identity(target) || this.routing.canAccess?.(target) === false) return null;
    const identity = entry.client.executionIdentity;
    if (identity?.kind !== "cloud" || identity.organizationId !== target.organizationId ||
        identity.workspaceId !== target.workspaceId || entry.generation !== identity.generation) return null;
    return { organizationId: target.organizationId, workspaceId: target.workspaceId,
      generation: identity.generation, engineInstanceId: identity.engineInstanceId,
      authorityEpoch: identity.authorityEpoch, admissionId: entry.runtimeId };
  }

  async requestCloudResourceUsage(target: CloudWorkspaceTarget, expected: CloudResourceUsageConnection): Promise<BridgeMessage | null> {
    const key = cloudWorkspaceKey(target);
    const entry = this.peers.get(key);
    const assertConnected = () => {
      if (!entry || entry.client.status !== "connected") throw new Error("Cloud workspace is disconnected");
      this.assertCurrent(entry);
      const current = this.cloudResourceUsageConnection(key);
      if (!current || (["organizationId", "workspaceId", "generation", "engineInstanceId", "authorityEpoch", "admissionId"] as const)
        .some(field => current[field] !== expected[field]))
        throw new Error("Cloud resource usage admission changed");
    };
    assertConnected();
    if (!entry!.client.supportsEngineCapability(WORKSPACE_RESOURCE_USAGE_CAPABILITY)) return null;
    const response = await entry!.client.requestConnected(cloudOutgoing(entry!.scope, {
      type: "WORKSPACE_REQUEST", op: "workspace.resourceUsage",
      params: { workspaceId: key, generation: expected.generation, engineInstanceId: expected.engineInstanceId },
    }) as Message, 5000);
    assertConnected();
    return cloudIncoming(entry!.scope, response as unknown as WireRecord) as unknown as BridgeMessage;
  }

  /** Renderer-only shell continuity. Admission IDs change on reconnect; only
   * a different engine instance proves that the old PTY registry was reset. */
  cloudEngineInstanceId(folder: string): string | undefined {
    const target = parseCloudWorkspaceKey(folder);
    if (!target) return undefined;
    const entry = this.peers.get(cloudWorkspaceKey(target));
    if (!entry || entry.retired || entry.identity !== this.identity(target)) return undefined;
    const identity = entry.client.executionIdentity;
    return identity?.kind === "cloud" ? identity.engineInstanceId : undefined;
  }

  onWorkspaceStatusChange(folder: string, listener: () => void): () => void {
    const target = parseCloudWorkspaceKey(folder);
    if (!target) return this.onStatusChange(listener);
    const key = cloudWorkspaceKey(target);
    const listeners = this.workspaceStatusListeners.get(key) ?? new Set();
    listeners.add(listener);
    this.workspaceStatusListeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.workspaceStatusListeners.delete(key);
    };
  }

  private workspaceStatusChanged(key: string): void {
    for (const listener of this.workspaceStatusListeners.get(key) ?? [])
      listener();
  }

  private emit(type: string, message: WireRecord): void {
    for (const handler of this.routedHandlers.get(type) ?? [])
      handler(message as unknown as BridgeMessage);
  }

  private attach(entry: PeerEntry, type: string): void {
    if (entry.unsubscribers.has(type)) return;
    entry.unsubscribers.set(
      type,
      (entry.events ?? entry.client).on(type, (message) => {
        if (
          entry.retired ||
          entry.identity !== this.identity(entry.scope) ||
          entry.epoch !== this.accountEpoch ||
          this.peers.get(cloudWorkspaceKey(entry.scope)) !== entry
        )
          return;
        if (this.routing.canAccess && !this.routing.canAccess(entry.scope))
          return;
        const wire = message as unknown as WireRecord;
        const restoreValue = type === "DB_CHANGED" ? wire.cloudHistoryRestore : record(wire.cloudSnapshot).historyRestore;
        if (restoreValue !== undefined) {
          try {
            const metadata = CloudHistoryRestoreMetadataSchema.parse(restoreValue), ticket = this.captureNativeHistoryRestore(entry);
            const ids = type === "DB_CHANGED" ? (Array.isArray(wire.chatIds) ? wire.chatIds.filter((id): id is string => typeof id === "string") : [])
              : typeof record(wire.cloudSnapshot).conversationId === "string" ? [record(wire.cloudSnapshot).conversationId as string] : [];
            if (!ticket) return;
            this.installNativeHistoryRestore(entry, ticket, metadata, ids);
          } catch { return; }
        }
        if (type === "CLOUD_AGENT_CREDENTIAL_USED") {
          const binding = this.cloudAgentBootBinding(cloudWorkspaceKey(entry.scope));
          const use = record(wire.use), source = record(use.scope);
          const scope = CloudAgentBootIdentitySchema.safeParse(source);
          const identity = entry.client.executionIdentity;
          if (!binding || !scope.success || identity?.kind !== "cloud" || !identity.bootScope ||
              Object.entries(source).some(([key, value]) => binding[key as keyof CloudAgentBootConversation] !== value)) return;
        }

        if (type === "DB_CHANGED") {
          this.invalidateHistory(entry.scope);
          if (this.routing.readHistory && Array.isArray(wire.kinds) && wire.kinds.includes("chats"))
            void this.readChats(entry).then(() => this.changed(cloudWorkspaceKey(entry.scope))).catch(() => {});
        }
        // An agent-wide exit on one engine cannot retire local or other cloud
        // conversations that happen to use the same provider.
        if (
          type === "AGENT_AGENT_EXITED" &&
          !wire.sessionId &&
          !wire.executionId
        )
          return;
        const incoming = entry.agents ? entry.agents.incoming(wire) : wire;
        if (incoming) this.emit(type, cloudIncoming(entry.scope, incoming));
      }),
    );
  }

  private peer(target: CloudWorkspaceTarget, wake = false, reason?: "interaction", intentOwner?: WakeOwner): Promise<PeerEntry> {
    if (this.routing.canAccess && !this.routing.canAccess(target))
      return Promise.reject(
        new Error(
          "Cloud workspace access has not been confirmed for this account",
        ),
      );
    const key = cloudWorkspaceKey(target);
    let identity = this.identity(target);
    const owner = wake ? intentOwner ?? this.routing.wakeOwner?.(target) : undefined;
    const pending = this.opening.get(key);
    if (pending && (pending.identity === identity || pending.wake && this.continuesWake(target, pending.owner))) return pending.promise;
    if (pending) {
      pending.controller.abort();
      this.opening.delete(key);
    }
    const existing = this.peers.get(key);
    const connected = existing && existing.identity === identity && !existing.retired && existing.client.status === "connected";
    if (connected && !wake)
      return Promise.resolve(existing);
    if (this.closed)
      return Promise.reject(new Error("Workspace connections are closed"));
    // Bound sockets and their replay buffers; never evict a potentially live
    // conversation merely because another workspace gained focus.
    if (this.ongoingOpens >= 16 || (!existing && this.peers.size + this.ongoingOpens >= 16))
      return Promise.reject(
        new Error(
          "Too many cloud workspace connections are open. Reopen Zeros to reconnect the workspaces you need.",
        ),
      );
    // A stopped/replaced engine can leave its old admission reconnecting.
    // New work obtains fresh authority once per exact workspace. Preserve the
    // confirmed snapshot while retiring its transport; never replay a request
    // whose previous connection may already have executed it.
    const reusable = connected && wake && existing.prepareForRun ? existing : undefined;
    if (existing && !reusable) this.retirePeer(existing);
    const epoch = this.accountEpoch;
    const controller = new AbortController();
    // Publish durable history independently, including while admission/connect
    // is slow. Keep this exact read for initial hydration even after its TTL.
    const history = this.routing.readHistory ? this.warmHistorySnapshot(target) : undefined;
    void history?.catch(() => {});
    // Cancelled native IPC can still be awaiting its reply. Count it until it
    // settles so sweeping the pointer cannot grow an unbounded admission queue.
    this.ongoingOpens++;
    let opening: Promise<CloudPeer>;
    try {
      opening = reusable
        ? reusable.prepareForRun!(controller.signal, reason).then(ready => {
            if (controller.signal.aborted) throw new Error("Cloud workspace open cancelled");
            if (ready && !reusable.retired && reusable.client.status === "connected") return reusable;
            this.retirePeer(reusable);
            // Preparation already crossed the capture barrier. Re-admit only;
            // a newer Stop must win instead of triggering another wake.
            return this.routing.open(target, { signal: controller.signal });
          })
        : this.routing.open(target, { signal: controller.signal, ...(wake ? { wake: true, ...(reason ? { reason } : {}) } : {}) });
    }
    catch (error) { this.ongoingOpens--; return Promise.reject(error); }
    const flight = opening
      .then(async (opened) => {
        if (owner && opened.generation !== undefined && opened.generation !== this.routing.wakeOwner?.(target)?.generation) {
          if (opened === reusable) this.retirePeer(reusable); else opened.release();
          throw new CloudAdmissionGenerationChangedError(opened.generation);
        }
        if (wake && this.continuesWake(target, owner)) identity = this.identity(target);
        if (
          epoch !== this.accountEpoch ||
          (owner && !this.continuesWake(target, owner)) ||
          controller.signal.aborted || identity !== this.identity(target) ||
          this.closed ||
          (this.routing.canAccess && !this.routing.canAccess(target))
        ) {
          if (opened !== reusable) opened.release();
          throw new Error("Cloud account changed while connecting");
        }
        if (opened === reusable) { this.assertCurrent(reusable); return reusable; }
        if (cloudWorkspaceKey(opened.scope) !== key) {
          opened.release();
          throw new Error("Cloud connection returned a different workspace");
        }
        opened.agents?.restoreAttachments(existing?.attachments ?? []);
        const entry: PeerEntry = {
          ...opened,
          epoch,
          identity,
          snapshotRevision: 0,
          unsubscribers: new Map(),
          stopStatus: () => {},
          snapshot: existing?.snapshot ?? { chats: [], chatDeletions: [] },
          hasChatSnapshot: existing?.hasChatSnapshot ?? false,
          retired: false,
        };
        this.peers.set(key, entry);
        for (const type of this.routedHandlers.keys()) this.attach(entry, type);
        entry.stopStatus = entry.client.onStatusChange((status) => {
          if (!entry.retired && status === "disconnected" && entry.client.lastRejection) this.retirePeer(entry);
          this.workspaceStatusChanged(key);
          if (entry.retired || status !== "connected" || epoch !== this.accountEpoch) return;
          void this.readChats(entry)
            .then(() => this.changed(key))
            .catch(() => {});
        });
        // Read before writes. A stale device boot cache cannot recreate a deleted
        // chat or overwrite a newer title on its first cloud attachment.
        try {
          await this.readChats(entry, history);
          if (controller.signal.aborted || epoch !== this.accountEpoch || identity !== this.identity(target))
            throw new Error("Cloud connection cancelled or changed while connecting");
          this.assertCurrent(entry);
        } catch (error) {
          if (this.peers.get(key) === entry) {
            this.retirePeer(entry);
            if (!entry.hasChatSnapshot) this.peers.delete(key);
            this.workspaceStatusChanged(key);
          }
          throw error;
        }
        if (epoch !== this.accountEpoch)
          throw new Error("Cloud account changed while connecting");
        this.changed(key);
        this.workspaceStatusChanged(key);
        void entry.agents?.refreshAttachments();
        return entry;
      })
      .finally(() => {
        this.ongoingOpens--;
        if (this.opening.get(key)?.promise === flight) this.opening.delete(key);
        this.workspaceStatusChanged(key);
      });
    this.opening.set(key, { promise: flight, identity, target, controller, wake, consumers: 0, owner });
    this.workspaceStatusChanged(key);
    return flight;
  }

  private changed(key: string, kinds = ["chats", "messages", "workspaces", "git", "files"]): void {
    this.emit("DB_CHANGED", {
      type: "DB_CHANGED",
      kinds,
      workspaceId: key,
      workspaceIds: [key],
      cloudWorkspace: key,
    });
  }

  private async readChats(entry: PeerEntry, warming?: Promise<WireRecord>): Promise<WireRecord> {
    this.assertCurrent(entry);
    const revision = ++entry.snapshotRevision;
    if (this.routing.readHistory && !this.cloudAgentBootBinding(cloudWorkspaceKey(entry.scope))) {
      const snapshot = await (warming ?? this.readHistory(entry.scope, "chats.list", {}));
      this.assertCurrent(entry);
      if (revision === entry.snapshotRevision) {
        entry.snapshot = snapshot;
        entry.hasChatSnapshot = true;
      }
      return entry.snapshot;
    }
    const response = await entry.client.request({
      type: "WORKSPACE_REQUEST",
      op: "chats.list",
      params: {},
    } as Message);
    if (response.type !== "WORKSPACE_RESPONSE" ||
        !Array.isArray(record(record(response).result).chats))
      throw cloudHistoryReadError(response, "Could not read cloud conversations");
    if (entry.epoch !== this.accountEpoch)
      throw new Error("Cloud account changed");
    this.assertCurrent(entry);
    const next = cloudIncoming(entry.scope, response as unknown as WireRecord);
    const metadata = this.historyMetadata(record(next.result)), ticket = this.captureNativeHistoryRestore(entry);
    if (metadata && ticket) this.installNativeHistoryRestore(entry, ticket, metadata, this.historyConversations("chats.list", {}, record(next.result)));
    else if (this.cloudAgentBootBinding(cloudWorkspaceKey(entry.scope))) throw new Error("Live cloud restore is missing its current head.");
    if (revision === entry.snapshotRevision) {
      const snapshot = record(next.result);
      if (JSON.stringify(entry.snapshot) !== JSON.stringify(snapshot)) entry.snapshot = snapshot;
      entry.hasChatSnapshot = true;
    }
    return entry.snapshot;
  }

  private assertCurrent(entry: PeerEntry): void {
    if (entry.retired || entry.identity !== this.identity(entry.scope) || this.peers.get(cloudWorkspaceKey(entry.scope)) !== entry)
      throw new Error("Cloud connection changed while the request was running");
  }

  private async cloudRequest(
    target: CloudWorkspaceTarget,
    message: Message,
    options: number | RequestOptions,
  ): Promise<BridgeMessage> {
    if (this.routing.readHistory && message.type === "WORKSPACE_REQUEST") {
      const wire = message as unknown as WireRecord;
      if (["chats.list", "messages.window", "messages.windowOlder", "messages.search"].includes(String(wire.op)))
        return { type: "WORKSPACE_RESPONSE", op: wire.op,
          result: await this.readHistory(target, String(wire.op), wire.op === "chats.list" ? {} : record(wire.params)),
        } as unknown as BridgeMessage;
    }
    this.claimPeer(cloudWorkspaceKey(target));
    const entry = await this.peer(target);
    if (entry.epoch !== this.accountEpoch)
      throw new Error("Cloud account changed before dispatch");
    this.assertCurrent(entry);
    const native = cloudOutgoing(entry.scope, message as unknown as WireRecord);
    if (native.type === "WORKSPACE_REQUEST" && isCloudGithubWriteOperation(native.op)) {
      if (!this.routing.prepareGithubWrite) throw new Error("GitHub write authorization is unavailable. Reconnect and try again.");
      const grant = await this.routing.prepareGithubWrite({ organizationId: target.organizationId, workspaceId: target.workspaceId }, native.op, record(native.params));
      if (entry.epoch !== this.accountEpoch) throw new Error("Cloud account changed before dispatch");
      this.assertCurrent(entry);
      if (typeof options !== "number" && options.signal?.aborted) throw new Error("GitHub write was canceled before dispatch");
      native.params = { ...record(native.params), $cloudGithubWriteGrant: grant };
    }
    const adapted = await entry.agents?.request(native, options);
    const response =
      adapted ??
      (await entry.client.request(
        (entry.agents?.outgoing(native) ?? native) as Message,
        options,
      ));
    if (message.type === "WORKSPACE_REQUEST") {
      const op = String((message as unknown as WireRecord).op);
      if (op.startsWith("chats.") || op.startsWith("messages.")) this.invalidateHistory(target);
    }
    if (entry.epoch !== this.accountEpoch)
      throw new Error("Cloud account changed before the response arrived");
    this.assertCurrent(entry);
    const mapped = entry.agents ? entry.agents.incoming(response as unknown as WireRecord) : response as unknown as WireRecord;
    if (!mapped) throw new Error("Cloud execution changed before the response arrived");
    const incoming = cloudIncoming(entry.scope, mapped);
    if (["AGENT_PROMPT_COMPLETE", "AGENT_PROMPT_FAILED"].includes(String(incoming.type)) && typeof incoming.chatId === "string")
      this.checkpointCloudTranscript(incoming.chatId);
    return incoming as unknown as BridgeMessage;
  }

  override async request<T extends BridgeMessage = BridgeMessage>(
    message: Message,
    options: number | RequestOptions = 5000,
  ): Promise<T> {
    const wire = message as unknown as WireRecord;
    const params = record(wire.params);
    if (
      wire.type === "WORKSPACE_REQUEST" &&
      wire.op === "chats.bulkUpsert" &&
      Array.isArray(params.chats)
    ) {
      const groups = new Map<
        string,
        { target: CloudWorkspaceTarget | null; rows: unknown[] }
      >();
      for (const chat of params.chats) {
        const target = cloudRequestTarget({ params: { chat } });
        const key = target ? cloudWorkspaceKey(target) : "local";
        const group = groups.get(key) ?? { target, rows: [] };
        group.rows.push(chat);
        groups.set(key, group);
      }
      // Each exact owner settles independently; a rejected cloud write must
      // not prevent a local draft/title from being saved.
      const results = await Promise.allSettled(
        [...groups.values()].map(async ({ target, rows }) => {
          if (target) {
            const entry = await this.peer(target);
            const deleted = new Set(
              (entry.snapshot.chatDeletions as string[]) ?? [],
            );
            const confirmed = new Map(
              ((entry.snapshot.chats as WireRecord[]) ?? []).map((row) => [
                row.id,
                row,
              ]),
            );
            rows = rows.filter((value) => {
              const row = record(value);
              const prior = confirmed.get(row.id);
              return (
                !deleted.has(String(row.id)) &&
                (!prior || Number(row.updatedAt) >= Number(prior.updatedAt))
              );
            });
          }
          const batch = {
            ...message,
            params: { ...params, chats: rows },
          } as Message;
          const response = target
            ? await this.cloudRequest(target, batch, options)
            : await super.request(batch, options);
          if (response.type === "WORKSPACE_ERROR")
            throw new Error("Could not save workspace conversations");
        }),
      );
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      return {
        type: "WORKSPACE_RESPONSE",
        op: wire.op,
        result: { ok: true },
      } as unknown as T;
    }
    const target = cloudRequestTarget(wire);
    if (wire.type === "WORKSPACE_REQUEST" && wire.op === "workspace.resourceUsage") {
      if (!target) throw new Error("Resource usage requires a cloud workspace");
      const expected = this.cloudResourceUsageConnection(cloudWorkspaceKey(target));
      if (!expected) throw new Error("Cloud workspace is disconnected");
      if (params.generation !== expected.generation || params.engineInstanceId !== expected.engineInstanceId)
        throw new Error("Cloud resource usage generation changed");
      return (await this.requestCloudResourceUsage(target, expected) ?? {
        type: "WORKSPACE_RESPONSE", op: wire.op, result: null,
      }) as T;
    }
    if (
      target &&
      wire.type === "WORKSPACE_REQUEST" &&
      [
        "workspace.archive",
        "workspace.delete",
        "workspace.restore",
        "workspace.recover",
      ].includes(String(wire.op))
    ) {
      if (!this.routing.manage)
        throw new Error("Cloud workspace management is unavailable");
      return {
        type: "WORKSPACE_RESPONSE",
        op: wire.op,
        result: await this.routing.manage(target, String(wire.op), record(wire.params)),
      } as unknown as T;
    }
    if (target) return (await this.cloudRequest(target, message, options)) as T;
    if (wire.type === "WORKSPACE_REQUEST" && ["chats.list", "workspace.list"].includes(String(wire.op)))
      return await this.aggregateList(message, options) as T;
    return super.request<T>(message, options);
  }

  override send(message: Message): void {
    const target = cloudRequestTarget(message as unknown as WireRecord);
    if (!target) {
      super.send(message);
      return;
    }
    const entry = this.peers.get(cloudWorkspaceKey(target));
    if (this.routing.canAccess && !this.routing.canAccess(target))
      throw new Error("Cloud workspace access changed");
    // Decisions/Stop must never be replayed later by opening a different
    // generation. The caller's ordinary disconnected-state recovery applies.
    if (!entry || entry.client.status !== "connected")
      throw new Error(
        "Cloud workspace is disconnected; reconnect before sending this action",
      );
    this.assertCurrent(entry);
    const native = cloudOutgoing(entry.scope, message as unknown as WireRecord);
    if (entry.agents?.send(native)) return;
    entry.client.send((entry.agents?.outgoing(native) ?? native) as Message);
  }

  override on(
    type: string,
    handler: (message: BridgeMessage) => void,
  ): () => void {
    const offLocal = type === "CLOUD_AGENT_CREDENTIAL_USED" ? () => {} : super.on(type, handler);
    const set = this.routedHandlers.get(type) ?? new Set();
    set.add(handler);
    this.routedHandlers.set(type, set);
    for (const entry of this.peers.values()) this.attach(entry, type);
    return () => {
      offLocal();
      set.delete(handler);
      if (set.size > 0) return;
      this.routedHandlers.delete(type);
      for (const entry of this.peers.values()) {
        entry.unsubscribers.get(type)?.();
        entry.unsubscribers.delete(type);
      }
    };
  }

  private retirePeer(entry: PeerEntry): void {
    if (entry.retired) return;
    entry.retired = true;
    entry.attachments = entry.agents?.snapshotAttachments();
    entry.stopStatus();
    for (const off of entry.unsubscribers.values()) off();
    entry.unsubscribers.clear();
    entry.release();
  }

  private removePeer(key: string, entry: PeerEntry): void {
    if (this.peers.get(key) !== entry) return;
    this.peers.delete(key);
    this.retirePeer(entry);
    this.workspaceStatusChanged(key);
  }

  clearCloudConnections(): void {
    this.accountEpoch++;
    this.historyRestore.setAccount(String(this.accountEpoch));
    this.nativeHistoryRestore.setAccount(String(this.accountEpoch));
    this.cloudRepositorySlugs.clear();
    this.sawCloudCatalog = false;
    for (const pending of this.opening.values()) pending.controller.abort();
    for (const timer of this.speculative.values()) clearTimeout(timer);
    this.speculative.clear();
    for (const [key, entry] of this.peers) this.removePeer(key, entry);
    this.opening.clear();
    this.historyWarmups.clear();
    this.historyIntents.clear();
    this.projectionCheckpoints.clear();
    for (const key of this.history.keys()) this.history.forget(key);
    this.historyWorkspaces.clear();
  }

  pruneCloudConnections(): void {
    for (const [key, pending] of this.opening) {
      if ((pending.owner ? this.continuesWake(pending.target, pending.owner) : pending.identity === this.identity(pending.target)) &&
          (!this.routing.canAccess || this.routing.canAccess(pending.target))) continue;
      pending.controller.abort();
      this.opening.delete(key);
      this.claimPeer(key);
      this.workspaceStatusChanged(key);
    }
    for (const [key, entry] of this.peers)
      if (this.routing.canAccess && !this.routing.canAccess(entry.scope))
        this.removePeer(key, entry);
      else if (entry.identity !== this.identity(entry.scope)) this.retirePeer(entry);
    for (const [key, target] of this.historyWorkspaces) if (this.routing.canAccess && !this.routing.canAccess(target)) {
      this.historyWorkspaces.delete(key);
      for (const cached of this.history.keys()) if (cached.startsWith(`${key}\0`)) this.history.forget(cached);
    }
  }

  private continuesWake(target: CloudWorkspaceTarget, owner: WakeOwner | undefined): boolean {
    const current = this.routing.wakeOwner?.(target);
    if (!owner || !current || current.account !== owner.account || current.stopVersion !== owner.stopVersion ||
        current.generation < owner.generation && !current.lifecyclePending) return false;
    // A complete upgrade/rollback cycle may finish at the original number.
    // All waiters share these observed retargets, including native failures.
    if (owner.generation !== current.generation) owner.retargetVersion = (owner.retargetVersion ?? 0) + 1;
    owner.generation = current.generation;
    return true;
  }

  private claimPeer(key: string): void {
    clearTimeout(this.speculative.get(key));
    this.speculative.delete(key);
  }

  private discardSpeculative(key: string): void {
    this.claimPeer(key);
    const pending = this.opening.get(key);
    pending?.controller.abort();
    if (pending) this.opening.delete(key);
    const peer = this.peers.get(key);
    if (peer) this.removePeer(key, peer);
  }

  cancelSpeculativeWarmups(): void {
    for (const key of this.speculative.keys()) this.discardSpeculative(key);
  }

  override retireCloudRuntime(runtimeId: string): void {
    super.retireCloudRuntime(runtimeId);
    for (const [key, entry] of this.peers) {
      // Closing our old connection also emits this native acknowledgement.
      // Its already inert snapshot may still be needed during revalidation.
      if (entry.runtimeId === runtimeId && !entry.retired) {
        // Retain exact-workspace selection/history, with the transport and
        // credentials disposed. A later request must acquire fresh admission.
        this.retirePeer(entry);
        this.workspaceStatusChanged(key);
      }
    }
  }

  override signalOwnerSignedOut(): void {
    this.clearCloudConnections();
    super.signalOwnerSignedOut();
  }
  override dispose(): void {
    this.closed = true;
    this.stopLocalStatus();
    this.stopLocalChanges();
    this.stopHistoryRestore();
    this.clearCloudConnections();
    super.dispose();
  }
}

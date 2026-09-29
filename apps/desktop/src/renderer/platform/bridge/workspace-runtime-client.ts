import type { BridgeMessage } from "./messages";
import { isCloudGithubWriteOperation } from "@zeros/protocol/github-auth";
import { RuntimeClient, type ConnectionStatus } from "./ws-client";
import type { CloudAgentConnection, CloudConversationAttachment } from "./cloud-agent-connection";
import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";
import {
  cloudWorkspaceKey,
  isCloudRepositorySlug,
  parseCloudWorkspaceKey,
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
  agents?: CloudAgentConnection;
  events?: Pick<RuntimeClient, "on">;
}
export interface WorkspaceRuntimeOptions {
  open: (target: CloudWorkspaceTarget, options?: { signal: AbortSignal }) => Promise<CloudPeer>;
  /** Account/catalog epoch and generation; never a credential or admission. */
  identity?: (target: CloudWorkspaceTarget) => string;
  workspaces: () => readonly WireRecord[];
  /** Complete catalog confirmation includes an authoritative empty list. */
  workspacesConfirmed?: () => boolean;
  canAccess?: (target: CloudWorkspaceTarget) => boolean;
  manage?: (target: CloudWorkspaceTarget, op: string, params?: WireRecord) => Promise<WireRecord>;
  /** Authorized database reads that do not require a worker connection. */
  readHistory?: (target: CloudWorkspaceTarget, op: string, params: WireRecord) => Promise<WireRecord>;
  prepareGithubWrite?: (target: CloudWorkspaceTarget, op: string, params: WireRecord) => Promise<string>;
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

/** One renderer protocol boundary, multiple independently owned connections.
 * Unscoped host operations remain local. Every cloud operation carries its
 * semantic owner, so focus changes cannot redirect an outstanding request.
 * Existing transcript/workbench consumers subscribe to this same client. */
export class WorkspaceRuntimeClient extends RuntimeClient {
  private readonly peers = new Map<string, PeerEntry>();
  private readonly opening = new Map<string, {
    promise: Promise<PeerEntry>; identity: string; target: CloudWorkspaceTarget; controller: AbortController;
  }>();
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
  private localEpoch = 0;
  private readonly localLists = new Map<string, LocalListEntry>();
  private readonly cloudRepositorySlugs = new Set<string>();
  private sawCloudCatalog = false;
  private readonly stopLocalStatus: () => void;
  private readonly stopLocalChanges: () => void;

  constructor(private readonly routing: WorkspaceRuntimeOptions) {
    super({ kind: "local" });
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

  private async readHistory(target: CloudWorkspaceTarget, op: string, params: WireRecord): Promise<WireRecord> {
    const epoch = this.accountEpoch;
    const identity = this.identity(target);
    const assertAccess = () => {
      if (this.closed || epoch !== this.accountEpoch || identity !== this.identity(target) || (this.routing.canAccess && !this.routing.canAccess(target)))
        throw new Error("Cloud history access changed");
    };
    assertAccess();
    const key = cloudWorkspaceKey(target);
    const attached = op === "messages.window" || op === "messages.windowOlder"
      ? this.peers.get(key) : undefined;
    const peer = attached && attached.identity === identity && !attached.retired && attached.client.status === "connected"
      ? attached : undefined;
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
        if (response.type !== "WORKSPACE_RESPONSE" || !Array.isArray(record(record(response).result).messages))
          throw new Error("Could not read the current cloud transcript");
        result = record(cloudIncoming(peer.scope, response as unknown as WireRecord).result);
      } else {
        result = await this.routing.readHistory!(target, op, params);
      }
      assertAccess();
      if (op === "chats.list") {
        const previous = this.history.peekSnapshot(this.historyKey(target, op, params)).data;
        if (previous && typeof result.revision === "number" && previous.revision === result.revision) return previous;
        if (previous && JSON.stringify(previous) === JSON.stringify(result)) return previous;
      }
      return result;
    }, { maxAgeMs: (this.historyIntents.get(cacheKey) ?? -1) >= performance.now() ? 15_000 : 1000 });
    assertAccess();
    if (op === "chats.list") {
      this.historyWorkspaces.delete(key);
      this.historyWorkspaces.set(key, target);
      while (this.historyWorkspaces.size > 32) this.historyWorkspaces.delete(this.historyWorkspaces.keys().next().value!);
    }
    return snapshot;
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

  statusForWorkspace(folder?: string | null): ConnectionStatus {
    const target = parseCloudWorkspaceKey(folder);
    if (!target) return this.status;
    const key = cloudWorkspaceKey(target);
    if (this.opening.has(key)) return "connecting";
    const entry = this.peers.get(key);
    return entry && !entry.retired ? entry.client.status : "disconnected";
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
        this.emit(
          type,
          cloudIncoming(entry.scope, entry.agents?.incoming(wire) ?? wire),
        );
      }),
    );
  }

  private peer(target: CloudWorkspaceTarget): Promise<PeerEntry> {
    if (this.routing.canAccess && !this.routing.canAccess(target))
      return Promise.reject(
        new Error(
          "Cloud workspace access has not been confirmed for this account",
        ),
      );
    const key = cloudWorkspaceKey(target);
    const identity = this.identity(target);
    const pending = this.opening.get(key);
    if (pending?.identity === identity) return pending.promise;
    if (pending) {
      pending.controller.abort();
      this.opening.delete(key);
    }
    const existing = this.peers.get(key);
    if (existing && existing.identity === identity && !existing.retired && existing.client.status === "connected")
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
    if (existing) this.retirePeer(existing);
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
    try { opening = this.routing.open(target, { signal: controller.signal }); }
    catch (error) { this.ongoingOpens--; return Promise.reject(error); }
    const flight = opening
      .then(async (opened) => {
        if (
          epoch !== this.accountEpoch ||
          controller.signal.aborted || identity !== this.identity(target) ||
          this.closed ||
          (this.routing.canAccess && !this.routing.canAccess(target))
        ) {
          opened.release();
          throw new Error("Cloud account changed while connecting");
        }
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
    this.opening.set(key, { promise: flight, identity, target, controller });
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
    if (this.routing.readHistory) {
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
      throw new Error("Could not read cloud conversations");
    if (entry.epoch !== this.accountEpoch)
      throw new Error("Cloud account changed");
    this.assertCurrent(entry);
    const next = cloudIncoming(entry.scope, response as unknown as WireRecord);
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
    return cloudIncoming(
      entry.scope,
      entry.agents?.incoming(response as unknown as WireRecord) ??
        (response as unknown as WireRecord),
    ) as unknown as BridgeMessage;
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
    const offLocal = super.on(type, handler);
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
    this.cloudRepositorySlugs.clear();
    this.sawCloudCatalog = false;
    for (const pending of this.opening.values()) pending.controller.abort();
    for (const timer of this.speculative.values()) clearTimeout(timer);
    this.speculative.clear();
    for (const [key, entry] of this.peers) this.removePeer(key, entry);
    this.opening.clear();
    this.historyWarmups.clear();
    this.historyIntents.clear();
    for (const key of this.history.keys()) this.history.forget(key);
    this.historyWorkspaces.clear();
  }

  pruneCloudConnections(): void {
    for (const [key, pending] of this.opening) {
      if (pending.identity === this.identity(pending.target) && (!this.routing.canAccess || this.routing.canAccess(pending.target))) continue;
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
    this.clearCloudConnections();
    super.dispose();
  }
}

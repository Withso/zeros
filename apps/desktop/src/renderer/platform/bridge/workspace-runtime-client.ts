import type { BridgeMessage } from "./messages";
import { RuntimeClient, type ConnectionStatus } from "./ws-client";
import type { CloudAgentConnection } from "./cloud-agent-connection";
import {
  cloudWorkspaceKey,
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
  open: (target: CloudWorkspaceTarget) => Promise<CloudPeer>;
  workspaces: () => readonly WireRecord[];
  canAccess?: (target: CloudWorkspaceTarget) => boolean;
  manage?: (target: CloudWorkspaceTarget, op: string) => Promise<WireRecord>;
}
interface PeerEntry extends CloudPeer {
  unsubscribers: Map<string, () => void>;
  stopStatus: () => void;
  snapshot: WireRecord;
  epoch: number;
  snapshotRevision: number;
}

/** One renderer protocol boundary, multiple independently owned connections.
 * Unscoped host operations remain local. Every cloud operation carries its
 * semantic owner, so focus changes cannot redirect an outstanding request.
 * Existing transcript/workbench consumers subscribe to this same client. */
export class WorkspaceRuntimeClient extends RuntimeClient {
  private readonly peers = new Map<string, PeerEntry>();
  private readonly opening = new Map<string, Promise<PeerEntry>>();
  private readonly routedHandlers = new Map<
    string,
    Set<(message: BridgeMessage) => void>
  >();
  private accountEpoch = 0;
  private workspaceStatusListeners = new Map<string, Set<() => void>>();
  private closed = false;

  constructor(private readonly routing: WorkspaceRuntimeOptions) {
    super({ kind: "local" });
  }

  async warmWorkspace(target: CloudWorkspaceTarget): Promise<void> {
    await this.peer(target);
  }

  statusForWorkspace(folder?: string | null): ConnectionStatus {
    const target = parseCloudWorkspaceKey(folder);
    if (!target) return this.status;
    const key = cloudWorkspaceKey(target);
    return (
      this.peers.get(key)?.client.status ??
      (this.opening.has(key) ? "connecting" : "disconnected")
    );
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
          entry.epoch !== this.accountEpoch ||
          this.peers.get(cloudWorkspaceKey(entry.scope)) !== entry
        )
          return;
        if (this.routing.canAccess && !this.routing.canAccess(entry.scope))
          return;
        const wire = message as unknown as WireRecord;
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
    const pending = this.opening.get(key);
    if (pending) return pending;
    const existing = this.peers.get(key);
    if (existing) return Promise.resolve(existing);
    if (this.closed)
      return Promise.reject(new Error("Workspace connections are closed"));
    // Bound sockets and their replay buffers; never evict a potentially live
    // conversation merely because another workspace gained focus.
    if (this.peers.size + this.opening.size >= 16)
      return Promise.reject(
        new Error(
          "Too many cloud workspace connections are open. Reopen Zeros to reconnect the workspaces you need.",
        ),
      );
    const epoch = this.accountEpoch;
    const flight = this.routing
      .open(target)
      .then(async (opened) => {
        if (
          epoch !== this.accountEpoch ||
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
        const entry: PeerEntry = {
          ...opened,
          epoch,
          snapshotRevision: 0,
          unsubscribers: new Map(),
          stopStatus: () => {},
          snapshot: { chats: [], chatDeletions: [] },
        };
        this.peers.set(key, entry);
        for (const type of this.routedHandlers.keys()) this.attach(entry, type);
        entry.stopStatus = entry.client.onStatusChange((status) => {
          this.workspaceStatusChanged(key);
          if (status !== "connected" || epoch !== this.accountEpoch) return;
          void this.readChats(entry)
            .then(() => this.changed(key))
            .catch(() => {});
        });
        // Read before writes. A stale device boot cache cannot recreate a deleted
        // chat or overwrite a newer title on its first cloud attachment.
        try {
          await this.readChats(entry);
        } catch (error) {
          this.removePeer(key, entry);
          throw error;
        }
        if (epoch !== this.accountEpoch)
          throw new Error("Cloud account changed while connecting");
        this.changed(key);
        this.workspaceStatusChanged(key);
        return entry;
      })
      .finally(() => {
        if (this.opening.get(key) === flight) this.opening.delete(key);
        this.workspaceStatusChanged(key);
      });
    this.opening.set(key, flight);
    this.workspaceStatusChanged(key);
    return flight;
  }

  private changed(key: string): void {
    this.emit("DB_CHANGED", {
      type: "DB_CHANGED",
      kinds: ["chats", "messages", "workspaces", "git", "files"],
      workspaceId: key,
      cloudWorkspace: key,
    });
  }

  private async readChats(entry: PeerEntry): Promise<WireRecord> {
    const revision = ++entry.snapshotRevision;
    const response = await entry.client.request({
      type: "WORKSPACE_REQUEST",
      op: "chats.list",
      params: {},
    } as Message);
    if (response.type === "WORKSPACE_ERROR")
      throw new Error("Could not read cloud conversations");
    if (entry.epoch !== this.accountEpoch)
      throw new Error("Cloud account changed");
    this.assertCurrent(entry);
    const next = cloudIncoming(entry.scope, response as unknown as WireRecord);
    if (revision === entry.snapshotRevision)
      entry.snapshot = record(next.result);
    return entry.snapshot;
  }

  private assertCurrent(entry: PeerEntry): void {
    if (this.peers.get(cloudWorkspaceKey(entry.scope)) !== entry)
      throw new Error("Cloud connection changed while the request was running");
  }

  private async cloudRequest(
    target: CloudWorkspaceTarget,
    message: Message,
    options: number | RequestOptions,
  ): Promise<BridgeMessage> {
    const entry = await this.peer(target);
    if (entry.epoch !== this.accountEpoch)
      throw new Error("Cloud account changed before dispatch");
    this.assertCurrent(entry);
    const native = cloudOutgoing(entry.scope, message as unknown as WireRecord);
    const adapted = await entry.agents?.request(native, options);
    const response =
      adapted ??
      (await entry.client.request(
        (entry.agents?.outgoing(native) ?? native) as Message,
        options,
      ));
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
        result: await this.routing.manage(target, String(wire.op)),
      } as unknown as T;
    }
    if (target) return (await this.cloudRequest(target, message, options)) as T;
    const response = await super.request<T>(message, options);
    if (response.type !== "WORKSPACE_RESPONSE") return response;
    const result = record((response as unknown as WireRecord).result);
    if (wire.op === "workspace.list") {
      const cloud = this.routing
        .workspaces()
        .filter(
          (row) =>
            (!params.repoSlug || row.repoSlug === params.repoSlug) &&
            (!params.status || row.status === params.status) &&
            (params.archived === undefined ||
              Boolean(row.archivedAt) === params.archived),
        );
      return {
        ...response,
        result: {
          ...result,
          workspaces: [
            ...(Array.isArray(result.workspaces) ? result.workspaces : []),
            ...cloud,
          ],
        },
      } as T;
    }
    if (wire.op === "chats.list") {
      const epoch = this.accountEpoch;
      const entries = [...this.peers.values()];
      await Promise.allSettled(entries.map((entry) => this.readChats(entry)));
      if (epoch !== this.accountEpoch)
        throw new Error("Cloud account changed while loading conversations");
      const snapshots = entries
        .filter(
          (entry) => this.peers.get(cloudWorkspaceKey(entry.scope)) === entry,
        )
        .map((entry) => entry.snapshot);
      return {
        ...response,
        result: {
          ...result,
          chats: [
            ...(Array.isArray(result.chats) ? result.chats : []),
            ...snapshots.flatMap((s) =>
              Array.isArray(s.chats) ? s.chats : [],
            ),
          ],
          chatDeletions: [
            ...(Array.isArray(result.chatDeletions)
              ? result.chatDeletions
              : []),
            ...snapshots.flatMap((s) =>
              Array.isArray(s.chatDeletions) ? s.chatDeletions : [],
            ),
          ],
        },
      } as T;
    }
    return response;
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

  private removePeer(key: string, entry: PeerEntry): void {
    if (this.peers.get(key) !== entry) return;
    this.peers.delete(key);
    entry.stopStatus();
    for (const off of entry.unsubscribers.values()) off();
    entry.release();
    this.workspaceStatusChanged(key);
  }

  clearCloudConnections(): void {
    this.accountEpoch++;
    for (const [key, entry] of this.peers) this.removePeer(key, entry);
    this.opening.clear();
  }

  pruneCloudConnections(): void {
    for (const [key, entry] of this.peers)
      if (this.routing.canAccess && !this.routing.canAccess(entry.scope))
        this.removePeer(key, entry);
  }

  override retireCloudRuntime(runtimeId: string): void {
    super.retireCloudRuntime(runtimeId);
    for (const [key, entry] of this.peers) {
      if (entry.runtimeId === runtimeId) this.removePeer(key, entry);
    }
  }

  override signalOwnerSignedOut(): void {
    this.clearCloudConnections();
    super.signalOwnerSignedOut();
  }
  override dispose(): void {
    this.closed = true;
    this.clearCloudConnections();
    super.dispose();
  }
}

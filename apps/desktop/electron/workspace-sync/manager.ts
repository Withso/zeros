import { createHash } from "node:crypto";
import { SyncEngine, SyncRootError, type SyncIdentity, type SyncSource } from "./engine";
import { SyncConnectError } from "./connection";
import type { WorkspaceSyncStatus } from "../../shared/workspace-sync";

export interface SyncConnection extends SyncSource { close(): void }
export interface SyncManagerDeps {
  /** Persisted on this Mac only: workspace id -> folder, per account and device. */
  settings: { get(key: string): string | null | undefined; set(key: string, value: string): void };
  identity(): { accountId: string; deviceId: string } | null;
  connect(workspaceId: string, handlers: { hint(): void; closed(): void }): Promise<SyncConnection>;
  /** The connected-Macs row's syncing flag (G's route); best effort. */
  setSyncing(workspaceId: string, syncing: boolean): Promise<void>;
  publish(statuses: WorkspaceSyncStatus[]): void;
  open?: typeof SyncEngine.open;
  wait?(ms: number, wake: { promise: Promise<void> }): Promise<void>;
}

const IDLE_PULL_MS = 60_000, PAUSED_MS = 60_000, RETRY_MS = 1_000, ERROR_MS = 60_000, UPDATE_MS = 300_000;

interface Run { stop: AbortController; wake: () => void; wakePromise: Promise<void>; status: WorkspaceSyncStatus; done: Promise<void> }

/** Every workspace this Mac mirrors, each in its own loop: connect passively,
 * pull, wait for a hint (or a minute), repeat. Sleeping VMs show Paused and are
 * retried without waking them. */
export class SyncManager {
  private readonly runs = new Map<string, Run>();
  private account: string | null = null;
  constructor(private readonly deps: SyncManagerDeps) {}

  private key(identity: { accountId: string; deviceId: string }): string {
    return `workspaceSync.${createHash("sha256").update(identity.accountId).digest("hex").slice(0, 32)}.${identity.deviceId}`;
  }
  private folders(): Record<string, string> {
    const identity = this.deps.identity();
    if (!identity) return {};
    try {
      const value = JSON.parse(this.deps.settings.get(this.key(identity)) ?? "{}") as Record<string, unknown>;
      return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    } catch { return {}; }
  }
  private saveFolders(folders: Record<string, string>): void {
    const identity = this.deps.identity();
    if (identity) this.deps.settings.set(this.key(identity), JSON.stringify(folders));
  }

  /** The account changed or the app started: run exactly this account's syncs. */
  async start(): Promise<void> {
    const identity = this.deps.identity(), account = identity ? `${identity.accountId}:${identity.deviceId}` : null;
    if (account !== this.account) { await this.stop(); this.account = account; }
    if (!identity) return;
    for (const [workspaceId, folder] of Object.entries(this.folders())) if (!this.runs.has(workspaceId)) this.run(workspaceId, folder, identity);
    this.publish();
  }
  async stop(): Promise<void> {
    const runs = [...this.runs.values()]; this.runs.clear();
    for (const run of runs) { run.stop.abort(); run.wake(); }
    await Promise.all(runs.map(run => run.done));
    this.publish();
  }

  statuses(): WorkspaceSyncStatus[] { return [...this.runs.values()].map(run => run.status); }
  folderFor(workspaceId: string): string | undefined { return this.folders()[workspaceId]; }

  /** Turn sync on for a folder the person chose: it must be empty or this
   * workspace's earlier root. Throws SyncRootError with a closed code. */
  async enable(workspaceId: string, folder: string): Promise<void> {
    const identity = this.deps.identity();
    if (!identity) throw new SyncRootError("other_workspace");
    const engine = await (this.deps.open ?? SyncEngine.open)(folder, this.syncIdentity(workspaceId, identity));
    const previous = this.runs.get(workspaceId);
    if (previous) { this.runs.delete(workspaceId); previous.stop.abort(); previous.wake(); await previous.done; }
    this.saveFolders({ ...this.folders(), [workspaceId]: engine.root });
    await this.deps.setSyncing(workspaceId, true).catch(() => {});
    this.run(workspaceId, engine.root, identity);
    this.publish();
  }
  /** Stop mirroring; the folder and its files stay as they are. */
  async disable(workspaceId: string): Promise<void> {
    const run = this.runs.get(workspaceId);
    this.runs.delete(workspaceId);
    if (run) { run.stop.abort(); run.wake(); await run.done; }
    const folders = this.folders(); delete folders[workspaceId]; this.saveFolders(folders);
    await this.deps.setSyncing(workspaceId, false).catch(() => {});
    this.publish();
  }

  private syncIdentity(workspaceId: string, identity: { accountId: string; deviceId: string }): SyncIdentity {
    return { workspaceId, accountId: identity.accountId, deviceId: identity.deviceId };
  }
  private publish(): void { this.deps.publish(this.statuses()); }

  private run(workspaceId: string, folder: string, identity: { accountId: string; deviceId: string }): void {
    const stop = new AbortController();
    let wake!: () => void;
    const run: Run = { stop, wake: () => wake(), wakePromise: Promise.resolve(), status: { workspaceId, state: "syncing", problems: 0 }, done: Promise.resolve() };
    const rearm = () => { run.wakePromise = new Promise<void>(resolve => { wake = resolve; }); };
    rearm();
    const set = (status: Omit<WorkspaceSyncStatus, "workspaceId">) => { run.status = { workspaceId, ...status }; if (this.runs.get(workspaceId) === run) this.publish(); };
    const wait = (ms: number) => { const sleeping = (this.deps.wait ?? defaultWait)(ms, { promise: run.wakePromise }); return sleeping.finally(rearm); };
    this.runs.set(workspaceId, run);
    run.done = (async () => {
      let engine: SyncEngine | undefined;
      while (!stop.signal.aborted) {
        let connection: SyncConnection | undefined;
        try {
          engine ??= await (this.deps.open ?? SyncEngine.open)(folder, this.syncIdentity(workspaceId, identity));
          connection = await this.deps.connect(workspaceId, { hint: () => run.wake(), closed: () => run.wake() });
          let open = true;
          while (open && !stop.signal.aborted) {
            set({ state: "syncing", problems: run.status.problems });
            const result = await engine.pull(connection, remaining => { if (remaining) set({ state: "syncing", files: remaining, problems: run.status.problems }); });
            if (result.state === "stopped") { set({ state: "error", reason: result.stopped, problems: 0 }); await wait(ERROR_MS); break; }
            if (result.state === "retry") { await wait(RETRY_MS); continue; }
            set({ state: "in_sync", problems: result.problems.length + result.skipped.length, ...(result.git === "missing" ? { reason: "git_missing" } : result.git === "failed" ? { reason: "git_failed" } : {}) });
            await wait(IDLE_PULL_MS);
            open = !stop.signal.aborted;
          }
        } catch (error) {
          if (stop.signal.aborted) break;
          if (error instanceof SyncConnectError && error.kind === "paused") { set({ state: "paused", problems: run.status.problems }); await wait(PAUSED_MS); }
          else if (error instanceof SyncConnectError && error.kind === "signed_out") break;
          else if (error instanceof SyncConnectError && error.kind === "update_required") { set({ state: "error", reason: "update_required", problems: 0 }); await wait(UPDATE_MS); }
          else if (error instanceof SyncConnectError && error.kind === "not_connected") { set({ state: "error", reason: "not_connected", problems: 0 }); await wait(ERROR_MS); }
          else if (error instanceof SyncRootError) { set({ state: "error", reason: `folder_${error.code}`, problems: 0 }); await wait(ERROR_MS); engine = undefined; }
          else if (error instanceof SyncConnectError) { set({ state: "paused", problems: run.status.problems }); await wait(PAUSED_MS); }
          else { set({ state: "error", reason: "write_failed", problems: run.status.problems }); await wait(ERROR_MS); }
        } finally { connection?.close(); }
      }
    })();
  }
}

function defaultWait(ms: number, wake: { promise: Promise<void> }): Promise<void> {
  return new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms);
    void wake.promise.then(() => { clearTimeout(timer); resolve(); });
  });
}

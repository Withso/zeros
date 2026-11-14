import { defaultSyncFolder } from "./default-folder";

/** One row of GET /v1/cloud-v2/devices/:deviceId/connections (12.z). */
export interface DeviceSyncConnection {
  workspaceId: string;
  /** owner/name */
  repository: string;
  number: number | null;
  name: string;
  syncWanted: boolean;
  syncing?: boolean;
}
export interface SyncWantedDeps {
  list(cursor?: string): Promise<{ connections: DeviceSyncConnection[]; nextCursor: string | null }>;
  /** Workspaces this Mac mirrors now. */
  running(): string[];
  folderFor(workspaceId: string): string | undefined;
  enable(workspaceId: string, folder: string): Promise<void>;
  disable(workspaceId: string): Promise<void>;
  archive?(workspaceId: string, isCurrent: () => boolean, options?: { force?: boolean }): Promise<boolean>;
  identityKey?(): string | null;
  /** The app's channel folder (12.zz). */
  channel: string;
  now(): number;
  log(line: string): void;
  mkdir?(folder: string): Promise<void>;
}

const MIN_INTERVAL_MS = 10_000, PERIOD_MS = 5 * 60_000, UNSUPPORTED_MS = 30 * 60_000, MAX_PAGES = 50;

/** 12.z: main follows what the person wants for THIS Mac, whatever the
 * renderer shows: a workspace wanted here starts in its default folder, one
 * set to false stops. Every page is read before anything changes; a failed
 * read keeps the current state. A workspace this Mac changed after the read
 * began is left alone, so the person's own switch is never undone. A running
 * workspace the complete list does not name (this Mac is no longer connected
 * there) stops: sync needs the connection, and a restart must not resume it. */
export class SyncWantedFollower {
  private lastAt = Number.NEGATIVE_INFINITY;
  private unsupportedUntil = Number.NEGATIVE_INFINITY;
  private flight?: Promise<void>;
  private readonly changedAt = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;
  private generation = 0;
  constructor(private readonly deps: SyncWantedDeps) {}

  /** App start or a new account: read now, then every few minutes (idempotent). */
  start(): void {
    void this.refresh();
    if (this.timer) return;
    this.timer = setInterval(() => { void this.refresh(); }, PERIOD_MS);
    this.timer.unref?.();
  }
  stop(): void { clearInterval(this.timer); this.timer = undefined; this.generation++; this.flight = undefined; }
  /** This Mac's own switch moved: the next read must not undo it. */
  noteLocalChange(workspaceId: string): void { this.changedAt.set(workspaceId, this.deps.now()); }
  /** A device-channel hint: read again, at most every 10 s. */
  hint(): Promise<void> {
    if (this.deps.now() - this.lastAt < MIN_INTERVAL_MS) return this.flight ?? Promise.resolve();
    return this.refresh();
  }

  refresh(): Promise<void> {
    if (!this.flight) {
      const flight = this.read().finally(() => { if (this.flight === flight) this.flight = undefined; });
      this.flight = flight;
    }
    return this.flight;
  }

  private async read(): Promise<void> {
    const started = this.deps.now();
    const generation = this.generation, identity = this.deps.identityKey?.();
    const current = () => this.generation === generation && this.deps.identityKey?.() === identity;
    const unchanged = (id: string) => current() && (this.changedAt.get(id) ?? Number.NEGATIVE_INFINITY) < started;
    if (started < this.unsupportedUntil) return;
    this.lastAt = started;
    const rows: DeviceSyncConnection[] = [];
    try {
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const reply = await this.deps.list(cursor);
        if (!current()) return;
        rows.push(...reply.connections);
        if (!reply.nextCursor) { cursor = undefined; break; }
        cursor = reply.nextCursor;
      }
      if (cursor) return;   // more pages than allowed: not a complete view, change nothing
    } catch (error) {
      if (!current()) return;
      const status = (error as { status?: unknown }).status;
      if (status === 404) { this.unsupportedUntil = started + UNSUPPORTED_MS; this.deps.log("wanted unsupported"); }
      return;
    }
    const running = new Set(this.deps.running());
    for (const row of rows) {
      if (!unchanged(row.workspaceId)) continue;
      try {
        if (await this.deps.archive?.(row.workspaceId, () => unchanged(row.workspaceId))) continue;
        if (!unchanged(row.workspaceId)) continue;
        if (row.syncWanted && !running.has(row.workspaceId)) {
          const folder = this.deps.folderFor(row.workspaceId) ?? defaultSyncFolder(this.deps.channel, row.repository.split("/").pop() ?? row.repository,
            row.number ? `w-${row.number}` : row.name);
          await this.deps.mkdir?.(folder);
          if (!unchanged(row.workspaceId)) continue;
          await this.deps.enable(row.workspaceId, folder);
          this.deps.log(`wanted start workspace=${row.workspaceId.slice(0, 8)}`);
        } else if (!row.syncWanted && running.has(row.workspaceId)) {
          await this.deps.disable(row.workspaceId);
          this.deps.log(`wanted stop workspace=${row.workspaceId.slice(0, 8)}`);
        }
      } catch {
        // One folder that cannot be used (not empty, another workspace's) never blocks the rest; its run shows the error.
        this.deps.log(`wanted failed workspace=${row.workspaceId.slice(0, 8)}`);
      }
    }
    const listed = new Set(rows.map(row => row.workspaceId));
    for (const workspaceId of running) {
      if (listed.has(workspaceId) || !unchanged(workspaceId)) continue;
      try {
        // It left this Mac's connections: check archive intent now rather than after the five-minute reuse.
        if (await this.deps.archive?.(workspaceId, () => unchanged(workspaceId), { force: true })) continue;
        if (!unchanged(workspaceId)) continue;
        await this.deps.disable(workspaceId);
        this.deps.log(`wanted stop workspace=${workspaceId.slice(0, 8)} reason=not_connected`);
      } catch {
        this.deps.log(`wanted failed workspace=${workspaceId.slice(0, 8)}`);
      }
    }
  }
}

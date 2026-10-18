import { CloudSdkStreamEventSchema, CloudSdkStreamSnapshotSchema,
  type CloudSdkStreamCommand, type CloudSdkStreamEvent, type CloudSdkStreamPayload,
  type CloudSdkStreamSnapshot } from "../../../shared/cloud-sdk-stream-contract";
import type { CloudWorkspaceTarget } from "../platform/bridge/cloud-workspace-key";
import type { CloudWorkspaceCatalogSnapshot } from "../platform/cloud-workspaces";

export const CLOUD_STREAM_HIDDEN_RETENTION_MS = 30_000;
const MAX_START_EVENTS = 64;
const MAX_START_BYTES = 4 * 1024 * 1024;
type Timer = ReturnType<typeof setTimeout>;
type Options = {
  accountEpoch(): number;
  control(input: CloudSdkStreamCommand): Promise<unknown>;
  listen(listener: (event: unknown) => void): Promise<() => void>;
  readSnapshot(): Promise<CloudWorkspaceCatalogSnapshot>;
  applyCatalog(frame: Extract<CloudSdkStreamPayload, { t: "catalog.changed" }>, epoch: number): boolean;
  onCoverage(snapshot: CloudSdkStreamSnapshot | null): void;
  onPayload(frame: CloudSdkStreamPayload): void;
};
type Session = {
  epoch: number;
  off?: () => void;
  snapshot?: CloudSdkStreamSnapshot;
  buffered: CloudSdkStreamEvent[];
  bytes: number;
  repair: number;
  completed?: string;
  confirmed?: string;
  reading: boolean;
  retry?: Timer;
  failures: number;
};
const observation = (session: Session) => `${session.snapshot?.revision}:${session.repair}`;

/** Account-scoped ownership, independent of the selected cloud workspace.
 * Native owns tickets and cursors; only a complete observation for this lease
 * and revision can confirm organization coverage. */
export class CloudWorkspaceStreamController {
  private session?: Session;
  private selectedKey: string | null = null;
  private visible = false;
  private hiddenTimer?: Timer;
  private disposed = false;

  constructor(private readonly options: Options) {}

  select(target: CloudWorkspaceTarget | null, visible: boolean): void {
    if (this.disposed) return;
    const key = target ? `${target.organizationId}/${target.workspaceId}` : null;
    const changed = key !== this.selectedKey;
    this.selectedKey = key;
    this.visible = visible;
    if (this.session && (this.session.epoch !== this.options.accountEpoch() || changed && this.session.snapshot?.state === "stopped")) this.retire();
    if (!target) { this.retire(); return; }
    if (!visible) {
      this.options.onCoverage(null);
      if (this.session && this.hiddenTimer === undefined) this.hiddenTimer = setTimeout(() => {
        this.hiddenTimer = undefined;
        if (!this.visible) this.retire();
      }, CLOUD_STREAM_HIDDEN_RETENTION_MS);
      return;
    }
    this.clearHiddenTimer();
    if (!this.session) {
      const session: Session = { epoch: this.options.accountEpoch(), buffered: [], bytes: 0, repair: 0, reading: false, failures: 0 };
      this.session = session;
      this.options.onCoverage(null);
      void this.start(session, target);
    } else {
      this.publishCoverage(this.session);
      this.catchUp(this.session);
    }
  }

  private current(session: Session): boolean {
    return !this.disposed && this.session === session && session.epoch === this.options.accountEpoch();
  }

  private async start(session: Session, target: CloudWorkspaceTarget): Promise<void> {
    try {
      const off = await this.options.listen(event => this.receive(session, event));
      if (!this.current(session)) { off(); return; }
      session.off = off;
      const raw = await this.options.control({ action: "start", target });
      const parsed = CloudSdkStreamSnapshotSchema.safeParse(raw);
      if (!parsed.success || !parsed.data.leaseId) { if (this.current(session)) this.retire(); return; }
      if (!this.current(session)) { this.stopLease(parsed.data); return; }
      session.snapshot = parsed.data;
      const buffered = session.buffered;
      session.buffered = []; session.bytes = 0;
      for (const event of buffered) this.receive(session, event);
      this.catchUp(session);
    } catch {
      // Native discovery/authorization owns reconnects once started. A failed
      // invocation leaves legacy observation active until the next selection.
      if (this.current(session)) this.retire();
    }
  }

  private receive(session: Session, raw: unknown): void {
    if (!this.current(session)) return;
    const parsed = CloudSdkStreamEventSchema.safeParse(raw);
    if (!parsed.success) { this.invalidate(session); return; }
    const event = parsed.data, prior = session.snapshot;
    if (!prior) {
      const bytes = JSON.stringify(event).length * 2;
      if (session.buffered.length >= MAX_START_EVENTS || session.bytes + bytes > MAX_START_BYTES) {
        // Lost startup payloads require a new complete observation, never
        // unbounded retention of native events before invoke settles.
        session.buffered = []; session.bytes = 0; session.repair++;
      }
      session.buffered.push(event); session.bytes += bytes;
      return;
    }
    if (event.streamId !== prior.streamId || event.leaseId !== prior.leaseId || event.sequence <= prior.sequence) return;
    if (event.revision < prior.revision) return;
    const gap = event.sequence !== prior.sequence + 1;
    session.snapshot = event;
    if (gap || event.revision !== prior.revision || event.state !== "open" || event.catalogRequired && !prior.catalogRequired) {
      session.repair++;
      session.confirmed = undefined;
      session.completed = undefined;
      this.options.onCoverage(null);
    }
    if (event.event.type === "frame") {
      const frame = event.event.frame;
      if (frame.t === "catalog.changed" && !this.options.applyCatalog(frame, session.epoch)) this.invalidate(session);
      if (frame.t === "capability.revoked") this.invalidate(session);
      if (this.visible && this.current(session)) this.options.onPayload(frame);
    }
    this.publishCoverage(session);
    this.catchUp(session);
  }

  private invalidate(session: Session): void {
    session.repair++;
    session.confirmed = undefined; session.completed = undefined;
    this.options.onCoverage(null);
    this.catchUp(session);
  }

  private catchUp(session: Session): void {
    if (!this.current(session) || !this.visible || session.reading || session.retry !== undefined || session.snapshot?.state !== "open") return;
    const key = observation(session), snapshot = session.snapshot;
    if (!snapshot.leaseId || session.completed === key) return;
    session.reading = true;
    void (async () => {
      try {
        const catalog = await this.options.readSnapshot();
        if (!this.current(session) || !this.visible || session.snapshot?.state !== "open" || observation(session) !== key) return;
        const accepted = await this.options.control({ action: "snapshot-current", streamId: snapshot.streamId, leaseId: snapshot.leaseId!,
          revision: snapshot.revision, catalogVersion: catalog.catalogVersion,
          workspaces: catalog.workspaces.slice(0, 1_000).map(row => ({ organizationId: row.organizationId, workspaceId: row.id, version: row.version })) });
        if (!this.current(session) || observation(session) !== key) return;
        // An older server can acknowledge without coverage or omit its catalog
        // watermark. Finish once, retaining polls, without a tight read loop.
        session.completed = key;
        session.confirmed = accepted === true && catalog.catalogVersion !== null ? key : undefined;
        session.failures = 0;
        this.publishCoverage(session);
      } catch {
        if (this.current(session) && observation(session) === key) {
          this.options.onCoverage(null);
          const delay = Math.min(30_000, 1_000 * 2 ** Math.min(session.failures++, 5));
          session.retry = setTimeout(() => { session.retry = undefined; this.catchUp(session); }, delay);
        }
      } finally {
        session.reading = false;
        if (this.current(session)) this.catchUp(session);
      }
    })();
  }

  private publishCoverage(session: Session): void {
    if (!this.current(session)) return;
    this.options.onCoverage(this.visible && session.snapshot?.state === "open" && !session.snapshot.catalogRequired &&
      session.confirmed === observation(session) ? session.snapshot : null);
  }

  private stopLease(snapshot: CloudSdkStreamSnapshot): void {
    if (snapshot.leaseId) void this.options.control({ action: "stop", streamId: snapshot.streamId, leaseId: snapshot.leaseId }).catch(() => {});
  }
  private clearHiddenTimer(): void {
    if (this.hiddenTimer !== undefined) clearTimeout(this.hiddenTimer);
    this.hiddenTimer = undefined;
  }
  private retire(): void {
    const session = this.session;
    this.session = undefined;
    this.clearHiddenTimer();
    this.options.onCoverage(null);
    if (!session) return;
    if (session.retry !== undefined) clearTimeout(session.retry);
    session.off?.(); session.off = undefined;
    session.buffered = []; session.bytes = 0;
    if (session.snapshot) this.stopLease(session.snapshot);
  }
  dispose(): void { this.disposed = true; this.retire(); }
}

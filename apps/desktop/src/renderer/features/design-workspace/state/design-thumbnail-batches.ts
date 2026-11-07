import type { DesignPreviewReply } from "@zeros/protocol/design-capture";

/** Frames pictured together: one engine batch shares one directory, theme,
 * color scheme and picture size. */
export interface DesignThumbnailGroup {
  readonly workspaceId: string;
  readonly directoryId: string;
  readonly theme: string | null;
  readonly colorScheme: "light" | "dark";
  readonly maxDimension: number;
}
export interface DesignThumbnailFrame {
  readonly file: string;
  readonly sourceVersion: string;
}
export interface DesignThumbnailBatchReply {
  readonly pictures: ReadonlyArray<DesignThumbnailFrame & { width: number; height: number; data: string }>;
  readonly stale: readonly DesignThumbnailFrame[];
  readonly failed: ReadonlyArray<{ file: string; error: string }>;
  /** Left out to keep the reply within one bridge frame: ask again. */
  readonly deferred?: readonly DesignThumbnailFrame[];
}
export type DesignThumbnailBatchRender = (
  group: DesignThumbnailGroup,
  frames: readonly DesignThumbnailFrame[],
  signal: AbortSignal,
) => Promise<DesignThumbnailBatchReply>;

/** Asks for one frame before it fails over to the next picture route. */
const MAX_DEFERRALS = 4;

interface Entry {
  readonly frame: DesignThumbnailFrame;
  readonly signal?: AbortSignal;
  readonly resolve: (reply: DesignPreviewReply) => void;
  readonly reject: (error: unknown) => void;
  settled: boolean;
  deferrals: number;
  release(): void;
}
interface Batch {
  readonly key: string;
  readonly group: DesignThumbnailGroup;
  readonly entries: Entry[];
  /** The batching window has passed (or the batch is full): it may leave. */
  ready: boolean;
}

/** Coalesces one-frame picture requests into engine batches: requests that
 * arrive within a short window (or fill a batch) are rendered together, and
 * each caller receives exactly its own frame's answer. The engine renders one
 * preview job at a time, so a workspace has one batch at the engine while the
 * next fills. A caller that cancels is answered at once; a batch whose callers
 * have all cancelled is aborted; a frame appears once per batch. */
export class DesignThumbnailBatches {
  /** Waiting batches in arrival order. */
  private readonly waiting: Batch[] = [];
  private readonly flushing = new Set<AbortController>();
  private readonly busy = new Set<string>();

  constructor(private readonly render: DesignThumbnailBatchRender, private readonly options: {
    maxItems?: number;
    windowMs?: number;
    setTimer?: (callback: () => void, ms: number) => unknown;
  } = {}) {}

  private get maxItems() { return Math.max(1, this.options.maxItems ?? 64); }

  request(group: DesignThumbnailGroup, frame: DesignThumbnailFrame, signal?: AbortSignal): Promise<DesignPreviewReply> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Design thumbnail request cancelled."));
    const key = JSON.stringify([group.workspaceId, group.directoryId, group.theme, group.colorScheme, group.maxDimension]);
    return new Promise<DesignPreviewReply>((resolve, reject) => {
      const entry: Entry = {
        frame, signal, settled: false, deferrals: 0,
        resolve: (reply) => { if (!entry.settled) { entry.settled = true; entry.release(); resolve(reply); } },
        reject: (error) => { if (!entry.settled) { entry.settled = true; entry.release(); reject(error); } },
        release: () => {},
      };
      if (signal) {
        const aborted = () => entry.reject(signal.reason ?? new Error("Design thumbnail request cancelled."));
        signal.addEventListener("abort", aborted, { once: true });
        entry.release = () => signal.removeEventListener("abort", aborted);
      }
      let batch: Batch | undefined;
      for (let index = this.waiting.length - 1; index >= 0 && !batch; index--)
        if (this.waiting[index]!.key === key) batch = this.waiting[index];
      if (!batch || batch.entries.length >= this.maxItems ||
        batch.entries.some((other) => !other.settled && other.frame.file === frame.file)) {
        batch = { key, group, entries: [], ready: false };
        this.waiting.push(batch);
        const opened = batch;
        (this.options.setTimer ?? ((callback, ms) => setTimeout(callback, ms)))(() => { opened.ready = true; this.pump(group.workspaceId); },
          this.options.windowMs ?? 8);
      }
      batch.entries.push(entry);
      if (batch.entries.length >= this.maxItems) { batch.ready = true; this.pump(group.workspaceId); }
    });
  }

  /** Requests and batches still waiting on the engine. */
  usage() {
    return { waiting: this.waiting.reduce((sum, batch) => sum + batch.entries.length, 0), batches: this.flushing.size };
  }

  /** Sends the workspace's oldest ready batch unless one is at the engine. */
  private pump(workspaceId: string): void {
    if (this.busy.has(workspaceId)) return;
    const index = this.waiting.findIndex((batch) => batch.group.workspaceId === workspaceId && batch.ready);
    if (index < 0) return;
    const [batch] = this.waiting.splice(index, 1);
    const entries = batch!.entries.filter((entry) => !entry.settled);
    if (!entries.length) { this.pump(workspaceId); return; }
    this.busy.add(workspaceId);
    const controller = new AbortController();
    this.flushing.add(controller);
    // Every caller cancelled: nothing awaits this batch's pictures.
    const abandon = () => { if (entries.every((entry) => entry.settled)) controller.abort(new Error("Design thumbnail batch abandoned.")); };
    for (const entry of entries) entry.signal?.addEventListener("abort", abandon, { once: true });
    const group = batch!.group;
    void this.render(group, entries.map((entry) => entry.frame), controller.signal).then((reply) => {
      const pictures = new Map(reply.pictures.map((picture) => [picture.file, picture]));
      const stale = new Map(reply.stale.map((frame) => [frame.file, frame]));
      const failed = new Map(reply.failed.map((frame) => [frame.file, frame]));
      const deferred = new Set((reply.deferred ?? []).map((frame) => frame.file));
      const again: Entry[] = [];
      for (const entry of entries) {
        const picture = pictures.get(entry.frame.file);
        const moved = stale.get(entry.frame.file);
        if (picture && picture.sourceVersion === entry.frame.sourceVersion) {
          entry.resolve({ sourceVersion: picture.sourceVersion, theme: group.theme, mimeType: "image/png",
            width: picture.width, height: picture.height, data: picture.data });
        } else if (moved) entry.resolve({ stale: true, sourceVersion: moved.sourceVersion });
        else if (deferred.has(entry.frame.file) && ++entry.deferrals < MAX_DEFERRALS) again.push(entry);
        else if (deferred.has(entry.frame.file)) entry.reject(new Error("Design thumbnail batch kept deferring this frame."));
        else entry.reject(new Error(failed.get(entry.frame.file)?.error ?? "Design thumbnail batch did not picture this frame."));
      }
      // The engine fits each reply's first picture, so deferred frames leave
      // first, in order, and every ask pictures at least one of them.
      if (again.some((entry) => !entry.settled)) this.waiting.unshift({ key: batch!.key, group, entries: again, ready: true });
    }, (error: unknown) => {
      for (const entry of entries) entry.reject(error);
    }).finally(() => {
      this.flushing.delete(controller);
      for (const entry of entries) entry.signal?.removeEventListener("abort", abandon);
      this.busy.delete(workspaceId);
      this.pump(workspaceId);
    });
  }
}

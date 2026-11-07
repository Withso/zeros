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
}
export type DesignThumbnailBatchRender = (
  group: DesignThumbnailGroup,
  frames: readonly DesignThumbnailFrame[],
  signal: AbortSignal,
) => Promise<DesignThumbnailBatchReply>;

interface Entry {
  readonly frame: DesignThumbnailFrame;
  readonly signal?: AbortSignal;
  readonly resolve: (reply: DesignPreviewReply) => void;
  readonly reject: (error: unknown) => void;
  settled: boolean;
  release(): void;
}
interface Pending {
  readonly group: DesignThumbnailGroup;
  entries: Entry[];
  timer: unknown;
}

/** Coalesces one-frame picture requests into engine batches: requests that
 * arrive within a short window (or fill a batch) are rendered together, and
 * each caller receives exactly its own frame's answer. A caller that cancels
 * is answered at once; a batch whose callers have all cancelled is aborted. */
export class DesignThumbnailBatches {
  private readonly pending = new Map<string, Pending>();
  private readonly flushing = new Set<AbortController>();

  constructor(private readonly render: DesignThumbnailBatchRender, private readonly options: {
    maxItems?: number;
    windowMs?: number;
    setTimer?: (callback: () => void, ms: number) => unknown;
    clearTimer?: (timer: unknown) => void;
  } = {}) {}

  private get maxItems() { return Math.max(1, this.options.maxItems ?? 64); }

  request(group: DesignThumbnailGroup, frame: DesignThumbnailFrame, signal?: AbortSignal): Promise<DesignPreviewReply> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Design thumbnail request cancelled."));
    const key = JSON.stringify([group.workspaceId, group.directoryId, group.theme, group.colorScheme, group.maxDimension]);
    return new Promise<DesignPreviewReply>((resolve, reject) => {
      let pending = this.pending.get(key);
      if (pending?.entries.some((entry) => entry.frame.file === frame.file && !entry.settled)) {
        // One frame appears once per batch: a second ask for it waits for the next.
        this.flush(key);
        pending = undefined;
      }
      if (!pending) {
        pending = { group, entries: [], timer: null };
        this.pending.set(key, pending);
      }
      const entry: Entry = {
        frame, signal, settled: false,
        resolve: (reply) => { if (!entry.settled) { entry.settled = true; entry.release(); resolve(reply); } },
        reject: (error) => { if (!entry.settled) { entry.settled = true; entry.release(); reject(error); } },
        release: () => {},
      };
      if (signal) {
        const aborted = () => entry.reject(signal.reason ?? new Error("Design thumbnail request cancelled."));
        signal.addEventListener("abort", aborted, { once: true });
        entry.release = () => signal.removeEventListener("abort", aborted);
      }
      pending.entries.push(entry);
      if (pending.entries.length >= this.maxItems) this.flush(key);
      else if (pending.timer === null)
        pending.timer = (this.options.setTimer ?? ((callback, ms) => setTimeout(callback, ms)))(() => this.flush(key), this.options.windowMs ?? 8);
    });
  }

  /** Requests and batches still waiting on the engine. */
  usage() {
    return { waiting: [...this.pending.values()].reduce((sum, pending) => sum + pending.entries.length, 0), batches: this.flushing.size };
  }

  private flush(key: string): void {
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);
    if (pending.timer !== null) (this.options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)))(pending.timer);
    const entries = pending.entries.filter((entry) => !entry.settled);
    if (!entries.length) return;
    const controller = new AbortController();
    this.flushing.add(controller);
    // Every caller cancelled: nothing awaits this batch's pictures.
    const abandon = () => { if (entries.every((entry) => entry.settled)) controller.abort(new Error("Design thumbnail batch abandoned.")); };
    for (const entry of entries) entry.signal?.addEventListener("abort", abandon, { once: true });
    void this.render(pending.group, entries.map((entry) => entry.frame), controller.signal).then((reply) => {
      const pictures = new Map(reply.pictures.map((picture) => [picture.file, picture]));
      const stale = new Map(reply.stale.map((frame) => [frame.file, frame]));
      const failed = new Map(reply.failed.map((frame) => [frame.file, frame]));
      for (const entry of entries) {
        const picture = pictures.get(entry.frame.file);
        const moved = stale.get(entry.frame.file);
        if (picture && picture.sourceVersion === entry.frame.sourceVersion) {
          entry.resolve({ sourceVersion: picture.sourceVersion, theme: pending.group.theme, mimeType: "image/png",
            width: picture.width, height: picture.height, data: picture.data });
        } else if (moved) entry.resolve({ stale: true, sourceVersion: moved.sourceVersion });
        else entry.reject(new Error(failed.get(entry.frame.file)?.error ?? "Design thumbnail batch did not picture this frame."));
      }
    }, (error: unknown) => {
      for (const entry of entries) entry.reject(error);
    }).finally(() => {
      this.flushing.delete(controller);
      for (const entry of entries) entry.signal?.removeEventListener("abort", abandon);
    });
  }
}

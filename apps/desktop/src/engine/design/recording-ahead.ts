// Records Design frames ahead of their next open. Frames that a worktree change
// reaches, and frames new to the catalog, are recorded in the background, in
// the theme and color scheme the recorded canvas last drew, so opening their
// page later costs a stored read instead of preparing, composing and
// recording. Local only, and only for checkouts whose canvas has asked for
// recordings in this engine session.
import path from "node:path";
import { DESIGN_MAX_FRAMES_PER_PAGE } from "@zeros/protocol/design-pages";
import type { DesignFramesChange } from "@zeros/protocol/messages";
import { designCatalogRevision, inspectDesignCatalog } from "./catalog-storage";
import { designDirectoryNameFor } from "./directory-registry";
import { prepareDesignNavigationFrames } from "./document";
import { readSharedCanvasContext } from "./document-storage";
import { designDirectoryEntry } from "./metadata";
import { designRecordingsRendering, recordDesignFramesAhead, type DesignRecordingDeps } from "./recording-batch";

/** How long a checkout's changes must rest first: an agent writes in bursts. */
export const DESIGN_RECORDING_AHEAD_QUIET_MS = 2_000;
/** Frames prepared and recorded at a time. Preparation holds the checkout's
 * mutation lane, so a small batch keeps an edit's wait short. */
export const DESIGN_RECORDING_AHEAD_BATCH = 8;
/** How often waiting work checks whether the canvas is still recording. */
const POLL_MS = 250;

/** What the recorded canvas last drew in a Design directory. */
export interface DesignRecordingAheadTarget {
  readonly workspaceId: string;
  readonly root: string;
  readonly directoryId: string;
  readonly theme: string | null;
  readonly colorScheme: "light" | "dark";
}

export interface DesignRecordingAheadDeps {
  /** The directory's catalog frames. */
  frames(target: DesignRecordingAheadTarget): Promise<readonly string[]>;
  /** The directory's catalog revision, or null once it isn't the checkout's active directory. */
  revision(target: DesignRecordingAheadTarget): Promise<string | null>;
  /** Each frame's source version, as the engine prepares it for a renderer. */
  prepare(target: DesignRecordingAheadTarget, revision: string, files: readonly string[]):
    Promise<ReadonlyArray<{ file: string; sourceVersion?: string }>>;
  /** Records and stores frames, answering no one. */
  record(target: DesignRecordingAheadTarget, frames: ReadonlyArray<{ file: string; sourceVersion: string }>): Promise<void>;
  /** Whether a canvas is recording what it shows: work ahead waits for it. */
  busy(): boolean;
  /** The directory's folder, absolute, or null once it isn't the checkout's active one. */
  folder(target: DesignRecordingAheadTarget): string | null;
}

const keyOf = (root: string, directoryId: string) => `${path.resolve(root)}\0${directoryId}`;

export class DesignRecordingAhead {
  /** By checkout and directory; `known` is the catalog's frames when last read. */
  private readonly targets = new Map<string, { target: DesignRecordingAheadTarget; known: ReadonlySet<string> | null }>();
  /** Changed frames per checkout and directory; ready once its timer has fired. */
  private readonly pending = new Map<string, { files: Set<string>; catalog: boolean; timer: ReturnType<typeof setTimeout> | null }>();
  private draining = false;
  private stopped = false;
  private sleeping: { timer: ReturnType<typeof setTimeout>; resolve: () => void } | null = null;

  constructor(private readonly deps: DesignRecordingAheadDeps) {}

  /** A canvas's recordings request: it draws this directory in this theme and
   * scheme. Settles once the directory's catalog is known. */
  noteTarget(target: DesignRecordingAheadTarget): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const key = keyOf(target.root, target.directoryId);
    const entry = this.targets.get(key);
    this.targets.set(key, { target, known: entry?.known ?? null });
    if (entry) return Promise.resolve();
    return this.deps.frames(target).then((frames) => {
      const current = this.targets.get(key);
      if (current && !current.known) current.known = new Set(frames);
    }, () => {});
  }

  /** A change the engine published for a checkout. A whole-directory change
   * (a style source, a directory switch) is left to the next open. */
  noteChange(root: string, change: DesignFramesChange): void {
    if (this.stopped || change.all) return;
    const key = keyOf(root, change.directoryId);
    if (this.targets.has(key)) this.queue(key, change.frames, change.catalog);
  }

  /** A file changed in a checkout's worktree. Change events name only frames
   * this engine has prepared, so a frame's own source file is matched here:
   * after a restart, edits on pages no canvas has opened still count. */
  noteFile(root: string, file: string): void {
    if (this.stopped) return;
    const resolved = path.resolve(file);
    for (const [key, { target, known }] of this.targets) {
      if (!known || path.resolve(target.root) !== path.resolve(root)) continue;
      const folder = this.deps.folder(target);
      if (!folder || !resolved.startsWith(`${path.resolve(folder)}${path.sep}`)) continue;
      const frame = path.relative(folder, resolved).split(path.sep).join("/");
      if (known.has(frame)) this.queue(key, [frame], false);
    }
  }

  private queue(key: string, files: readonly string[], catalog: boolean): void {
    let entry = this.pending.get(key);
    if (!entry) { entry = { files: new Set(), catalog: false, timer: null }; this.pending.set(key, entry); }
    for (const file of files) if (entry.files.size < DESIGN_MAX_FRAMES_PER_PAGE) entry.files.add(file);
    entry.catalog ||= catalog;
    if (entry.timer) clearTimeout(entry.timer);
    const ready = entry;
    ready.timer = setTimeout(() => { ready.timer = null; this.drain(); }, DESIGN_RECORDING_AHEAD_QUIET_MS);
    ready.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    for (const entry of this.pending.values()) if (entry.timer) clearTimeout(entry.timer);
    this.pending.clear();
    this.targets.clear();
    if (this.sleeping) { clearTimeout(this.sleeping.timer); this.sleeping.resolve(); this.sleeping = null; }
  }

  private readyKey(): string | null {
    for (const [key, entry] of this.pending) if (!entry.timer) return key;
    return null;
  }

  private drain(): void {
    if (this.draining || this.stopped) return;
    this.draining = true;
    void this.run().catch(() => {}).finally(() => {
      this.draining = false;
      if (this.readyKey()) this.drain();
    });
  }

  private async run(): Promise<void> {
    for (let key = this.readyKey(); key && !this.stopped; key = this.readyKey()) {
      const entry = this.pending.get(key)!;
      this.pending.delete(key);
      const files = new Set(entry.files);
      if (entry.catalog) for (const file of await this.newFrames(key)) files.add(file);
      const list = [...files];
      for (let at = 0; at < list.length; at += DESIGN_RECORDING_AHEAD_BATCH) {
        if (!(await this.quiet())) return;
        // A later request may have changed the theme or scheme in the meantime.
        const target = this.targets.get(key)?.target;
        if (!target) break;
        try {
          const revision = await this.deps.revision(target);
          if (!revision) break;
          const prepared = (await this.deps.prepare(target, revision, list.slice(at, at + DESIGN_RECORDING_AHEAD_BATCH)))
            .flatMap((frame) => frame.sourceVersion ? [{ file: frame.file, sourceVersion: frame.sourceVersion }] : []);
          if (!prepared.length || !(await this.quiet())) continue;
          await this.deps.record(target, prepared);
        } catch {
          // A frame that couldn't be recorded now is recorded when it's next opened.
        }
      }
    }
  }

  /** Frames the catalog gained since it was last read. */
  private async newFrames(key: string): Promise<string[]> {
    const entry = this.targets.get(key);
    if (!entry) return [];
    let frames: readonly string[];
    try { frames = await this.deps.frames(entry.target); } catch { return []; }
    const known = entry.known;
    entry.known = new Set(frames);
    return known ? frames.filter((file) => !known.has(file)).slice(0, DESIGN_MAX_FRAMES_PER_PAGE) : [];
  }

  /** Waits while a canvas is recording; false once stopped. */
  private async quiet(): Promise<boolean> {
    while (!this.stopped && this.deps.busy()) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { this.sleeping = null; resolve(); }, POLL_MS);
        timer.unref?.();
        this.sleeping = { timer, resolve };
      });
    }
    return !this.stopped;
  }
}

/** The engine's own preparation, catalog and recording path. */
export function designRecordingAheadDeps(recording: DesignRecordingDeps = {}): DesignRecordingAheadDeps {
  return {
    frames: async (target) => Object.keys((await readSharedCanvasContext(target.root)).canvas.frames),
    revision: async (target) => {
      const inspection = inspectDesignCatalog(target.root, designDirectoryNameFor(target.root), { revision: false });
      return inspection.layout.manifest.id === target.directoryId ? designCatalogRevision(inspection) : null;
    },
    prepare: async (target, revision, files) =>
      (await prepareDesignNavigationFrames(target.root, revision, files, target.directoryId)).frames,
    record: async (target, frames) => {
      await recordDesignFramesAhead(target.root, { workspaceId: target.workspaceId, directoryId: target.directoryId,
        theme: target.theme, colorScheme: target.colorScheme, frames: [...frames] }, recording);
    },
    busy: designRecordingsRendering,
    folder: (target) => {
      const directory = designDirectoryNameFor(target.root);
      return designDirectoryEntry(target.root, directory)?.id === target.directoryId
        ? path.join(target.root, ...directory.split("/")) : null;
    },
  };
}

import path from "node:path";
import { DESIGN_MAX_FRAMES_PER_PAGE } from "@zeros/protocol/design-pages";
import type { DesignFramesChange } from "@zeros/protocol/messages";
import { designFrameIdentityContexts, lastPreparedDesignCanvas } from "./document";
import { readSharedCanvasContext } from "./document-storage";
import { designFramesReading, designFramesWithStaleIdentities, designIdentityDirectories } from "./identity-cache";

const DELAY_MS = 100;
/** Past this many frames a change is published as `all`. */
const MAX_FRAMES = DESIGN_MAX_FRAMES_PER_PAGE;
/** Remembered frames a turn-end check re-verifies before it gives up for `all`. */
const VERIFY_LIMIT = 5_000;
/** A Design directory's catalog, as opposed to the inputs of its frames. */
const CATALOG_FILES = ["meta/canvas.json", "meta/design.toml", "rules.md"];

export interface DesignFrameChangesHost {
  /** A checkout's active Design directory, or null when it has none. */
  directory(workspacePath: string): { name: string; id: string } | null;
  publish(workspacePath: string, change: DesignFramesChange): void;
}

/** Names the Design frames a worktree change reaches, so a renderer
 * re-prepares those frames instead of every frame it shows. Attribution uses
 * the read sets the identity cache remembered: they cover every frame this
 * engine prepared since it started, which is every frame a connected renderer
 * holds, since a renderer revalidates on connect. */
export class DesignFrameChanges {
  private readonly pending = new Map<string, { paths: Set<string>; timer: ReturnType<typeof setTimeout> }>();
  private readonly verifying = new Map<string, Promise<void>>();
  private sequence = 0;
  private stopped = false;

  constructor(private readonly host: DesignFrameChangesHost, private readonly delayMs = DELAY_MS) {}

  /** A file changed in a checkout's worktree. */
  note(workspacePath: string, file: string): void {
    if (this.stopped) return;
    const root = path.resolve(workspacePath);
    let entry = this.pending.get(root);
    if (!entry) {
      const timer = setTimeout(() => void this.flush(root).catch(() => {}), this.delayMs);
      timer.unref?.();
      entry = { paths: new Set(), timer };
      this.pending.set(root, entry);
    }
    entry.paths.add(path.resolve(file));
  }

  async flush(workspacePath: string): Promise<void> {
    const root = path.resolve(workspacePath);
    const entry = this.pending.get(root);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(root);
    const directory = this.host.directory(root);
    if (!directory || this.stopped) return;
    const change = await this.attribute(root, directory.name, entry.paths);
    if (change && !this.stopped) this.host.publish(root, { directoryId: directory.id, sequence: ++this.sequence, ...change });
  }

  /** Re-verify remembered identities after work no watcher reports (an agent
   * installing packages, writing ignored folders): every checkout with
   * remembered frames publishes the frames whose identity no longer holds. */
  verifyAll(): Promise<void> {
    return Promise.all(designIdentityDirectories().map(({ workspacePath }) => this.verify(workspacePath))).then(() => {});
  }

  private verify(root: string): Promise<void> {
    const running = this.verifying.get(root);
    if (running) return running;
    const run = (async () => {
      const directory = this.host.directory(root);
      if (!directory || this.stopped) return;
      const stale = await designFramesWithStaleIdentities(root, directory.name, VERIFY_LIMIT);
      if (this.stopped || (stale !== null && stale.length === 0)) return;
      const all = stale === null || stale.length > MAX_FRAMES;
      this.host.publish(root, { directoryId: directory.id, sequence: ++this.sequence,
        frames: all ? [] : stale.sort(), catalog: false, all });
    })().catch(() => {}).finally(() => this.verifying.delete(root));
    this.verifying.set(root, run);
    return run;
  }

  private async attribute(root: string, directory: string, paths: ReadonlySet<string>) {
    const folder = path.join(root, ...directory.split("/"));
    const inside = (file: string) => file.startsWith(`${folder}${path.sep}`);
    // The private pointer to the active directory, or a legacy registration:
    // the directory itself may have changed.
    const zeros = path.join(root, ".zeros");
    if ([...paths].some((file) => file.startsWith(`${zeros}${path.sep}`) || file === path.join(root, "design.toml")))
      return { frames: [], catalog: true, all: true };
    const catalog = [...paths].some((file) => CATALOG_FILES.some((name) => file === path.join(folder, ...name.split("/"))));
    const reading = designFramesReading(root, directory, paths);
    const frames = new Set(reading.frames);
    let all = false;
    // A frame whose reads were not recorded may have read anything here.
    if (reading.unknown.length > 0 && [...paths].some(inside)) for (const file of reading.unknown) frames.add(file);
    if (catalog) {
      const before = lastPreparedDesignCanvas(root);
      const after = before ? await readSharedCanvasContext(root).then(({ canvas }) => canvas, () => null) : null;
      if (!before || !after) all = true;
      else {
        // Canvas-wide inputs (style sources, fonts, themes) are in every
        // frame's context, so a change there names every frame.
        const was = designFrameIdentityContexts(before);
        for (const [file, context] of designFrameIdentityContexts(after))
          if (was.has(file) && was.get(file) !== context) frames.add(file);
      }
    }
    if (!catalog && !all && frames.size === 0) return null;
    if (frames.size > MAX_FRAMES) all = true;
    return { frames: all ? [] : [...frames].sort(), catalog, all };
  }

  stop(): void {
    this.stopped = true;
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }
}

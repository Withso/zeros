// ──────────────────────────────────────────────────────────
// Design frame previews — pictures of saved frames for the canvas
// ──────────────────────────────────────────────────────────
//
// A frame that is not live on the canvas paints a picture instead of its
// document. Pictures come from the workspace's capture host
// (`design.preview`), which renders the saved source the way `design capture`
// does (shadow DOM, imported styles, the canvas theme, animations still), so a
// picture never needs the frame's iframe. They are made once per source
// generation and kept:
//
//   • memory — encoded Blobs behind object URLs (never base64 in the JS heap)
//     in the shared DesignPreviewCache pool: bounded in bytes, least recently
//     shown evicted, shown pictures leased;
//   • disk   — an IndexedDB copy (purgeable OS cache directory) bounded in
//     bytes, one picture per frame, theme and level, so a reopened page paints
//     every picture it already has before anything renders.
//
// Keys name the exact owner scope, workspace, Design directory, frame, source
// generation, theme and level; a late picture for another owner can neither
// render nor replace this one. Cloud pictures belong to the signed-in account
// and are made only while the workspace's VM is running: a passive canvas
// never wakes it. One picture renders at a time through the canvas's
// background lane, which yields to gestures and input; a frame that is live
// waits for its generation to settle, so editing it renders no pictures.
// ──────────────────────────────────────────────────────────

import type { DesignPreviewReply } from "@zeros/protocol/design-capture";
import type {
  DesignPreviewIndexEntry,
  DesignPreviewStore,
} from "../../../platform/design-preview-store";
import { DesignPreviewCache, type DesignPreviewBlobImage } from "./design-preview-cache";
import { DESIGN_IMAGE_DECODED_BYTES, type DesignImageResidency } from "./design-image-residency";

/** Longest side, in device pixels, of each picture level. */
export const DESIGN_PREVIEW_LEVELS = { thumbnail: 128, overview: 384, detail: 1280 } as const;
export type DesignPreviewLevel = keyof typeof DESIGN_PREVIEW_LEVELS;
export const DESIGN_PREVIEW_MEMORY_BYTES = 16 * 1024 * 1024;
export const DESIGN_PREVIEW_DISK_BYTES = 48 * 1024 * 1024;
/** The capture host's PNG bound; an encoded picture is never larger. */
const MAX_PICTURE_BYTES = 1024 * 1024;
// Version 1 captures flattened transparent documents onto the native window's
// opaque backing color. These are disposable pixels, never authored source.
const FORMAT_VERSION = 2;
/** A live frame paints its own document. Its new generation is pictured once
 * it has stopped changing, so typing in a frame renders no pictures. */
export const DESIGN_PREVIEW_LIVE_SETTLE_MS = 2_000;
const READ_BATCH = 64;
const TOUCH_FLUSH_MS = 10_000;
const CHANGE_BATCH_MS = 100;
const HOST_UNAVAILABLE_BACKOFF_MS = 5 * 60_000;
const FAILURE_BACKOFF_MS = 15_000;
const CAPACITY_BACKOFF_MS = 2_000;
const MAX_CAPACITY_BACKOFF_MS = 30_000;
const MAX_FAILURES = 2;
const MAX_CAPACITY_RETRIES = 6;

export interface DesignPreviewOwner {
  /** `local`, or `cloud:<account digest>` for the signed-in cloud account. */
  readonly scope: string;
  readonly workspaceId: string;
  readonly directoryId: string;
}

export interface DesignPreviewTarget {
  readonly owner: DesignPreviewOwner;
  readonly file: string;
  readonly sourceVersion: string;
  readonly theme: string | null;
  readonly level: DesignPreviewLevel;
}

export interface DesignPreviewPicture {
  readonly key: string;
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly sourceVersion: string;
  readonly level: DesignPreviewLevel;
  /** False for an older generation shown until the current one is ready. */
  readonly current: boolean;
}

export interface DesignPreviewPictureLease {
  readonly picture: DesignPreviewPicture;
  /** A decoded, still-owned cover can take over from a live document. */
  confirmDecoded(): void;
  release(): void;
}

export interface DesignPreviewDemandItem {
  readonly file: string;
  readonly sourceVersion: string;
  readonly level: DesignPreviewLevel;
  readonly live: boolean;
  /** False beyond one viewport of the screen. An owner that renders only
   * nearby frames paints such a frame from disk alone. Omitted is near. */
  readonly near?: boolean;
}

/** One canvas's wanted pictures, most important first. */
export interface DesignPreviewDemand {
  readonly owner: DesignPreviewOwner;
  readonly theme: string | null;
  readonly items: readonly DesignPreviewDemandItem[];
}

export function activeDesignPreviewDemand(
  active: boolean,
  owner: DesignPreviewOwner | null,
  theme: string | null,
  items: readonly DesignPreviewDemandItem[],
): DesignPreviewDemand | null {
  // An HTML-only canvas still opens the small metadata index once so stale
  // disk pictures are pruned. Empty items never read blobs or start captures;
  // a hidden canvas remains inert.
  return active && owner ? { owner, theme, items } : null;
}

export interface DesignFramePreviewDependencies {
  readonly store: DesignPreviewStore | null;
  render(
    owner: DesignPreviewOwner,
    input: {
      file: string;
      sourceVersion: string;
      theme: string | null;
      maxDimension: number;
    },
    signal?: AbortSignal,
  ): Promise<DesignPreviewReply>;
  /** The canvas background lane: one task at a time, after input settles. */
  schedule<T>(work: () => Promise<T>, capture?: { key: string; signal: AbortSignal; priority: "visible" | "detail" | "nearby" }): Promise<T | null>;
  /** Re-encode a PNG picture smaller where the platform can. */
  encode(png: Blob, level: DesignPreviewLevel): Promise<Blob>;
  /** Cloud pictures render only while the VM runs; Local always may. */
  canProduce(owner: DesignPreviewOwner): boolean;
  /** Whether frames beyond one viewport render too (default yes). A cloud
   * capture starts a browser on the VM the agents run on. */
  rendersFar?(owner: DesignPreviewOwner): boolean;
  /** The pause after one render before the next for this owner (default
   * none), which leaves its capture host free for explicit captures. */
  renderGapMs?(owner: DesignPreviewOwner): number;
  createUrl(blob: Blob): string;
  revokeUrl(url: string): void;
  now(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** False while the app window is hidden. */
  visible(): boolean;
  memoryBytes?: number;
  diskBytes?: number;
  decodedBytes?: number;
  displayBudget?: DesignImageResidency;
}

/** A picture in memory; its Blob, URL, bytes and leases live in the pool. */
interface Picture {
  readonly key: string;
  readonly frameKey: string;
  readonly workspaceId: string;
  readonly scope: string;
  readonly level: DesignPreviewLevel;
  readonly sourceVersion: string;
  readonly views: { current: DesignPreviewPicture; stale: DesignPreviewPicture };
}

/** Encoded pictures remain cacheable independently of visible pixel leases. */
const POOL_MAX_ENTRIES = 10_000;

interface Attempt {
  failures: number;
  capacity: number;
  retryAt: number;
}

const LEVELS: readonly DesignPreviewLevel[] = ["thumbnail", "overview", "detail"];

function pictureLevels(level: DesignPreviewLevel): DesignPreviewLevel[] {
  const index = LEVELS.indexOf(level);
  return [level, ...LEVELS.slice(index + 1), ...LEVELS.slice(0, index).reverse()];
}

export function designPreviewFrameKey(
  owner: DesignPreviewOwner,
  file: string,
  theme: string | null,
): string {
  return JSON.stringify([owner.scope, owner.workspaceId, owner.directoryId, file, theme ?? ""]);
}

export function designPreviewKey(target: DesignPreviewTarget): string {
  const { owner } = target;
  return JSON.stringify([FORMAT_VERSION, owner.scope, owner.workspaceId, owner.directoryId,
    target.file, target.theme ?? "", target.level, target.sourceVersion]);
}

function isCurrentPreviewFormat(row: DesignPreviewIndexEntry): boolean {
  try {
    const key: unknown = JSON.parse(row.key);
    return Array.isArray(key) && key.length === 8 && key[0] === FORMAT_VERSION &&
      key.slice(1).every(value => typeof value === "string") &&
      key[2] === row.workspaceId && key[6] === row.level && key[7] === row.sourceVersion &&
      JSON.stringify(key.slice(1, 6)) === row.frameKey;
  } catch { return false; }
}

/** The level that stays sharp for a frame painted `devicePixels` on its
 * longest side. Above the detail level the canvas makes the frame live. */
export function designPreviewLevelFor(devicePixels: number): DesignPreviewLevel {
  return devicePixels <= DESIGN_PREVIEW_LEVELS.thumbnail ? "thumbnail" :
    devicePixels <= DESIGN_PREVIEW_LEVELS.overview ? "overview" : "detail";
}

interface DemandFrame {
  readonly file: string;
  readonly sourceVersion: string;
  readonly kind?: "frame" | "text";
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Pictures one canvas wants, most important first: visible frames that are
 * not live (nearest the centre first), visible live frames (their picture
 * covers a reload), frames within one viewport, then the rest of the page,
 * marked not `near`. Visible frames get the level their painted size needs;
 * a frame shown in detail also gets an overview for when the canvas zooms
 * out. Text frames use the same path with their authored transparency. */
export function designPreviewDemandItems(input: {
  frames: readonly DemandFrame[];
  view: { zoom: number; panX: number; panY: number };
  viewport: { width: number; height: number };
  devicePixelRatio: number;
  live: ReadonlySet<string>;
}): DesignPreviewDemandItem[] {
  const zoom = Number.isFinite(input.view.zoom) && input.view.zoom > 0 ? input.view.zoom : 1;
  const ratio = Number.isFinite(input.devicePixelRatio) && input.devicePixelRatio > 0 ? input.devicePixelRatio : 1;
  const left = -input.view.panX / zoom;
  const top = -input.view.panY / zoom;
  const width = Math.max(0, input.viewport.width) / zoom;
  const height = Math.max(0, input.viewport.height) / zoom;
  const centerX = left + width / 2;
  const centerY = top + height / 2;
  const intersects = (frame: DemandFrame, margin: number) =>
    frame.x + frame.width >= left - margin * width &&
    frame.x <= left + width + margin * width &&
    frame.y + frame.height >= top - margin * height &&
    frame.y <= top + height + margin * height;
  const ranked: Array<{ item: DesignPreviewDemandItem; tier: number; distance: number }> = [];
  for (const frame of input.frames) {
    const live = input.live.has(frame.file);
    const visible = width > 0 && height > 0 && intersects(frame, 0);
    const near = !visible && width > 0 && height > 0 && intersects(frame, 1);
    const dx = frame.x + frame.width / 2 - centerX;
    const dy = frame.y + frame.height / 2 - centerY;
    const distance = dx * dx + dy * dy;
    const level = visible && !live
      ? designPreviewLevelFor(Math.max(frame.width, frame.height) * zoom * ratio)
      : "overview";
    const tier = visible ? (live ? 1 : 0) : near ? 2 : 3;
    ranked.push({
      item: { file: frame.file, sourceVersion: frame.sourceVersion, level, live, ...(tier === 3 ? { near: false } : {}) },
      tier, distance,
    });
    if (level === "detail") {
      ranked.push({
        item: { file: frame.file, sourceVersion: frame.sourceVersion, level: "overview", live, near: false },
        tier: 3, distance,
      });
    }
  }
  ranked.sort((a, b) =>
    a.tier - b.tier || a.distance - b.distance || a.item.file.localeCompare(b.item.file) ||
    a.item.level.localeCompare(b.item.level));
  return ranked.map((entry) => entry.item);
}

function sameOwner(a: DesignPreviewOwner, b: DesignPreviewOwner): boolean {
  return a.scope === b.scope && a.workspaceId === b.workspaceId && a.directoryId === b.directoryId;
}

function sameDemand(a: DesignPreviewDemand | null, b: DesignPreviewDemand | null): boolean {
  if (a === b) return true;
  if (!a || !b || !sameOwner(a.owner, b.owner) || a.theme !== b.theme || a.items.length !== b.items.length)
    return false;
  return a.items.every((item, index) => {
    const other = b.items[index]!;
    return item.file === other.file && item.sourceVersion === other.sourceVersion &&
      item.level === other.level && item.live === other.live && (item.near !== false) === (other.near !== false);
  });
}

function decodeBase64(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class DesignFramePreviews {
  private readonly diskBudget: number;
  /** Encoded pictures, their object URLs and leases. */
  private readonly memory: DesignPreviewCache<DesignPreviewBlobImage>;
  /** The pictures in the pool, by key. */
  private readonly pictures = new Map<string, Picture>();
  /** Decoded display leases, independent of encoded cache availability. */
  private readonly decodedDisplays = new Map<string, number>();
  /** frameKey → level → newest picture key in memory. */
  private readonly newest = new Map<string, Map<DesignPreviewLevel, string>>();
  private index: Map<string, DesignPreviewIndexEntry> | null = null;
  private indexLoad: Promise<void> | null = null;
  /** frameKey → level → the one disk key kept for it. */
  private readonly diskNewest = new Map<string, Map<DesignPreviewLevel, string>>();
  private diskBytes = 0;
  private readonly reading = new Set<string>();
  private readonly touched = new Set<string>();
  private touchTimer: unknown = null;
  private commits: Promise<void> = Promise.resolve();
  private readonly versions = new Map<string, number>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly changeListeners = new Set<() => void>();
  private changeVersion = 0;
  private changeTimer: unknown = null;
  private demandToken: object | null = null;
  private demand: DesignPreviewDemand | null = null;
  /** Retiring or replacing the owning canvas invalidates pending work even
   * if it returns to the same owner and generation before that work ends. */
  private productionEpoch = 0;
  private producing = false;
  private production: { controller: AbortController; demand: DesignPreviewDemand; item: DesignPreviewDemandItem; epoch: number } | null = null;
  private pumpTimer: unknown = null;
  private readonly attempts = new Map<string, Attempt>();
  /** Keys whose engine answer was stale; a refreshed snapshot supersedes them. */
  private readonly stale = new Set<string>();
  /** Keys rendered this session. A picture evicted from memory or disk is
   * read back from disk if it is still there, never rendered again, so a
   * page larger than a budget cannot render in a loop. */
  private readonly made = new Set<string>();
  private readonly hostRetryAt = new Map<string, number>();
  /** workspaceId → when its last render ended, for the owner's render gap. */
  private readonly renderedAt = new Map<string, number>();
  private readonly firstSeen = new Map<string, number>();
  /** frameKey → the generation the current demand shows. */
  private readonly wanted = new Map<string, string>();

  constructor(private readonly deps: DesignFramePreviewDependencies) {
    this.diskBudget = deps.diskBytes ?? DESIGN_PREVIEW_DISK_BYTES;
    this.memory = new DesignPreviewCache<DesignPreviewBlobImage>(
      {
        maxEntries: POOL_MAX_ENTRIES,
        maxEncodedBytes: deps.memoryBytes ?? DESIGN_PREVIEW_MEMORY_BYTES,
        maxDecodedBytes: deps.decodedBytes ?? DESIGN_IMAGE_DECODED_BYTES,
      },
      {
        evicted: (key) => {
          const picture = this.pictures.get(key);
          if (picture) this.forget(picture);
        },
        disposed: (image) => this.deps.revokeUrl(image.url),
      },
      deps.displayBudget,
    );
  }

  // ── Display ────────────────────────────────────────────

  /** The best picture for `target`: its generation at the wanted level, else
   * at the other level, else the newest older picture of the frame (marked
   * not current) so a changed frame never flashes blank while it re-renders. */
  picture(target: DesignPreviewTarget): DesignPreviewPicture | null {
    return this.candidates(target)[0] ?? null;
  }

  private candidates(target: DesignPreviewTarget): DesignPreviewPicture[] {
    const frameKey = designPreviewFrameKey(target.owner, target.file, target.theme);
    const levels = pictureLevels(target.level);
    const result: DesignPreviewPicture[] = [];
    for (const level of levels) {
      const picture = this.pictures.get(designPreviewKey({ ...target, level }));
      if (picture) result.push(picture.views.current);
    }
    const newest = this.newest.get(frameKey);
    for (const level of levels) {
      const key = newest?.get(level);
      const picture = key ? this.pictures.get(key) : undefined;
      if (picture && !result.some((candidate) => candidate.key === picture.key))
        result.push(picture.sourceVersion === target.sourceVersion ? picture.views.current : picture.views.stale);
    }
    return result;
  }

  /** Admission reserves pixels before any <img> or decoder receives the URL.
   * Try a cached smaller picture if detail would exceed the display budget. */
  acquire(target: DesignPreviewTarget, accept?: (picture: DesignPreviewPicture) => boolean): DesignPreviewPictureLease | null {
    const candidates = this.candidates(target).filter(picture => !accept || accept(picture));
    // Optional refinement must try an already cached smaller cover before
    // reclaiming another frame's warm pixels. A genuinely cold display may
    // still request pressure after every non-evicting candidate failed.
    for (const preserveWarm of [true, false]) for (const picture of candidates) {
      const lease = this.memory.acquire(picture.key, { preserveWarm });
      if (!lease) continue;
      const frameKey = designPreviewFrameKey(target.owner, target.file, target.theme);
      let released = false, decoded = false;
      return {
        picture,
        confirmDecoded: () => {
          if (released || decoded) return;
          decoded = true;
          this.decodedDisplays.set(picture.key, (this.decodedDisplays.get(picture.key) ?? 0) + 1);
          this.changed(frameKey);
        },
        release: () => {
          if (released) return;
          released = true;
          if (decoded) {
            const remaining = (this.decodedDisplays.get(picture.key) ?? 1) - 1;
            if (remaining) this.decodedDisplays.set(picture.key, remaining);
            else this.decodedDisplays.delete(picture.key);
            this.changed(frameKey);
          }
          lease.release();
        },
      };
    }
    return null;
  }

  subscribeAvailable(listener: () => void): () => void {
    return this.memory.subscribeAvailable(listener);
  }

  /** Frames among `frames` that have a picture of their current generation. */
  pictured(
    owner: DesignPreviewOwner,
    theme: string | null,
    frames: readonly { file: string; sourceVersion: string; width?: number; height?: number }[],
    renderScale = 0,
    requireDecodedDisplay = false,
  ): Set<string> {
    const result = new Set<string>();
    for (const frame of frames) {
      const minimum = Math.min(DESIGN_PREVIEW_LEVELS.overview, Math.max(frame.width ?? 0, frame.height ?? 0) * renderScale);
      if (LEVELS.some((level) => {
        const picture = this.pictures.get(designPreviewKey({ owner, file: frame.file, sourceVersion: frame.sourceVersion, theme, level }));
        return picture && (!requireDecodedDisplay || this.decodedDisplays.has(picture.key)) &&
          Math.max(picture.views.current.width, picture.views.current.height) >= minimum;
      })) result.add(frame.file);
    }
    return result;
  }

  /** A shown picture is never evicted; release it when it stops showing. */
  pin(key: string): () => void {
    const lease = this.memory.acquire(key);
    return lease ? () => lease.release() : () => {};
  }

  subscribe(frameKey: string, listener: () => void): () => void {
    let set = this.listeners.get(frameKey);
    if (!set) this.listeners.set(frameKey, (set = new Set()));
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (!set!.size) this.listeners.delete(frameKey);
    };
  }

  version(frameKey: string): number {
    return this.versions.get(frameKey) ?? 0;
  }

  /** Batched: fires at most every 100ms while pictures arrive. */
  subscribeChanges(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  }

  changes(): number {
    return this.changeVersion;
  }

  usage() {
    const memory = this.memory.getUsage();
    return { memoryBytes: memory.encodedBytes, decodedBytes: memory.decodedBytes,
      retainedPictures: memory.entries, pictures: this.pictures.size, diskBytes: this.diskBytes,
      diskPictures: this.index?.size ?? 0, reading: this.reading.size, producing: this.producing ? 1 : 0,
      demanded: this.demand?.items.length ?? 0 };
  }

  // ── Demand ─────────────────────────────────────────────

  /** The active canvas states what it shows. `null` from the canvas that set
   * the current demand clears it (hidden, unmounted or another owner). */
  setDemand(token: object, demand: DesignPreviewDemand | null): void {
    if (!demand) {
      if (this.demandToken !== token) return;
      this.clearDemand();
      return;
    }
    const changed = this.demandToken !== token || !sameDemand(this.demand, demand);
    if (this.demandToken !== token || !this.demand ||
      !sameOwner(this.demand.owner, demand.owner) || this.demand.theme !== demand.theme)
      this.productionEpoch++;
    this.demandToken = token;
    if (!changed) return;
    const now = this.deps.now();
    for (const item of demand.items) {
      const key = designPreviewKey({ owner: demand.owner, theme: demand.theme, ...item });
      if (!this.firstSeen.has(key)) this.firstSeen.set(key, now);
    }
    while (this.firstSeen.size > 4096) this.firstSeen.delete(this.firstSeen.keys().next().value!);
    this.demand = demand;
    this.cancelObsoleteProduction();
    this.wanted.clear();
    for (const item of demand.items)
      this.wanted.set(designPreviewFrameKey(demand.owner, item.file, demand.theme), item.sourceVersion);
    this.hydrate(demand);
    this.pump();
  }

  private clearDemand(): void {
    this.productionEpoch++;
    this.demandToken = null;
    this.demand = null;
    this.cancelObsoleteProduction();
    this.wanted.clear();
    if (this.pumpTimer !== null) this.deps.clearTimer(this.pumpTimer);
    this.pumpTimer = null;
  }

  /** The window became visible, a VM started, or a retry came due. */
  resume(): void {
    this.cancelObsoleteProduction();
    this.pump();
  }

  private cancelObsoleteProduction(): void {
    const production = this.production;
    if (production && !this.canAccept(production.demand, production.item, production.epoch))
      production.controller.abort(new Error("Design preview owner or generation retired."));
  }

  // ── Owners ─────────────────────────────────────────────

  /** Drop memory pictures of other cloud accounts (disk keeps them, keyed to
   * their own account). Shown pictures go once they stop showing. */
  retainCloudScope(scope: string | null): void {
    if (this.demand && this.demand.owner.scope.startsWith("cloud:") && this.demand.owner.scope !== scope)
      this.clearDemand();
    for (const picture of [...this.pictures.values()]) {
      if (picture.scope.startsWith("cloud:") && picture.scope !== scope) this.drop(picture);
    }
  }

  /** A workspace was removed: forget its pictures in memory and on disk. */
  forgetWorkspaces(workspaceIds: readonly string[]): void {
    if (!workspaceIds.length) return;
    const removed = new Set(workspaceIds);
    if (this.demand && removed.has(this.demand.owner.workspaceId)) this.clearDemand();
    for (const picture of [...this.pictures.values()]) if (removed.has(picture.workspaceId)) this.drop(picture);
    void this.loadIndex().then(() => {
      const remove = [...this.index!.values()].filter((entry) => removed.has(entry.workspaceId))
        .map((entry) => entry.key);
      for (const key of remove) this.unindexRow(key);
      if (remove.length) this.commit({ remove });
    });
  }

  // ── Disk ───────────────────────────────────────────────

  private loadIndex(): Promise<void> {
    if (this.indexLoad) return this.indexLoad;
    const store = this.deps.store;
    this.indexLoad = (store ? store.readIndex() : Promise.resolve([] as DesignPreviewIndexEntry[]))
      .catch(() => [] as DesignPreviewIndexEntry[])
      .then((rows) => {
        this.index = new Map();
        // Keep one row per frame and level, newest first; the rest are leftovers
        // of an interrupted write and are deleted.
        const leftovers: string[] = [];
        for (const row of [...rows].sort((a, b) => b.savedAt - a.savedAt)) {
          const levels = this.diskNewest.get(row.frameKey);
          if (!isCurrentPreviewFormat(row) || levels?.has(row.level) || row.bytes > MAX_PICTURE_BYTES) {
            leftovers.push(row.key);
            continue;
          }
          this.indexRow(row);
        }
        const evicted = this.evictDisk(0);
        if (leftovers.length || evicted.length) this.commit({ remove: [...leftovers, ...evicted] });
      });
    return this.indexLoad;
  }

  private indexRow(row: DesignPreviewIndexEntry): void {
    this.index!.set(row.key, row);
    let levels = this.diskNewest.get(row.frameKey);
    if (!levels) this.diskNewest.set(row.frameKey, (levels = new Map()));
    levels.set(row.level, row.key);
    this.diskBytes += row.bytes;
  }

  private unindexRow(key: string): DesignPreviewIndexEntry | undefined {
    const row = this.index?.get(key);
    if (!row) return undefined;
    this.index!.delete(key);
    this.diskBytes -= row.bytes;
    const levels = this.diskNewest.get(row.frameKey);
    if (levels?.get(row.level) === key) levels.delete(row.level);
    if (levels && !levels.size) this.diskNewest.delete(row.frameKey);
    return row;
  }

  /** Least recently read rows that must go for `incoming` more bytes. */
  private evictDisk(incoming: number): string[] {
    if (this.diskBytes + incoming <= this.diskBudget) return [];
    const evicted: string[] = [];
    for (const row of [...this.index!.values()].sort((a, b) => a.readAt - b.readAt)) {
      if (this.diskBytes + incoming <= this.diskBudget) break;
      this.unindexRow(row.key);
      evicted.push(row.key);
    }
    return evicted;
  }

  private commit(change: Parameters<DesignPreviewStore["commit"]>[0]): void {
    const store = this.deps.store;
    if (!store) return;
    this.commits = this.commits.then(() => store.commit(change)).catch(() => {
      // A failed write leaves pictures memory-only; the next session re-reads
      // whatever the store retained and the index stays self-consistent.
    });
  }

  /** Paint what the disk already has, in one read per batch, before any
   * render: the current generation if stored, else the frame's last picture. */
  private hydrate(demand: DesignPreviewDemand): void {
    if (!this.deps.store) return;
    void this.loadIndex().then(() => {
      if (this.demand !== demand) return;
      const keys: string[] = [];
      for (const item of demand.items) {
        const target = { owner: demand.owner, theme: demand.theme, ...item };
        if (this.pictures.has(designPreviewKey(target))) continue;
        const frameKey = designPreviewFrameKey(demand.owner, item.file, demand.theme);
        const levels = this.diskNewest.get(frameKey);
        const alternatives = pictureLevels(item.level).filter((level) => level !== item.level);
        const stored = (level: DesignPreviewLevel) => {
          const key = levels?.get(level);
          return key !== undefined && this.index!.get(key)?.sourceVersion === item.sourceVersion ? key : undefined;
        };
        // The wanted level of this generation; else its other level unless that
        // already shows; with nothing shown, the frame's last picture.
        const shown = this.picture(target);
        const key =
          stored(item.level) ??
          (shown?.current ? undefined : alternatives.map(stored).find((key) => key !== undefined)) ??
          (shown ? undefined : pictureLevels(item.level).map((level) => levels?.get(level)).find((key) => key !== undefined));
        if (key && !this.pictures.has(key) && !this.reading.has(key) && !keys.includes(key)) keys.push(key);
      }
      for (let start = 0; start < keys.length; start += READ_BATCH) this.read(keys.slice(start, start + READ_BATCH));
      this.pump();
    });
  }

  private read(keys: string[]): void {
    for (const key of keys) this.reading.add(key);
    void this.deps.store!.read(keys)
      .catch(() => [])
      .then((records) => {
        const found = new Set<string>();
        for (const record of records) {
          const row = this.index?.get(record.key);
          if (!row || record.blob.size !== row.bytes) continue;
          found.add(record.key);
          this.insert("disk", row.frameKey, row.workspaceId, record.key, row.level, row.sourceVersion,
            row.width, row.height, record.blob);
          this.touch(row);
        }
        // An index row whose picture is gone is dropped, so it is re-rendered.
        const missing = keys.filter((key) => !found.has(key) && this.index?.has(key));
        for (const key of missing) this.unindexRow(key);
        if (missing.length) this.commit({ remove: missing });
      })
      .finally(() => {
        for (const key of keys) this.reading.delete(key);
        this.pump();
      });
  }

  private touch(row: DesignPreviewIndexEntry): void {
    row.readAt = this.deps.now();
    this.touched.add(row.key);
    if (this.touchTimer !== null) return;
    this.touchTimer = this.deps.setTimer(() => {
      this.touchTimer = null;
      const touch = [...this.touched].flatMap((key) => this.index?.get(key) ?? []);
      this.touched.clear();
      if (touch.length) this.commit({ touch });
    }, TOUCH_FLUSH_MS);
  }

  // ── Memory ─────────────────────────────────────────────

  private insert(
    origin: "disk" | "render",
    frameKey: string,
    workspaceId: string,
    key: string,
    level: DesignPreviewLevel,
    sourceVersion: string,
    width: number,
    height: number,
    blob: Blob,
  ): void {
    if (this.pictures.has(key)) return;
    const replaced = this.newest.get(frameKey)?.get(level);
    const previous = replaced ? this.pictures.get(replaced) : undefined;
    // A render is always the frame's newest picture. A disk read only fills
    // a gap, or replaces an older picture with the generation the canvas
    // wants; it never displaces a render that finished while it was read.
    if (origin === "disk" && previous &&
      (previous.sourceVersion === this.wanted.get(frameKey) || sourceVersion !== this.wanted.get(frameKey)))
      return;
    const url = this.deps.createUrl(blob);
    // Shown pictures may fill the pool; then this one stays on disk only.
    if (!this.memory.put(key, { blob, url, width, height })) {
      this.deps.revokeUrl(url);
      return;
    }
    const scope = (JSON.parse(frameKey) as string[])[0]!;
    const view = (current: boolean): DesignPreviewPicture =>
      Object.freeze({ key, url, width, height, sourceVersion, level, current });
    this.pictures.set(key, {
      key, frameKey, workspaceId, scope, level, sourceVersion,
      views: { current: view(true), stale: view(false) },
    });
    // Admission may have evicted other pictures of this frame; read again.
    let levels = this.newest.get(frameKey);
    if (!levels) this.newest.set(frameKey, (levels = new Map()));
    levels.set(level, key);
    if (previous && this.pictures.get(previous.key) === previous) this.drop(previous);
    this.changed(frameKey);
  }

  /** Remove a picture; the pool releases its URL once it stops showing. */
  private drop(picture: Picture): void {
    if (this.pictures.get(picture.key) !== picture) return;
    this.forget(picture);
    this.memory.invalidate(picture.key);
  }

  /** Forget a picture the pool no longer holds for display. */
  private forget(picture: Picture): void {
    this.pictures.delete(picture.key);
    const levels = this.newest.get(picture.frameKey);
    if (levels?.get(picture.level) === picture.key) levels.delete(picture.level);
    if (levels && !levels.size) this.newest.delete(picture.frameKey);
    this.changed(picture.frameKey);
  }

  private changed(frameKey: string): void {
    this.versions.set(frameKey, this.version(frameKey) + 1);
    if (this.versions.size > 8192) this.versions.delete(this.versions.keys().next().value!);
    for (const listener of [...(this.listeners.get(frameKey) ?? [])]) listener();
    if (this.changeTimer !== null) return;
    this.changeTimer = this.deps.setTimer(() => {
      this.changeTimer = null;
      this.changeVersion++;
      for (const listener of [...this.changeListeners]) listener();
    }, CHANGE_BATCH_MS);
  }

  // ── Production ─────────────────────────────────────────

  private next(now: number): { item: DesignPreviewDemandItem; key: string } | { waitUntil: number } | null {
    const demand = this.demand;
    if (!demand) return null;
    let waitUntil = Infinity;
    const far = this.deps.rendersFar?.(demand.owner) ?? true;
    for (const item of demand.items) {
      if (item.near === false && !far) continue;
      const key = designPreviewKey({ owner: demand.owner, theme: demand.theme, ...item });
      if (this.pictures.has(key) || this.reading.has(key) || this.stale.has(key) || this.made.has(key)) continue;
      // Stored but not yet read: the read in flight or the next hydrate paints it.
      if (this.index?.has(key)) continue;
      const attempt = this.attempts.get(key);
      if (attempt && (attempt.failures >= MAX_FAILURES || attempt.capacity > MAX_CAPACITY_RETRIES)) continue;
      if (attempt && attempt.retryAt > now) {
        waitUntil = Math.min(waitUntil, attempt.retryAt);
        continue;
      }
      if (item.live) {
        const settledAt = (this.firstSeen.get(key) ?? now) + DESIGN_PREVIEW_LIVE_SETTLE_MS;
        if (settledAt > now) {
          waitUntil = Math.min(waitUntil, settledAt);
          continue;
        }
      }
      return { item, key };
    }
    return waitUntil === Infinity ? null : { waitUntil };
  }

  private pump(): void {
    if (this.producing || !this.demand) return;
    if (this.pumpTimer !== null) {
      this.deps.clearTimer(this.pumpTimer);
      this.pumpTimer = null;
    }
    const demand = this.demand;
    if (!this.deps.visible() || !this.deps.canProduce(demand.owner)) return;
    const now = this.deps.now();
    const hostRetryAt = this.hostRetryAt.get(demand.owner.workspaceId) ?? 0;
    if (hostRetryAt > now) {
      this.pumpTimer = this.deps.setTimer(() => { this.pumpTimer = null; this.pump(); }, hostRetryAt - now);
      return;
    }
    // Pictures already on disk are painted before anything is rendered.
    if (this.reading.size || (this.deps.store && !this.index)) return;
    const next = this.next(now);
    if (!next) return;
    if ("waitUntil" in next) {
      this.pumpTimer = this.deps.setTimer(() => { this.pumpTimer = null; this.pump(); }, next.waitUntil - now);
      return;
    }
    const readyAt = (this.renderedAt.get(demand.owner.workspaceId) ?? -Infinity) +
      (this.deps.renderGapMs?.(demand.owner) ?? 0);
    if (readyAt > now) {
      this.pumpTimer = this.deps.setTimer(() => { this.pumpTimer = null; this.pump(); }, readyAt - now);
      return;
    }
    this.producing = true;
    const { item, key } = next;
    const epoch = this.productionEpoch;
    const production = { controller: new AbortController(), demand, item, epoch };
    this.production = production;
    void this.deps.schedule(() => this.produce(demand, item, key, epoch, production.controller.signal), {
      key, signal: production.controller.signal,
      priority: item.near === false ? "nearby" : item.level === "detail" ? "detail" : "visible",
    })
      .catch(() => {})
      .finally(() => {
        this.producing = false;
        if (this.production === production) this.production = null;
        this.pump();
      });
  }

  private canAccept(demand: DesignPreviewDemand, item: DesignPreviewDemandItem, epoch: number, exactLevel = false): boolean {
    const current = this.demand;
    return epoch === this.productionEpoch && current !== null &&
      sameOwner(current.owner, demand.owner) && current.theme === demand.theme &&
      this.deps.visible() && this.deps.canProduce(demand.owner) &&
      current.items.some((candidate) => candidate.file === item.file &&
        candidate.sourceVersion === item.sourceVersion && (!exactLevel || candidate.level === item.level) &&
        (candidate.near !== false || (this.deps.rendersFar?.(demand.owner) ?? true)));
  }

  private async produce(demand: DesignPreviewDemand, item: DesignPreviewDemandItem, key: string, epoch: number, signal: AbortSignal): Promise<void> {
    // The lane may run this after input settled for a while; re-check that
    // the picture is still wanted and allowed.
    if (signal.aborted || !this.canAccept(demand, item, epoch, true) || this.pictures.has(key)) return;
    let reply: DesignPreviewReply;
    try {
      reply = await this.deps.render(demand.owner, {
        file: item.file, sourceVersion: item.sourceVersion, theme: demand.theme,
        maxDimension: DESIGN_PREVIEW_LEVELS[item.level],
      }, signal);
    } catch (error) {
      if (this.canAccept(demand, item, epoch)) this.failed(demand.owner, key, errorText(error));
      return;
    } finally {
      this.renderedAt.set(demand.owner.workspaceId, this.deps.now());
      if (this.renderedAt.size > 256) this.renderedAt.delete(this.renderedAt.keys().next().value!);
    }
    // A current generation can still use this resolution after zoom changes.
    // Another generation, owner or hidden canvas cannot adopt its result.
    if (!this.canAccept(demand, item, epoch)) return;
    if ("stale" in reply) {
      // The snapshot is behind the saved source; its refresh asks again.
      this.stale.add(key);
      if (this.stale.size > 4096) this.stale.delete(this.stale.values().next().value!);
      return;
    }
    if (reply.sourceVersion !== item.sourceVersion || reply.theme !== demand.theme) return;
    const png = new Blob([decodeBase64(reply.data)], { type: "image/png" });
    const encoded = await this.deps.encode(png, item.level).catch(() => png);
    if (!this.canAccept(demand, item, epoch)) return;
    const blob = encoded.size > 0 && encoded.size <= png.size ? encoded : png;
    if (blob.size > MAX_PICTURE_BYTES) {
      this.failed(demand.owner, key, "Design preview exceeded its encoded image limit.");
      return;
    }
    this.attempts.delete(key);
    this.made.add(key);
    if (this.made.size > 8192) this.made.delete(this.made.values().next().value!);
    const frameKey = designPreviewFrameKey(demand.owner, item.file, demand.theme);
    this.insert("render", frameKey, demand.owner.workspaceId, key, item.level, item.sourceVersion,
      reply.width, reply.height, blob);
    this.persist({
      key, frameKey, workspaceId: demand.owner.workspaceId, level: item.level,
      sourceVersion: item.sourceVersion, width: reply.width, height: reply.height,
      bytes: blob.size, savedAt: this.deps.now(), readAt: this.deps.now(),
    }, blob, () => this.canAccept(demand, item, epoch));
  }

  private failed(owner: DesignPreviewOwner, key: string, message: string): void {
    const now = this.deps.now();
    if (/no qualified design capture host/i.test(message)) {
      this.hostRetryAt.set(owner.workspaceId, now + HOST_UNAVAILABLE_BACKOFF_MS);
      return;
    }
    if (/active design directory changed/i.test(message)) {
      this.stale.add(key);
      return;
    }
    const attempt = this.attempts.get(key) ?? { failures: 0, capacity: 0, retryAt: 0 };
    if (/capacity/i.test(message)) {
      attempt.capacity++;
      attempt.retryAt = now + Math.min(MAX_CAPACITY_BACKOFF_MS, CAPACITY_BACKOFF_MS * 2 ** (attempt.capacity - 1));
    } else {
      attempt.failures++;
      attempt.retryAt = now + FAILURE_BACKOFF_MS;
    }
    this.attempts.set(key, attempt);
    if (this.attempts.size > 4096) this.attempts.delete(this.attempts.keys().next().value!);
  }

  private persist(row: DesignPreviewIndexEntry, blob: Blob, canAccept: () => boolean): void {
    if (!this.deps.store) return;
    void this.loadIndex().then(() => {
      if (!canAccept()) return;
      const levels = this.diskNewest.get(row.frameKey);
      const replaced = levels?.get(row.level);
      const remove = replaced && replaced !== row.key ? [replaced] : [];
      for (const key of remove) this.unindexRow(key);
      remove.push(...this.evictDisk(row.bytes));
      this.indexRow(row);
      this.commit({ put: [{ record: { key: row.key, blob }, entry: row }], remove });
    });
  }
}

/** PNG → WebP where the platform encodes off the main thread; the smaller of
 * the two is kept, so flat interface pictures may stay PNG. */
export async function encodeDesignPreview(png: Blob, level: DesignPreviewLevel): Promise<Blob> {
  if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function") return png;
  const bitmap = await createImageBitmap(png);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) return png;
    context.drawImage(bitmap, 0, 0);
    const webp = await canvas.convertToBlob({ type: "image/webp", quality: level === "detail" ? 0.95 : 0.9 });
    return webp.type === "image/webp" && webp.size < png.size ? webp : png;
  } finally {
    bitmap.close();
  }
}

const NO_PICTURED: ReadonlySet<string> = new Set();

/** Reads which frames have a picture of their current generation as one set
 * per membership: the same set while its members are unchanged, so a batch
 * of pictures that changes none (a detail after its overview, or another
 * workspace's) re-renders nothing. Recomputes only when pictures or the
 * inputs change. */
export function createDesignFramePicturedReader(
  previews: Pick<DesignFramePreviews, "changes" | "pictured">,
): (
  owner: DesignPreviewOwner | null,
  theme: string | null,
  frames: readonly { file: string; sourceVersion: string }[],
  renderScale?: number,
) => ReadonlySet<string> {
  let last: {
    changes: number;
    owner: DesignPreviewOwner | null;
    theme: string | null;
    frames: readonly { file: string; sourceVersion: string }[];
    renderScale: number;
    value: ReadonlySet<string>;
  } | null = null;
  return (owner, theme, frames, renderScale = 0) => {
    const changes = previews.changes();
    if (last && last.changes === changes && last.owner === owner && last.theme === theme && last.frames === frames && last.renderScale === renderScale)
      return last.value;
    const next = owner ? previews.pictured(owner, theme, frames, renderScale) : NO_PICTURED;
    const previous = last?.value;
    const value = previous && previous.size === next.size && [...next].every((file) => previous.has(file))
      ? previous
      : next;
    last = { changes, owner, theme, frames, renderScale, value };
    return value;
  };
}

/** Whether a live frame also captures itself in its own document (a clone,
 * serialization and raster on the renderer thread). The host renders every
 * generation's picture, and a picture of an older generation holds the
 * frame's last pixels until then, so only the selected frame and frames with
 * no picture yet need the in-frame copy. */
export function designFrameAutoCapture(
  selected: boolean,
  picture: DesignPreviewPicture | null,
): boolean {
  return selected || picture === null;
}

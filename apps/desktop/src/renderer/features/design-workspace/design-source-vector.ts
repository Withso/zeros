import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import { designSourceTiles } from "./design-source-tiles";

export interface DesignSourceLoadTicket { release(): void }

/** Only temporary layout documents use these slots. A decoded SVG keeps its
 * source and layout without retaining a browsing context or full-size surface. */
export class DesignSourceLoadSlots {
  private active = 0;
  private waiting: Array<{ cancelled: boolean; admitted: boolean; start(): void }> = [];
  constructor(private readonly limit = 8) {}

  request(start: () => void): DesignSourceLoadTicket {
    const entry = { cancelled: false, admitted: false, start };
    this.waiting.push(entry);
    this.pump();
    return { release: () => {
      if (entry.cancelled) return;
      entry.cancelled = true;
      this.waiting = this.waiting.filter(candidate => candidate !== entry);
      // A React layout cleanup precedes host-node removal. Defer admission
      // through the end of that commit instead of overlapping two allocations.
      queueMicrotask(() => {
        if (entry.admitted) this.active--;
        this.pump();
      });
    } };
  }

  usage() { return { active: this.active, waiting: this.waiting.length }; }
  private pump() {
    while (this.active < this.limit && this.waiting.length) {
      const entry = this.waiting.shift()!;
      if (entry.cancelled) continue;
      entry.admitted = true; this.active++; entry.start();
    }
  }
}

export interface DesignSourceVector { url: string; bytes: number; release(): void }

function vectorBlob(svg: unknown): Blob | null {
  if (typeof svg !== "string" || svg.length > 1024 * 1024 || !svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')) return null;
  const blob = new Blob([svg], { type: "image/svg+xml" });
  return blob.size <= 1024 * 1024 ? blob : null;
}

function vectorDataUrl(_blob: Blob, svg: string): string {
  // Chromium treats foreignObject in a Blob URL as an origin-tainted canvas
  // input. A self-contained data URL keeps the same inert SVG image semantics
  // and can also feed bounded GPU tiles. Encode UTF-8, including non-BMP text.
  const bytes = new TextEncoder().encode(svg);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

/** Encoded SVG retention is separate from bitmap leases. It does not reserve a
 * full artboard bitmap; native qualification must still measure physical GPU
 * allocation during paint. URL lifetime follows the actual image element. */
export class DesignSourceVectorBudget {
  private entries = 0;
  private bytes = 0;
  constructor(readonly limit = 16 * 1024 * 1024, private readonly urls: {
    create(blob: Blob, svg: string): string; revoke(url: string): void;
  } = {
    create: vectorDataUrl, revoke: () => {},
  }) {}

  acquire(svg: unknown): DesignSourceVector | null {
    if (typeof svg !== "string") return null;
    const blob = vectorBlob(svg);
    if (!blob || this.bytes + blob.size > this.limit) return null;
    const url = this.urls.create(blob, svg);
    this.entries++; this.bytes += blob.size;
    let released = false;
    return { url, bytes: blob.size, release: () => {
      if (released) return;
      released = true; this.entries--; this.bytes -= blob.size; this.urls.revoke(url);
    } };
  }

  usage() { return { entries: this.entries, bytes: this.bytes }; }
}

export interface DesignSourceVectorOwner {
  readonly workspaceId: string;
  readonly folder: string;
  readonly directoryId: string;
  readonly capability: string;
}
export interface DesignSourceVectorTarget extends DesignSourceVectorOwner {
  readonly file: string;
  readonly sourceVersion: string;
  readonly theme: string | null;
  readonly width: number;
  readonly height: number;
  /** Authenticated source-cost estimate, not part of render identity. */
  readonly imageBytes?: number;
}
export interface DesignCachedSourceVector extends DesignSourceVector {
  readonly key: string;
  readonly image: HTMLImageElement | null;
  /** Only successfully loaded images may survive their last display lease. */
  confirm(image?: HTMLImageElement): void;
  invalidate(): void;
}

const displayedImages = new WeakSet<HTMLImageElement>();

/** A tiled source is deliberately disconnected but still belongs to its
 * display. DOM connectivity alone cannot authorize another consumer to move
 * that same loaded element. Release this claim after retiring its GPU scene. */
export function acquireDesignSourceVectorImage(vector: DesignCachedSourceVector,
  create: () => HTMLImageElement = () => new Image()): { image: HTMLImageElement; release(): void } {
  const cached = vector.image;
  const image = cached && !cached.isConnected && !displayedImages.has(cached) ? cached : create();
  displayedImages.add(image);
  let released = false;
  return { image, release: () => { if (!released) { released = true; displayedImages.delete(image); } } };
}
export interface DesignSourceVectorRequest {
  readonly cached: DesignCachedSourceVector | null;
  publish(svg: unknown): DesignCachedSourceVector | null;
  close(): void;
}
interface VectorEntry {
  key: string; family: string; target: DesignSourceVectorTarget; vector: DesignSourceVector;
  leases: number; confirmed: boolean; retired: boolean; touched: number; sequence: number;
  image: HTMLImageElement | null;
}
const ownerKey = (owner: DesignSourceVectorOwner) => JSON.stringify([owner.workspaceId, owner.folder, owner.directoryId, owner.capability]);
export const designSourceVectorKey = (target: DesignSourceVectorTarget) => JSON.stringify([
  ownerKey(target), target.file, target.sourceVersion, target.theme, target.width, target.height,
]);
export const DESIGN_SOURCE_VECTOR_IDLE_MS = 24 * 60 * 60_000;

/** Navigation releases display leases, not completed source. A small warm
 * image pool also reuses already loaded elements before the return paint;
 * a new img with the same Blob URL still needs an asynchronous resource load.
 * Displayed and inactive entries share that pool. A new destination therefore
 * spends the remaining warm capacity instead of adding to a full hidden pool.
 * Display leases stay protected; only inactive loaded elements can be retired.
 * No hidden browsing contexts, bitmap copies or recurring work are retained.
 * Chromium owns rasterization: these estimates are not physical GPU quotas. */
export class DesignSourceVectorCache {
  private readonly index = new Map<string, VectorEntry>();
  private readonly entries = new Set<VectorEntry>();
  private readonly requests = new Set<{ target: DesignSourceVectorTarget; current: boolean }>();
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly maxImages: number;
  private readonly maxImageBytes: number;
  private sequence = 0;
  constructor(private readonly budget: DesignSourceVectorBudget, options: { now?: () => number; maxEntries?: number; maxImages?: number; maxImageBytes?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? 2048;
    this.maxImages = options.maxImages ?? 512;
    this.maxImageBytes = options.maxImageBytes ?? 32 * 1024 * 1024;
  }

  open(target: DesignSourceVectorTarget): DesignSourceVectorRequest {
    this.sweep();
    const valid = !isCloudWorkspace(target.workspaceId) && !!target.workspaceId && !!target.folder && !!target.directoryId &&
      !!target.capability && [target.width, target.height].every(value => Number.isFinite(value) && value > 0);
    const request = { target: { ...target }, current: valid };
    if (valid) this.requests.add(request);
    const key = designSourceVectorKey(target);
    const existing = valid ? this.index.get(key) : undefined;
    return {
      cached: existing?.confirmed ? this.lease(existing) : null,
      publish: svg => {
        if (!request.current) return null;
        const current = this.index.get(key);
        if (current) return this.lease(current);
        const blob = vectorBlob(svg);
        if (!blob || blob.size > this.budget.limit) return null;
        this.sweep();
        for (const entry of this.entries) {
          if (this.budget.usage().bytes + blob.size <= this.budget.limit && this.entries.size < this.maxEntries) break;
          if (!entry.leases) this.retire(entry);
        }
        if (this.entries.size >= this.maxEntries) return null;
        const vector = this.budget.acquire(svg);
        if (!vector) return null;
        const entry: VectorEntry = { key, family: JSON.stringify([ownerKey(target), target.file, target.theme]),
          target: request.target, vector, leases: 0, confirmed: false, retired: false, touched: this.now(), sequence: ++this.sequence, image: null };
        this.entries.add(entry); this.index.set(key, entry);
        return this.lease(entry);
      },
      close: () => { request.current = false; this.requests.delete(request); },
    };
  }

  /** Authoritative catalog membership only; a page projection must not evict
   * siblings. Pending reads for a removed/replaced owner cannot repopulate it. */
  reconcile(owner: DesignSourceVectorOwner, files: ReadonlySet<string>): void {
    this.forget(target => target.workspaceId === owner.workspaceId && (
      target.folder !== owner.folder || target.capability !== owner.capability ||
      // One directory's catalog has no authority over its siblings. Their
      // completed frames remain reusable when the user returns to them.
      (target.directoryId === owner.directoryId && !files.has(target.file))));
  }
  forgetWorkspaces(workspaces: readonly string[]): void {
    const removed = new Set(workspaces);
    this.forget(target => removed.has(target.workspaceId));
  }
  clear(): void { this.forget(() => true); }
  clearWarmImages(): void {
    for (const entry of this.entries) if (!entry.leases) this.dropImage(entry);
  }
  /** Read-only provenance for native qualification. Never acquire a lease or
   * renew idle retention while observing an already displayed source. */
  hasDisplayedImage(target: DesignSourceVectorOwner & Pick<DesignSourceVectorTarget, "file" | "sourceVersion">, image: HTMLImageElement): boolean {
    const owner = ownerKey(target);
    for (const entry of this.index.values())
      if (!entry.retired && entry.confirmed && entry.leases > 0 && entry.image === image &&
          ownerKey(entry.target) === owner && entry.target.file === target.file && entry.target.sourceVersion === target.sourceVersion) return true;
    return false;
  }
  usage() {
    const warm = [...this.entries].filter(entry => !entry.leases && entry.confirmed);
    return { entries: this.entries.size, leases: [...this.entries].reduce((sum, entry) => sum + entry.leases, 0),
      requests: this.requests.size, warm: warm.length, warmImages: warm.filter(entry => !!entry.image).length,
      warmImageEstimatedBytes: warm.reduce((sum, entry) => sum + this.imageWeight(entry), 0),
      images: [...this.entries].filter(entry => !!entry.image).length,
      imageEstimatedBytes: [...this.entries].reduce((sum, entry) => sum + this.imageWeight(entry), 0) };
  }
  private lease(entry: VectorEntry): DesignCachedSourceVector {
    entry.leases++; this.touch(entry);
    let released = false;
    return { key: entry.key, url: entry.vector.url, bytes: entry.vector.bytes, get image() { return entry.image; },
      confirm: image => {
        if (released || entry.retired) return;
        entry.confirmed = true;
        if (image && (!entry.image || entry.image === image || !entry.image.isConnected && !displayedImages.has(entry.image))) entry.image = image;
        // Keep the outgoing display pinned until its DOM detaches, but never
        // accumulate all historical generations of a continuously edited frame.
        for (const previous of this.entries) if (previous.sequence < entry.sequence && previous.family === entry.family) this.retire(previous);
        this.trimImages();
      },
      invalidate: () => this.retire(entry),
      release: () => {
        if (released) return;
        released = true; entry.leases--; this.touch(entry);
        if (!entry.leases && (!entry.confirmed || entry.retired)) this.retire(entry);
        this.trimImages();
      },
    };
  }
  private touch(entry: VectorEntry) {
    entry.touched = this.now(); this.entries.delete(entry); this.entries.add(entry);
  }
  private retire(entry: VectorEntry) {
    entry.retired = true;
    if (this.index.get(entry.key) === entry) this.index.delete(entry.key);
    if (entry.leases) return;
    this.entries.delete(entry); this.dropImage(entry); designSourceTiles.forget(entry.key); entry.vector.release();
  }
  private imageWeight(entry: VectorEntry) {
    return entry.image ? entry.vector.bytes * 8 + (entry.target.imageBytes ?? 0) : 0;
  }
  private dropImage(entry: VectorEntry) {
    const image = entry.image; entry.image = null;
    // Parent layout cleanup can precede host-node removal in the same commit.
    if (image) queueMicrotask(() => { if (!image.isConnected && !displayedImages.has(image)) image.removeAttribute("src"); });
  }
  private trimImages() {
    const loaded = [...this.entries].filter(entry => entry.image);
    let count = loaded.length, bytes = loaded.reduce((sum, entry) => sum + this.imageWeight(entry), 0);
    for (const entry of loaded) {
      if (count <= this.maxImages && bytes <= this.maxImageBytes) break;
      if (entry.leases) continue;
      count--; bytes -= this.imageWeight(entry); this.dropImage(entry);
    }
  }
  private sweep() {
    const deadline = this.now() - DESIGN_SOURCE_VECTOR_IDLE_MS;
    for (const entry of this.entries) if (!entry.leases && entry.touched <= deadline) this.retire(entry);
  }
  private forget(matches: (target: DesignSourceVectorTarget) => boolean) {
    for (const request of this.requests) if (matches(request.target)) { request.current = false; this.requests.delete(request); }
    for (const entry of this.entries) if (matches(entry.target)) this.retire(entry);
  }
}

export const designSourceLoadSlots = new DesignSourceLoadSlots();
export const designSourceVectorBudget = new DesignSourceVectorBudget();
export const designSourceVectorCache = new DesignSourceVectorCache(designSourceVectorBudget);

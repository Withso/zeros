import type { DesignPreviewPicture, DesignPreviewPictureLease, DesignPreviewTarget } from "./design-frame-previews";
import { designImageDecodedBytes } from "./design-image-residency";

/** Warm overview pixels survive navigation within the same bounded pool. This
 * is part of the shared 64 MiB display budget, never an extra allocation. */
const MAX_WARM_BYTES = 32 * 1024 * 1024;
const IDLE_MS = 24 * 60 * 60_000;
interface DecodedImage { element?: HTMLImageElement; dispose(): void }
interface Entry {
  picture: DesignPreviewPicture;
  owner: string;
  workspaceId: string;
  touched: number;
  bytes: number;
  users: number;
  warm: boolean;
  retain: boolean;
  releaseBacking(): void;
  controller: AbortController;
  image: DecodedImage | null;
  pending: Promise<void>;
}
export interface DesignDecodedPreviewLease extends DesignPreviewPictureLease {
  readonly ready: boolean;
  readonly whenReady: Promise<void>;
  /** Reuse the loaded element; assigning its URL to another image can miss a paint. */
  readonly image: HTMLImageElement | null;
}

function ownerKey(target: Pick<DesignPreviewTarget, "owner" | "theme">): string {
  return JSON.stringify([target.owner.scope, target.owner.workspaceId, target.owner.directoryId, target.theme]);
}

/** Keep the decoder's actual image alive with a charged backing lease. An
 * encoded cache hit alone cannot promise pixels on the next animation frame.
 * Display consumers have their own leases, so warm pixels never authorize
 * retiring an iframe before its replacement is committed. */
export class DesignPreviewDecodes {
  private readonly entries = new Map<string, Entry>();
  private token: object | null = null;
  private owner: string | null = null;
  private warmBytes = 0;

  constructor(private readonly deps: {
    acquire(target: DesignPreviewTarget, accept?: (picture: DesignPreviewPicture) => boolean): DesignPreviewPictureLease | null;
    hasPicture(target: DesignPreviewTarget): boolean;
    retain(key: string): () => void;
    decode(picture: DesignPreviewPicture, signal: AbortSignal): Promise<DecodedImage>;
  }, private readonly maxWarmBytes = MAX_WARM_BYTES, private readonly now: () => number = Date.now) {}

  setOwner(token: object, target: Pick<DesignPreviewTarget, "owner" | "theme"> | null): void {
    if (!target && this.token !== token) return;
    this.token = target ? token : null;
    const owner = target ? ownerKey(target) : null;
    if (owner === this.owner) return;
    this.owner = owner;
    for (const entry of this.entries.values()) {
      // Completed pixels are independent of active document ownership. A
      // pending decode still belongs to its original display and cannot warm
      // an owner which left before it finished.
      if (entry.owner === owner || entry.image) continue;
      entry.retain = false;
      if (!entry.users) this.remove(entry);
    }
  }

  acquire(target: DesignPreviewTarget): DesignDecodedPreviewLease | null {
    return this.acquireImage(target, false);
  }

  /** A remount can paint a retained cover while its preferred level decodes.
   * A miss must neither start a decoder nor reclaim another warm image. */
  acquireReady(target: DesignPreviewTarget): DesignDecodedPreviewLease | null {
    return this.acquireImage(target, true);
  }

  private acquireImage(target: DesignPreviewTarget, readyOnly: boolean): DesignDecodedPreviewLease | null {
    for (const entry of this.entries.values())
      if (!entry.users && this.now() - entry.touched >= IDLE_MS) this.remove(entry);
    let display = this.deps.acquire(target, readyOnly ? picture => !!this.entries.get(picture.key)?.image : undefined);
    if (!display && !readyOnly && this.deps.hasPicture(target)) {
      // The picture pool can have a tighter local cap than the shared budget.
      // A cold cache miss is not capacity pressure: evicting peers cannot
      // produce that missing picture and destroys their return-pan coverage.
      this.clearWarm();
      display = this.deps.acquire(target);
    }
    if (!display) return null;
    const lease = display;
    let entry = this.entries.get(lease.picture.key);
    if (!entry) {
      const controller = new AbortController();
      entry = {
        picture: lease.picture, owner: ownerKey(target), workspaceId: target.owner.workspaceId, touched: this.now(),
        bytes: designImageDecodedBytes(lease.picture.width, lease.picture.height)!,
        users: 0, warm: false, retain: true, releaseBacking: this.deps.retain(lease.picture.key),
        controller, image: null, pending: Promise.resolve(),
      };
      const decoding = entry;
      this.entries.set(lease.picture.key, entry);
      entry.pending = Promise.resolve().then(() => this.deps.decode(lease.picture, controller.signal)).then((image) => {
        if (controller.signal.aborted) { image.dispose(); return; }
        decoding.image = image;
      }).catch((error: unknown) => {
        this.remove(decoding);
        throw error;
      });
    } else if (entry.warm) {
      this.warmBytes -= entry.bytes;
      entry.warm = false;
    }
    const owned = entry;
    owned.users++;
    let released = false;
    return {
      picture: lease.picture,
      get ready() { return !!owned.image; },
      get image() { return owned.image?.element ?? null; },
      whenReady: owned.pending,
      confirmDecoded: () => { if (!released && owned.image) lease.confirmDecoded(); },
      release: () => {
        if (released) return;
        released = true;
        lease.release();
        if (--owned.users || this.entries.get(owned.picture.key) !== owned) return;
        if (!owned.image || !owned.retain) {
          this.remove(owned);
          return;
        }
        this.warmBytes += owned.bytes;
        owned.warm = true;
        owned.touched = this.now();
        // Keep small covers across the whole view before optional warm detail.
        // Within either priority, evict the least recently displayed first.
        this.entries.delete(owned.picture.key);
        this.entries.set(owned.picture.key, owned);
        if (this.warmBytes > this.maxWarmBytes) {
          const victims = [...this.entries.values()].filter(candidate => !candidate.users).sort((a, b) =>
            Number(a.picture.level === "thumbnail") - Number(b.picture.level === "thumbnail"));
          for (const candidate of victims) {
            if (this.warmBytes <= this.maxWarmBytes) break;
            this.remove(candidate);
          }
        }
      },
    };
  }

  /** Called before refusing a foreground tile/capture for pixel pressure. */
  clearWarm(): void {
    for (const entry of this.entries.values()) if (!entry.users) this.remove(entry);
  }

  forgetWorkspaces(workspaces: readonly string[]): void {
    const removed = new Set(workspaces);
    for (const entry of this.entries.values()) if (removed.has(entry.workspaceId)) this.remove(entry);
  }
  usage() {
    return { entries: this.entries.size, warmBytes: this.warmBytes,
      users: [...this.entries.values()].reduce((sum, entry) => sum + entry.users, 0),
      pending: [...this.entries.values()].filter(entry => !entry.image).length };
  }

  private remove(entry: Entry): void {
    if (this.entries.get(entry.picture.key) !== entry) return;
    this.entries.delete(entry.picture.key);
    if (entry.warm) this.warmBytes -= entry.bytes;
    entry.warm = false;
    entry.controller.abort();
    entry.image?.dispose();
    entry.image = null;
    entry.releaseBacking();
  }
}

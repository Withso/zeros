/** Display estimates cover one decoded raster and a compositor copy. These
 * are admission limits for images we own, not browser/GPU process quotas. */
export const DESIGN_IMAGE_DECODED_BYTES = 64 * 1024 * 1024;
export const DESIGN_IMAGE_TRANSIENT_ENCODED_BYTES = 24 * 1024 * 1024;

export function designImageDecodedBytes(width: number, height: number): number | null {
  const bytes = width * height * 8;
  return Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0 &&
    Number.isSafeInteger(bytes) ? bytes : null;
}

export interface DesignImageLease { release(): void }
interface ImageResource { decoded: number; encoded: number; leases: number }

/** One resource can have several display consumers. Replacements use distinct
 * resource identities and remain charged together until the old display ends.
 * One explicitly owned replacement may overlap the steady budget. Both its
 * successful commit and cancellation must return below that same budget. */
export class DesignImageResidency {
  private readonly resources = new Map<object | string, ImageResource>();
  private readonly leaseResources = new WeakMap<DesignImageLease, ImageResource>();
  private replacement: { previous: ImageResource; incoming: ImageResource } | null = null;
  private decodedBytes = 0;
  private encodedBytes = 0;
  private leases = 0;
  private readonly listeners = new Set<() => void>();
  private readonly pressureListeners = new Set<() => void>();
  private notificationPending = false;

  constructor(
    private readonly maxDecodedBytes = DESIGN_IMAGE_DECODED_BYTES,
    private readonly maxEncodedBytes = DESIGN_IMAGE_TRANSIENT_ENCODED_BYTES,
  ) {
    if (![maxDecodedBytes, maxEncodedBytes].every((value) => Number.isSafeInteger(value) && value >= 0))
      throw new RangeError("Design image limits are invalid.");
  }

  usage() {
    const overlap = this.replacement;
    return { images: this.resources.size, leases: this.leases, decodedBytes: this.decodedBytes,
      encodedBytes: this.encodedBytes, maxDecodedBytes: this.maxDecodedBytes, maxEncodedBytes: this.maxEncodedBytes,
      transitions: overlap ? 1 : 0,
      transitionDecodedBytes: overlap ? Math.min(overlap.previous.decoded, overlap.incoming.decoded) : 0,
      transitionEncodedBytes: overlap ? Math.min(overlap.previous.encoded, overlap.incoming.encoded) : 0 };
  }

  acquire(key: object | string, width: number, height: number, encodedBytes = 0, replacing?: DesignImageLease): DesignImageLease | null {
    const decoded = designImageDecodedBytes(width, height);
    if (decoded === null || !Number.isSafeInteger(encodedBytes) || encodedBytes < 0) return null;
    let entry = this.resources.get(key);
    if (entry && (entry.decoded !== decoded || entry.encoded !== encodedBytes)) return null;
    // Commit must retire the previous image; cancellation must retire the
    // incoming image. Another consumer cannot extend either exclusive lease.
    if (entry && (this.replacement?.previous === entry || this.replacement?.incoming === entry)) return null;
    if (!entry) {
      if (this.decodedBytes + decoded > this.maxDecodedBytes || this.encodedBytes + encodedBytes > this.maxEncodedBytes)
        for (const listener of this.pressureListeners) listener();
      let previous: ImageResource | undefined;
      if (this.decodedBytes + decoded > this.maxDecodedBytes || this.encodedBytes + encodedBytes > this.maxEncodedBytes) {
        previous = replacing ? this.leaseResources.get(replacing) : undefined;
        if (this.replacement || !previous || previous.leases !== 1 ||
          this.decodedBytes - previous.decoded + decoded > this.maxDecodedBytes ||
          this.encodedBytes - previous.encoded + encodedBytes > this.maxEncodedBytes)
          return null;
      }
      entry = { decoded, encoded: encodedBytes, leases: 0 };
      this.resources.set(key, entry);
      this.decodedBytes += decoded;
      this.encodedBytes += encodedBytes;
      if (previous) this.replacement = { previous, incoming: entry };
    }
    const owned = entry;
    owned.leases++;
    this.leases++;
    let released = false;
    const lease: DesignImageLease = { release: () => {
      if (released) return;
      released = true;
      this.leaseResources.delete(lease);
      owned.leases--;
      this.leases--;
      if (owned.leases) return;
      this.resources.delete(key);
      this.decodedBytes -= owned.decoded;
      this.encodedBytes -= owned.encoded;
      if (this.replacement?.previous === owned || this.replacement?.incoming === owned)
        this.replacement = null;
      // Wake only blocked consumers, once per release batch, with no polling.
      if (this.notificationPending || !this.listeners.size) return;
      this.notificationPending = true;
      queueMicrotask(() => {
        this.notificationPending = false;
        for (const listener of [...this.listeners]) listener();
      });
    } };
    this.leaseResources.set(lease, owned);
    return lease;
  }

  subscribeAvailable(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Optional warm caches yield synchronously before foreground admission. */
  subscribePressure(listener: () => void): () => void {
    this.pressureListeners.add(listener);
    return () => { this.pressureListeners.delete(listener); };
  }
}

export const designImageResidency = new DesignImageResidency();

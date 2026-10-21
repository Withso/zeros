export interface DesignPreviewImage {
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
  readonly bitmap?: ImageBitmap;
}

/** An encoded picture held as a Blob behind an object URL, never base64 in
 * the JS heap. The browser decodes it when an <img> paints it and keeps those
 * pixels in its own decode cache, so the pool charges its encoded bytes only. */
export interface DesignPreviewBlobImage {
  readonly blob: Blob;
  readonly url: string;
  readonly width: number;
  readonly height: number;
}

type CachedImage = DesignPreviewImage | DesignPreviewBlobImage;

export interface DesignPreviewCacheEvents<T extends CachedImage> {
  /** Admission evicted this key to make room (not a replacement or an
   * invalidation, which the caller asked for). */
  evicted?(key: string): void;
  /** An image's resources are released: once evicted or replaced unshown, or
   * at the final lease of an invalidated one. */
  disposed?(image: Readonly<T>): void;
}

export interface DesignPreviewCacheLimits {
  readonly maxEntries: number;
  readonly maxEncodedBytes: number;
  readonly maxDecodedBytes: number;
}

export interface DesignPreviewLease<T extends CachedImage = DesignPreviewImage> {
  readonly image: Readonly<T>;
  release(): void;
}

interface PreviewEntry<T extends CachedImage> {
  key: string;
  image: Readonly<T>;
  encodedBytes: number;
  decodedBytes: number;
  pins: number;
  retired: boolean;
  disposed: boolean;
}

const DEFAULT_LIMITS: DesignPreviewCacheLimits = {
  maxEntries: 10_000,
  maxEncodedBytes: 32 * 1024 * 1024,
  maxDecodedBytes: 128 * 1024 * 1024,
};
const PNG_PREFIX = "data:image/png;base64,";

/** The decoded bitmap a PNG entry owns; a Blob picture owns none. */
function ownedBitmap(image: Readonly<CachedImage>): ImageBitmap | undefined {
  return "blob" in image ? undefined : image.bitmap;
}

function imageCosts(key: string, image: CachedImage) {
  if ("blob" in image) {
    return key &&
      Number.isSafeInteger(image.width) && image.width > 0 &&
      Number.isSafeInteger(image.height) && image.height > 0 &&
      typeof image.url === "string" && image.url.length > 0 &&
      Number.isSafeInteger(image.blob.size) && image.blob.size > 0
      ? { encodedBytes: image.blob.size, decodedBytes: 0 }
      : null;
  }
  if (
    !key ||
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    image.width <= 0 ||
    image.height <= 0 ||
    !image.dataUrl.startsWith(PNG_PREFIX) ||
    (image.bitmap &&
      (image.bitmap.width !== image.width ||
        image.bitmap.height !== image.height))
  )
    return null;
  let header: string;
  try {
    header = atob(
      image.dataUrl.slice(PNG_PREFIX.length, PNG_PREFIX.length + 44),
    );
  } catch {
    return null;
  }
  if (
    header.length < 29 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every(
      (byte, index) => header.charCodeAt(index) === byte,
    ) ||
    header.slice(12, 16) !== "IHDR"
  )
    return null;
  const readSize = (offset: number) =>
    header.charCodeAt(offset) * 0x1000000 +
    header.charCodeAt(offset + 1) * 0x10000 +
    header.charCodeAt(offset + 2) * 0x100 +
    header.charCodeAt(offset + 3);
  const depth = header.charCodeAt(24);
  if (
    readSize(8) !== 13 ||
    readSize(16) !== image.width ||
    readSize(20) !== image.height ||
    ![1, 2, 4, 8, 16].includes(depth)
  )
    return null;
  const encodedBytes = (key.length + image.dataUrl.length) * 2;
  const decodedBytes = image.width * image.height * (depth === 16 ? 16 : 8);
  if (
    !Number.isSafeInteger(encodedBytes) ||
    !Number.isSafeInteger(decodedBytes)
  )
    return null;
  return { encodedBytes, decodedBytes };
}

export class DesignPreviewCache<T extends CachedImage = DesignPreviewImage> {
  private readonly limits: Readonly<DesignPreviewCacheLimits>;
  private readonly entries = new Map<string, PreviewEntry<T>>();
  private readonly retired = new Set<PreviewEntry<T>>();
  private readonly bitmaps = new Set<ImageBitmap>();
  private encodedBytes = 0;
  private decodedBytes = 0;

  constructor(
    limits: DesignPreviewCacheLimits = DEFAULT_LIMITS,
    private readonly events: DesignPreviewCacheEvents<T> = {},
  ) {
    if (
      Object.entries(DEFAULT_LIMITS).some(([key, maximum]) => {
        const value = limits[key as keyof DesignPreviewCacheLimits];
        return !Number.isSafeInteger(value) || value < 0 || value > maximum;
      })
    )
      throw new RangeError("Design preview cache limits are invalid.");
    this.limits = Object.freeze({
      maxEntries: limits.maxEntries,
      maxEncodedBytes: limits.maxEncodedBytes,
      maxDecodedBytes: limits.maxDecodedBytes,
    });
  }

  getUsage() {
    return {
      entries: this.entries.size + this.retired.size,
      encodedBytes: this.encodedBytes,
      decodedBytes: this.decodedBytes,
    };
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  put(key: string, image: T): boolean {
    const costs = imageCosts(key, image);
    if (
      !costs ||
      costs.encodedBytes > this.limits.maxEncodedBytes ||
      costs.decodedBytes > this.limits.maxDecodedBytes ||
      this.limits.maxEntries === 0
    )
      return false;
    const previous = this.entries.get(key);
    const bitmap = ownedBitmap(image);
    if (bitmap && this.bitmaps.has(bitmap)) {
      const previousImage = previous?.image as Readonly<CachedImage> | undefined;
      const held = previousImage && !("blob" in previousImage) ? previousImage : undefined;
      if (
        !previous ||
        held?.bitmap !== bitmap ||
        held.dataUrl !== (image as DesignPreviewImage).dataUrl
      )
        return false;
      this.entries.delete(key);
      this.entries.set(key, previous);
      return true;
    }
    const victims: PreviewEntry<T>[] = [];
    let count = this.entries.size + this.retired.size + 1;
    let encoded = this.encodedBytes + costs.encodedBytes;
    let decoded = this.decodedBytes + costs.decodedBytes;
    const reclaim = (entry: PreviewEntry<T>) => {
      victims.push(entry);
      count--;
      encoded -= entry.encodedBytes;
      decoded -= entry.decodedBytes;
    };
    if (previous && previous.pins === 0) reclaim(previous);
    const fits = () =>
      count <= this.limits.maxEntries &&
      encoded <= this.limits.maxEncodedBytes &&
      decoded <= this.limits.maxDecodedBytes;
    for (const entry of this.entries.values()) {
      if (fits()) break;
      if (entry === previous || entry.pins > 0) continue;
      reclaim(entry);
    }
    if (!fits()) return false;
    for (const entry of victims) {
      this.entries.delete(entry.key);
      this.dispose(entry);
      if (entry.key !== key) this.events.evicted?.(entry.key);
    }
    if (previous && previous.pins > 0) {
      this.entries.delete(key);
      previous.retired = true;
      this.retired.add(previous);
    }
    const entry: PreviewEntry<T> = {
      key,
      image: Object.freeze(
        "blob" in image
          ? { blob: image.blob, url: image.url, width: image.width, height: image.height }
          : {
              dataUrl: image.dataUrl,
              width: image.width,
              height: image.height,
              ...(image.bitmap ? { bitmap: image.bitmap } : {}),
            },
      ) as Readonly<T>,
      ...costs,
      pins: 0,
      retired: false,
      disposed: false,
    };
    this.entries.set(key, entry);
    if (bitmap) this.bitmaps.add(bitmap);
    this.encodedBytes += costs.encodedBytes;
    this.decodedBytes += costs.decodedBytes;
    return true;
  }

  acquire(key: string): DesignPreviewLease<T> | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    this.entries.set(key, entry);
    entry.pins++;
    let released = false;
    return {
      image: entry.image,
      release: () => {
        if (released) return;
        released = true;
        entry.pins--;
        if (entry.retired && entry.pins === 0) this.dispose(entry);
      },
    };
  }

  invalidate(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    entry.retired = true;
    if (entry.pins > 0) this.retired.add(entry);
    else this.dispose(entry);
  }

  clear(): void {
    for (const key of this.entries.keys()) this.invalidate(key);
  }

  private dispose(entry: PreviewEntry<T>): void {
    if (entry.disposed) return;
    entry.disposed = true;
    this.retired.delete(entry);
    this.encodedBytes -= entry.encodedBytes;
    this.decodedBytes -= entry.decodedBytes;
    const bitmap = ownedBitmap(entry.image);
    if (bitmap) {
      this.bitmaps.delete(bitmap);
      bitmap.close();
    }
    this.events.disposed?.(entry.image);
  }
}

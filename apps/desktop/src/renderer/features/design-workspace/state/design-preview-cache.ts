export interface DesignPreviewImage {
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
  readonly bitmap?: ImageBitmap;
}

export interface DesignPreviewCacheLimits {
  readonly maxEntries: number;
  readonly maxEncodedBytes: number;
  readonly maxDecodedBytes: number;
}

export interface DesignPreviewLease {
  readonly image: Readonly<DesignPreviewImage>;
  release(): void;
}

interface PreviewEntry {
  key: string;
  image: Readonly<DesignPreviewImage>;
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

function imageCosts(key: string, image: DesignPreviewImage) {
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

export class DesignPreviewCache {
  private readonly limits: Readonly<DesignPreviewCacheLimits>;
  private readonly entries = new Map<string, PreviewEntry>();
  private readonly retired = new Set<PreviewEntry>();
  private readonly bitmaps = new Set<ImageBitmap>();
  private encodedBytes = 0;
  private decodedBytes = 0;

  constructor(limits: DesignPreviewCacheLimits = DEFAULT_LIMITS) {
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

  put(key: string, image: DesignPreviewImage): boolean {
    const costs = imageCosts(key, image);
    if (
      !costs ||
      costs.encodedBytes > this.limits.maxEncodedBytes ||
      costs.decodedBytes > this.limits.maxDecodedBytes ||
      this.limits.maxEntries === 0
    )
      return false;
    const previous = this.entries.get(key);
    if (image.bitmap && this.bitmaps.has(image.bitmap)) {
      if (
        previous?.image.bitmap !== image.bitmap ||
        previous.image.dataUrl !== image.dataUrl
      )
        return false;
      this.entries.delete(key);
      this.entries.set(key, previous);
      return true;
    }
    const victims: PreviewEntry[] = [];
    let count = this.entries.size + this.retired.size + 1;
    let encoded = this.encodedBytes + costs.encodedBytes;
    let decoded = this.decodedBytes + costs.decodedBytes;
    const reclaim = (entry: PreviewEntry) => {
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
    }
    if (previous && previous.pins > 0) {
      this.entries.delete(key);
      previous.retired = true;
      this.retired.add(previous);
    }
    const entry: PreviewEntry = {
      key,
      image: Object.freeze({
        dataUrl: image.dataUrl,
        width: image.width,
        height: image.height,
        ...(image.bitmap ? { bitmap: image.bitmap } : {}),
      }),
      ...costs,
      pins: 0,
      retired: false,
      disposed: false,
    };
    this.entries.set(key, entry);
    if (image.bitmap) this.bitmaps.add(image.bitmap);
    this.encodedBytes += costs.encodedBytes;
    this.decodedBytes += costs.decodedBytes;
    return true;
  }

  acquire(key: string): DesignPreviewLease | null {
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

  private dispose(entry: PreviewEntry): void {
    if (entry.disposed) return;
    entry.disposed = true;
    this.retired.delete(entry);
    this.encodedBytes -= entry.encodedBytes;
    this.decodedBytes -= entry.decodedBytes;
    if (entry.image.bitmap) {
      this.bitmaps.delete(entry.image.bitmap);
      entry.image.bitmap.close();
    }
  }
}

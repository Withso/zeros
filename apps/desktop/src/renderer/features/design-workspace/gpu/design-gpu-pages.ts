/** Atlas pages on the compositor's GPU, this many bytes at most. */
export const DESIGN_GPU_PAGE_BYTES = 192 * 1024 * 1024;

export interface DesignGpuTextures<T> {
  /** A texture holding the burst's pixels, or null (context lost). */
  upload(source: unknown, width: number, height: number): T | null;
  release(texture: T): void;
}

export interface DesignGpuPage<T> {
  readonly id: number;
  readonly texture: T;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly units: Set<string>;
  usedAt: number;
}

export interface DesignGpuPageUnit<T> {
  readonly key: string;
  readonly content: number;
  readonly density: number;
  readonly page: DesignGpuPage<T>;
  /** The drawn part, in page pixels. */
  readonly src: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

export interface DesignGpuAdoptedUnit {
  readonly key: string;
  readonly content: number;
  readonly density: number;
  readonly src: DesignGpuPageUnit<unknown>["src"];
}

export function designGpuUnitKey(content: number, density: number, col: number, row: number): string {
  return `${content}:${density}:${col}:${row}`;
}

/** Each raster burst becomes one immutable page. Units are found by key and
 * densities by content; memory is reclaimed a whole least-recently-drawn
 * page at a time, never a page drawn in the current composite. */
export class DesignGpuPages<T> {
  private readonly pages = new Map<number, DesignGpuPage<T>>();
  private readonly units = new Map<string, DesignGpuPageUnit<T>>();
  private readonly densities = new Map<number, Map<number, number>>();
  private nextId = 1;
  private bytes = 0;
  private frame = 0;
  private evictedPages = 0;

  constructor(private readonly textures: DesignGpuTextures<T>, private readonly budget = DESIGN_GPU_PAGE_BYTES) {}

  /** Starts a composite; pages touched from now on are protected from eviction. */
  beginFrame(): number {
    return ++this.frame;
  }

  adopt(source: unknown, width: number, height: number, units: readonly DesignGpuAdoptedUnit[]): DesignGpuPage<T> | null {
    if (!units.length) return null;
    const texture = this.textures.upload(source, width, height);
    if (texture === null) return null;
    const page: DesignGpuPage<T> = { id: this.nextId++, texture, width, height, bytes: width * height * 4, units: new Set(), usedAt: this.frame };
    this.pages.set(page.id, page);
    this.bytes += page.bytes;
    for (const unit of units) {
      // A newer raster of the same unit replaces the old one in place.
      this.removeUnit(unit.key);
      this.units.set(unit.key, { ...unit, page });
      page.units.add(unit.key);
      const byDensity = this.densities.get(unit.content) ?? new Map<number, number>();
      byDensity.set(unit.density, (byDensity.get(unit.density) ?? 0) + 1);
      this.densities.set(unit.content, byDensity);
    }
    this.trim();
    return page;
  }

  unit(key: string): DesignGpuPageUnit<T> | undefined {
    return this.units.get(key);
  }

  /** Densities with at least one unit of this content. */
  densitiesOf(content: number): Iterable<number> {
    return this.densities.get(content)?.keys() ?? [];
  }

  touch(page: DesignGpuPage<T>): void {
    page.usedAt = this.frame;
  }

  /** Drops a content's units (its recording changed or left the canvas). */
  forget(content: number): void {
    for (const [key, unit] of [...this.units]) if (unit.content === content) this.removeUnit(key);
  }

  trim(): void {
    if (this.bytes <= this.budget) return;
    const candidates = [...this.pages.values()].filter((page) => page.usedAt < this.frame).sort((a, b) => a.usedAt - b.usedAt || a.id - b.id);
    for (const page of candidates) {
      if (this.bytes <= this.budget) break;
      this.removePage(page);
      this.evictedPages++;
    }
  }

  /** After a context loss the textures are already gone. */
  clear(release = true): void {
    for (const page of [...this.pages.values()]) this.removePage(page, release);
  }

  usage() {
    return { pages: this.pages.size, units: this.units.size, bytes: this.bytes, budget: this.budget, evictedPages: this.evictedPages };
  }

  private removeUnit(key: string): void {
    const unit = this.units.get(key);
    if (!unit) return;
    this.units.delete(key);
    unit.page.units.delete(key);
    const byDensity = this.densities.get(unit.content);
    const count = (byDensity?.get(unit.density) ?? 1) - 1;
    if (byDensity && count > 0) byDensity.set(unit.density, count);
    else {
      byDensity?.delete(unit.density);
      if (byDensity && !byDensity.size) this.densities.delete(unit.content);
    }
    if (!unit.page.units.size) this.removePage(unit.page);
  }

  private removePage(page: DesignGpuPage<T>, release = true): void {
    if (!this.pages.delete(page.id)) return;
    this.bytes -= page.bytes;
    for (const key of [...page.units]) {
      const unit = this.units.get(key);
      if (unit?.page === page) this.removeUnit(key);
    }
    if (release) this.textures.release(page.texture);
  }
}

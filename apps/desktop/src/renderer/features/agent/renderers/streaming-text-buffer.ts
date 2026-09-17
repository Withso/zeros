/** Presentation only. The store/persistence always receives native text first.
 * A short catch-up window smooths bursts without a typewriter backlog. */
export class StreamingTextBuffer {
  target: string;
  private length: number;
  private startedAt = 0;
  private advancedAt = 0;
  private boundaries: number[] = [];

  constructor(text: string) {
    this.target = text;
    this.length = text.length;
  }

  get text(): string {
    return this.target.slice(0, this.length);
  }
  get pending(): boolean {
    return this.length < this.target.length;
  }

  push(text: string, now: number): void {
    const append = text.startsWith(this.target);
    const pending = this.pending;
    this.target = text;
    // Skip extra markdown work on oversized output. Replacements/truncations
    // are authoritative corrections and must never animate through stale text.
    if (!append || text.length - this.length > 4_096 || text.length > 32_768) {
      this.flush();
      return;
    }
    if (!pending && this.pending) {
      this.startedAt = now;
      this.advancedAt = now;
    }
    this.boundaries = this.pending
      ? Array.from(
          new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
            text,
          ),
          (part) => part.index + part.segment.length,
        )
      : [];
  }

  advance(now: number): string {
    if (!this.pending) return this.text;
    if (now - this.startedAt >= 160) return this.flush();
    const elapsed = Math.max(0, now - this.advancedAt);
    if (elapsed === 0) return this.text;
    this.advancedAt = now;
    const next =
      this.length +
      Math.max(
        1,
        Math.ceil(
          (this.target.length - this.length) * (1 - Math.exp(-elapsed / 50)),
        ),
      );
    let left = 0,
      right = this.boundaries.length - 1;
    while (left < right) {
      const middle = (left + right) >>> 1;
      if (this.boundaries[middle] < next) left = middle + 1;
      else right = middle;
    }
    this.length = this.boundaries[left] ?? this.target.length;
    return this.text;
  }

  flush(): string {
    this.length = this.target.length;
    this.boundaries = [];
    return this.target;
  }
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** A position at or before `end` that is certainly a grapheme boundary: no
 * Unicode rule joins two printable ASCII characters into one cluster. 0 when
 * none is close, which segments the text once in full. */
function certainBoundaryBefore(text: string, end: number): number {
  for (let i = end; i > 0 && i > end - 256; i--) {
    const before = text.charCodeAt(i - 1);
    const after = text.charCodeAt(i);
    if (before >= 0x20 && before <= 0x7e && after >= 0x20 && after <= 0x7e) return i;
  }
  return 0;
}

/** Presentation only. The store/persistence always receives native text first.
 * A short catch-up window smooths bursts without a typewriter backlog. */
export class StreamingTextBuffer {
  target: string;
  private length: number;
  private startedAt = 0;
  private advancedAt = 0;
  private boundaries: number[] = [];
  /** The largest certain grapheme boundary of `target` at or before the
   * revealed length. Appending text can only move the boundary at the previous
   * end (a ZWJ emoji, a combining mark or a regional indicator continues the
   * last cluster) and the one before a final unpaired high surrogate
   * (completing the pair can join it to the cluster before); every other
   * boundary inside the previous target is final. The revealed length itself
   * need not stay one: a chunk can arrive before the next frame and extend
   * the cluster it ends in. */
  private anchor: number;
  /** Start of the target's last grapheme, or -1 until it has been segmented. */
  private tailStart = -1;

  constructor(text: string) {
    this.target = text;
    this.length = text.length;
    this.anchor = text.length;
  }

  get text(): string {
    return this.target.slice(0, this.length);
  }
  get pending(): boolean {
    return this.length < this.target.length;
  }

  push(text: string, now: number): void {
    const previous = this.target;
    const append = text.startsWith(previous);
    const pending = this.pending;
    this.target = text;
    // Skip extra markdown work on oversized output. Replacements/truncations
    // are authoritative corrections and must never animate through stale text.
    if (!append || text.length - this.length > 4_096 || text.length > 32_768) {
      this.flush();
      this.tailStart = -1;
      return;
    }
    if (!pending && this.pending) {
      this.startedAt = now;
      this.advancedAt = now;
    }
    if (!this.pending) {
      this.boundaries = [];
      return;
    }
    // Restart segmentation from a boundary that survives this append: the
    // anchor, otherwise the start of the previous target's last cluster,
    // otherwise a certain boundary near its end. A final high surrogate is
    // its own cluster, and the boundary before it is not final.
    const last = previous.charCodeAt(previous.length - 1);
    const stable = previous.length - (last >= 0xd800 && last <= 0xdbff ? 1 : 0);
    this.segmentFrom(
      this.anchor < stable
        ? this.anchor
        : this.tailStart >= 0 && this.tailStart < stable
          ? this.tailStart
          : certainBoundaryBefore(previous, previous.length - 1),
    );
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
    this.anchor = this.length;
    return this.text;
  }

  flush(): string {
    this.length = this.target.length;
    this.anchor = this.length;
    this.boundaries = [];
    return this.target;
  }

  /** Boundaries after the revealed length, segmenting `target` from `restart`
   * (a certain boundary, or 0). Records the anchor and the last cluster. */
  private segmentFrom(restart: number): void {
    const boundaries: number[] = [];
    let previousEnd = restart;
    let lastStart = restart;
    let anchor = restart;
    for (const part of graphemes.segment(this.target.slice(restart))) {
      const end = restart + part.index + part.segment.length;
      lastStart = previousEnd;
      previousEnd = end;
      if (end > this.length) boundaries.push(end);
      else anchor = end;
    }
    this.boundaries = boundaries;
    this.tailStart = lastStart;
    this.anchor = anchor;
  }
}

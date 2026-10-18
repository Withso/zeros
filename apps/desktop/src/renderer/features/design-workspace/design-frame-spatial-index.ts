export interface DesignSpatialRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DesignSpatialFrame extends DesignSpatialRect {
  readonly file: string;
}

type Bounds = readonly [number, number, number, number];
const MAX_DISTANCE_COORDINATE = Math.sqrt(Number.MAX_VALUE) / 4;

function boundsOf(rect: DesignSpatialRect, allowEmpty: boolean): Bounds {
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  if (
    ![rect.x, rect.y, rect.width, rect.height, right, bottom].every(
      Number.isFinite,
    ) ||
    rect.width < 0 ||
    rect.height < 0 ||
    (!allowEmpty && (rect.width === 0 || rect.height === 0))
  )
    throw new RangeError("Design spatial geometry is invalid.");
  return [rect.x, rect.y, right, bottom];
}

function overlaps(data: Float64Array, index: number, bounds: Bounds): boolean {
  const offset = index * 4;
  return (
    data[offset]! <= bounds[2] &&
    data[offset + 1]! <= bounds[3] &&
    data[offset + 2]! >= bounds[0] &&
    data[offset + 3]! >= bounds[1]
  );
}

function distanceToBounds(
  data: Float64Array,
  index: number,
  x: number,
  y: number,
) {
  const offset = index * 4;
  const dx = Math.max(data[offset]! - x, 0, x - data[offset + 2]!);
  const dy = Math.max(data[offset + 1]! - y, 0, y - data[offset + 3]!);
  return dx * dx + dy * dy;
}

export class DesignFrameSpatialIndex<T extends DesignSpatialFrame> {
  private readonly frames: readonly T[];
  private readonly byFile = new Map<string, number>();
  private readonly geometry: Float64Array;
  private readonly centers: Float64Array;
  private readonly indices: Int32Array;
  private readonly nodes: Float64Array;
  private readonly left: Int32Array;
  private readonly right: Int32Array;
  private readonly starts: Int32Array;
  private readonly ends: Int32Array;
  private readonly root: number;
  private nodeCount = 0;

  constructor(frames: readonly T[]) {
    if (frames.length > 10_000)
      throw new RangeError("Design spatial index exceeds its frame budget.");
    this.frames = [...frames];
    this.geometry = new Float64Array(frames.length * 4);
    this.centers = new Float64Array(frames.length * 2);
    this.indices = Int32Array.from(frames, (_, index) => index);
    for (const [index, frame] of frames.entries()) {
      if (!frame.file || this.byFile.has(frame.file))
        throw new RangeError("Design spatial frame identities must be unique.");
      this.byFile.set(frame.file, index);
      this.geometry.set(boundsOf(frame, false), index * 4);
      this.centers[index * 2] = frame.x + frame.width / 2;
      this.centers[index * 2 + 1] = frame.y + frame.height / 2;
      if (
        Math.max(
          Math.abs(this.centers[index * 2]!),
          Math.abs(this.centers[index * 2 + 1]!),
        ) > MAX_DISTANCE_COORDINATE
      )
        throw new RangeError(
          "Design spatial coordinates exceed numeric bounds.",
        );
    }
    const capacity = Math.max(0, frames.length * 2 - 1);
    this.nodes = new Float64Array(capacity * 4);
    this.left = new Int32Array(capacity).fill(-1);
    this.right = new Int32Array(capacity).fill(-1);
    this.starts = new Int32Array(capacity);
    this.ends = new Int32Array(capacity);
    this.root = frames.length ? this.build(0, frames.length) : -1;
  }

  getStats() {
    return {
      frames: this.frames.length,
      nodes: this.nodeCount,
      bufferBytes: [
        this.geometry,
        this.centers,
        this.indices,
        this.nodes,
        this.left,
        this.right,
        this.starts,
        this.ends,
      ].reduce((sum, array) => sum + array.byteLength, 0),
    };
  }

  has(file: string): boolean {
    return this.byFile.has(file);
  }

  search(rect: DesignSpatialRect): T[] {
    const bounds = boundsOf(rect, true);
    if (this.root < 0) return [];
    const found: number[] = [];
    const stack = [this.root];
    while (stack.length) {
      const node = stack.pop()!;
      if (!overlaps(this.nodes, node, bounds)) continue;
      if (this.left[node] === -1) {
        for (let at = this.starts[node]!; at < this.ends[node]!; at++) {
          const index = this.indices[at]!;
          if (overlaps(this.geometry, index, bounds)) found.push(index);
        }
      } else {
        stack.push(this.left[node]!, this.right[node]!);
      }
    }
    return found.sort((a, b) => a - b).map((index) => this.frames[index]!);
  }

  nearest(
    point: Readonly<{ x: number; y: number }>,
    limit: number,
    within?: DesignSpatialRect,
  ): T[] {
    if (
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      Math.max(Math.abs(point.x), Math.abs(point.y)) >
        MAX_DISTANCE_COORDINATE ||
      !Number.isInteger(limit) ||
      limit < 0 ||
      limit > 10_000
    )
      throw new RangeError("Design spatial nearest query is invalid.");
    const bounds = within ? boundsOf(within, true) : null;
    if (this.root < 0 || limit === 0) return [];
    const best: Array<{ index: number; distance: number }> = [];
    const compare = (a: (typeof best)[number], b: (typeof best)[number]) =>
      a.distance - b.distance ||
      this.frames[a.index]!.file.localeCompare(this.frames[b.index]!.file);
    const offer = (candidate: (typeof best)[number]) => {
      if (best.length < limit) {
        best.push(candidate);
        let at = best.length - 1;
        while (at > 0) {
          const parent = (at - 1) >>> 1;
          if (compare(best[at]!, best[parent]!) <= 0) break;
          [best[at], best[parent]] = [best[parent]!, best[at]!];
          at = parent;
        }
        return;
      }
      if (compare(candidate, best[0]!) >= 0) return;
      best[0] = candidate;
      let at = 0;
      while (at * 2 + 1 < best.length) {
        let child = at * 2 + 1;
        if (
          child + 1 < best.length &&
          compare(best[child + 1]!, best[child]!) > 0
        )
          child++;
        if (compare(best[at]!, best[child]!) >= 0) break;
        [best[at], best[child]] = [best[child]!, best[at]!];
        at = child;
      }
    };
    const stack = [this.root];
    while (stack.length) {
      const node = stack.pop()!;
      if (bounds && !overlaps(this.nodes, node, bounds)) continue;
      if (
        best.length === limit &&
        distanceToBounds(this.nodes, node, point.x, point.y) > best[0]!.distance
      )
        continue;
      if (this.left[node] === -1) {
        for (let at = this.starts[node]!; at < this.ends[node]!; at++) {
          const index = this.indices[at]!;
          if (bounds && !overlaps(this.geometry, index, bounds)) continue;
          const dx = this.centers[index * 2]! - point.x;
          const dy = this.centers[index * 2 + 1]! - point.y;
          offer({ index, distance: dx * dx + dy * dy });
        }
      } else {
        const left = this.left[node]!;
        const right = this.right[node]!;
        const leftDistance = distanceToBounds(
          this.nodes,
          left,
          point.x,
          point.y,
        );
        const rightDistance = distanceToBounds(
          this.nodes,
          right,
          point.x,
          point.y,
        );
        if (leftDistance < rightDistance) stack.push(right, left);
        else stack.push(left, right);
      }
    }
    return best.sort(compare).map(({ index }) => this.frames[index]!);
  }

  private build(start: number, end: number): number {
    const node = this.nodeCount++;
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (let at = start; at < end; at++) {
      const offset = this.indices[at]! * 4;
      left = Math.min(left, this.geometry[offset]!);
      top = Math.min(top, this.geometry[offset + 1]!);
      right = Math.max(right, this.geometry[offset + 2]!);
      bottom = Math.max(bottom, this.geometry[offset + 3]!);
    }
    this.nodes.set([left, top, right, bottom], node * 4);
    if (end - start <= 8) {
      this.starts[node] = start;
      this.ends[node] = end;
      return node;
    }
    const axis = right - left >= bottom - top ? 0 : 1;
    const ordered = this.indices
      .slice(start, end)
      .sort(
        (a, b) =>
          this.centers[a * 2 + axis]! - this.centers[b * 2 + axis]! ||
          this.frames[a]!.file.localeCompare(this.frames[b]!.file),
      );
    this.indices.set(ordered, start);
    const middle = (start + end) >>> 1;
    this.left[node] = this.build(start, middle);
    this.right[node] = this.build(middle, end);
    return node;
  }
}

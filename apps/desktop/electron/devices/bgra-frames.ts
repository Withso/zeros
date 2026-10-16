// Raw simulator frames from AXe's `stream-video --format bgra`.
//
// The stream has no headers: it is whole frames back to back, each the
// framebuffer's IOSurface rows, which are padded to a multiple of 16 pixels.
// So the layout comes from the device's screen size and the stream scale.

export interface BgraFrameLayout {
  /** Visible pixels per row. */
  width: number;
  height: number;
  /** Bytes per row in the stream, padding included. */
  stride: number;
  frameBytes: number;
}

export function bgraFrameLayout(
  widthPx: number,
  heightPx: number,
  scale: number,
): BgraFrameLayout {
  const width = Math.floor(widthPx * scale);
  const height = Math.floor(heightPx * scale);
  if (width < 1 || height < 1) throw new Error("Invalid simulator screen size.");
  const stride = Math.ceil(width / 16) * 16 * 4;
  return { width, height, stride, frameBytes: stride * height };
}

/** Splits a byte stream into frames. `onFrame` gets a buffer that is reused
 * for the next frame, so it must finish with it before returning. */
export class BgraFramer {
  private readonly frame: Buffer;
  private filled = 0;

  constructor(
    private readonly layout: BgraFrameLayout,
    private readonly onFrame: (frame: Buffer) => void,
  ) {
    this.frame = Buffer.allocUnsafe(layout.frameBytes);
  }

  push(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      const take = Math.min(this.layout.frameBytes - this.filled, chunk.length - offset);
      chunk.copy(this.frame, this.filled, offset, offset + take);
      this.filled += take;
      offset += take;
      if (this.filled === this.layout.frameBytes) {
        this.filled = 0;
        this.onFrame(this.frame);
      }
    }
  }
}

/** Drops each row's padding into `target`, which holds width × height × 4. */
export function packBgraRows(
  frame: Buffer,
  layout: BgraFrameLayout,
  target: Buffer,
): Buffer {
  const rowBytes = layout.width * 4;
  if (rowBytes === layout.stride) {
    frame.copy(target, 0, 0, layout.frameBytes);
    return target;
  }
  for (let row = 0; row < layout.height; row++) {
    const start = row * layout.stride;
    frame.copy(target, row * rowBytes, start, start + rowBytes);
  }
  return target;
}

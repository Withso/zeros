import type { SimulatorFrame } from "@zeros/protocol/simulators";

export interface DecodedFrame {
  width: number;
  height: number;
  close(): void;
}

/** Decodes and paints only the newest frame. While one decodes, later frames
 * replace each other, so a slow decode skips frames instead of falling
 * behind, and a frame never paints over a newer one. */
export class LatestFramePainter<Image extends DecodedFrame> {
  private decoding = false;
  private next: SimulatorFrame | null = null;
  private lastSeq = -1;
  private disposed = false;

  constructor(
    private readonly decode: (frame: SimulatorFrame) => Promise<Image>,
    private readonly paint: (image: Image, frame: SimulatorFrame) => void,
  ) {}

  push(frame: SimulatorFrame): void {
    if (this.disposed || frame.seq <= this.lastSeq) return;
    if (this.decoding) {
      if (!this.next || frame.seq > this.next.seq) this.next = frame;
      return;
    }
    void this.run(frame);
  }

  private async run(frame: SimulatorFrame): Promise<void> {
    this.decoding = true;
    try {
      const image = await this.decode(frame);
      try {
        if (!this.disposed && frame.seq > this.lastSeq) {
          this.lastSeq = frame.seq;
          this.paint(image, frame);
        }
      } finally {
        image.close();
      }
    } catch {
      // A frame that won't decode is skipped; the next one replaces it.
    } finally {
      this.decoding = false;
    }
    const next = this.next;
    this.next = null;
    if (next && !this.disposed) this.push(next);
  }

  dispose(): void {
    this.disposed = true;
    this.next = null;
  }
}

export function decodeSimulatorFrame(frame: SimulatorFrame): Promise<ImageBitmap> {
  return createImageBitmap(new Blob([frame.jpeg as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }));
}

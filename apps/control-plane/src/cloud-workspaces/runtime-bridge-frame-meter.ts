/** What a frame meter reports about the message its socket is receiving. */
export type WebSocketFrameMeterEvents = {
  /** A data frame header arrived. `bytes` is the message's declared size so
   * far, summed over its frames. Return false to stop metering; the caller is
   * then expected to close the connection. */
  grow(bytes: number): boolean;
  /** The message's final frame has been received in full. */
  complete(): void;
};

/**
 * Follows RFC 6455 frame headers on one raw socket, beside `ws`, so the relay
 * can charge a message's declared size to a shared budget as soon as its
 * header arrives, before `ws` buffers the payload. It never alters, copies or
 * retains payload bytes. `ws` still validates every frame; after a framing
 * error the connection closes anyway, so the meter simply stops.
 */
export class WebSocketFrameMeter {
  private readonly header = Buffer.alloc(14);
  private headerLength = 0;
  private payloadRemaining = 0;
  private inPayload = false;
  private dataFrame = false;
  private finalFrame = false;
  private messageBytes = 0;
  private stopped = false;

  constructor(private readonly events: WebSocketFrameMeterEvents) {}

  feed(chunk: Buffer): void {
    let offset = 0;
    while (!this.stopped) {
      if (this.inPayload) {
        const take = Math.min(this.payloadRemaining, chunk.length - offset);
        offset += take;
        this.payloadRemaining -= take;
        if (this.payloadRemaining > 0) return;
        this.inPayload = false;
        if (this.dataFrame && this.finalFrame) {
          this.messageBytes = 0;
          this.events.complete();
        }
      }
      if (offset >= chunk.length) return;
      this.header[this.headerLength++] = chunk[offset++]!;
      if (this.headerLength < 2) continue;
      const second = this.header[1]!;
      const shortLength = second & 0x7f;
      const required =
        2 +
        (shortLength === 126 ? 2 : shortLength === 127 ? 8 : 0) +
        (second & 0x80 ? 4 : 0);
      if (this.headerLength < required) continue;
      const length =
        shortLength === 126
          ? this.header.readUInt16BE(2)
          : shortLength === 127
            ? Number(this.header.readBigUInt64BE(2))
            : shortLength;
      this.headerLength = 0;
      if (!Number.isSafeInteger(length)) {
        this.stopped = true;
        return;
      }
      const first = this.header[0]!;
      this.finalFrame = (first & 0x80) !== 0;
      // Control frames (opcode 8 and above) may interleave a fragmented
      // message; they are at most 125 bytes and belong to no message.
      this.dataFrame = (first & 0x0f) < 8;
      this.payloadRemaining = length;
      this.inPayload = true;
      if (this.dataFrame) {
        this.messageBytes += length;
        if (!this.events.grow(this.messageBytes)) {
          this.stopped = true;
          return;
        }
      }
    }
  }
}

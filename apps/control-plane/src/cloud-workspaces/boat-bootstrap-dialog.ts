import { TextDecoder } from "node:util";

export type BoatBootstrapFrameHandler = (frame: string) => Promise<string | undefined>;
const MAX_FRAME = 128 * 1024;

/** Internal to a fixed pinned-SSH command. Never logs frame or reply bytes. */
export class BoatBootstrapDialog {
  private buffer = Buffer.alloc(0);
  private pending = Promise.resolve();
  private frames = 0;
  private failed = false;
  private rejectFailure!: (error: Error) => void;
  private readonly failure = new Promise<never>((_, reject) => { this.rejectFailure = reject; });
  constructor(private readonly handle: BoatBootstrapFrameHandler,
    private readonly write: (bytes: Buffer) => void, private readonly onFailure: () => void) {
    void this.failure.catch(() => undefined);
  }

  private fail() {
    if (this.failed) return;
    this.failed = true;
    this.rejectFailure(new Error("Bootstrap dialogue failed"));
    this.onFailure();
  }
  cancel() { this.fail(); }

  feed(chunk: Buffer) {
    if (this.failed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const newline = this.buffer.indexOf(10);
      if (newline === -1) {
        if (this.buffer.length > MAX_FRAME) this.fail();
        return;
      }
      if (newline > MAX_FRAME || ++this.frames > 12) { this.fail(); return; }
      const bytes = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      this.pending = this.pending.then(async () => {
        if (this.failed) return;
        const line = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        const reply = await this.handle(line);
        if (this.failed || reply === undefined) return;
        if (typeof reply !== "string" || Buffer.byteLength(reply) > MAX_FRAME || /[\r\n\0]/.test(reply))
          throw new Error("Bootstrap dialogue failed");
        this.write(Buffer.from(reply + "\n"));
      }).catch(() => this.fail());
    }
  }

  async finish() {
    if (this.buffer.length) this.fail();
    await Promise.race([this.pending, this.failure]);
    if (this.failed) throw new Error("Bootstrap dialogue failed");
  }
}

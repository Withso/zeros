import type { ChildProcess } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { parseCloudRunnerProof, type CloudRunnerIntent, type CloudRunnerProof } from "./cloud-runner-contract";
import type { CloudRunnerNativeRequest, CloudRunnerPrivateChannel } from "./cloud-runner-lifecycle";

const unavailable = () => new Error("cloud_runner_private_channel_unavailable");
// Codex's native transport permits 4 MiB frames / 8 MiB queued input. Keep
// provider bytes opaque and separately bounded from the private launch frame.
const MAX_FRAME = 4096, MAX_PRIVATE = 64 * 1024, MAX_PENDING = 8 * 1024 * 1024;
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

/** Private inherited descriptors, supplied to a fixed unit by the original
 * native client. Provider adapters keep synchronous ChildProcess semantics,
 * but no provider input passes the gate before native proof + material ACK.
 * Unit proof is independently established by the driver, never by this parser. */
export class CloudRunnerPipes {
  private readonly input: Writable;
  private readonly output: PassThrough;
  private readonly native = deferred<CloudRunnerProof>();
  private readonly hello = deferred<CloudRunnerProof>();
  private readonly acknowledgement = deferred<CloudRunnerProof>();
  private readonly gated: Writable;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly seen = new Set<string>();
  private pending: Buffer = Buffer.alloc(0);
  private blocked: { bytes: Buffer; done(error?: Error | null): void } | undefined;
  private blockedEnd: ((error?: Error | null) => void) | undefined;
  private opened = false;
  private outputEnded = false;
  private closed = false;
  private started = false;
  private sent = false;
  private expected: CloudRunnerProof | null = null;
  constructor(private readonly options: { child: ChildProcess; intent: CloudRunnerIntent;
    timeoutMs?: number; interrupted(): void; assertCurrent(): void }) {
    const { child } = options;
    if (!child.stdin || !child.stdout || !child.stderr) throw unavailable();
    const timeout = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 10_000) throw unavailable();
    this.input = child.stdin;
    this.output = new PassThrough({ highWaterMark: 64 * 1024 });
    this.gated = new Writable({ highWaterMark: 64 * 1024,
      write: (chunk: Buffer, _encoding, done) => {
        if (this.closed || chunk.byteLength > MAX_PENDING) { done(unavailable()); this.fail(); return; }
        if (this.opened) this.input.write(chunk, done);
        else this.blocked = { bytes: Buffer.from(chunk), done };
      },
      final: done => {
        if (this.closed) done(unavailable());
        else if (this.opened) this.input.end(done);
        else this.blockedEnd = done;
      },
    });
    const write = this.gated.write.bind(this.gated);
    this.gated.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void) => {
      const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk, typeof encoding === "string" ? encoding : undefined) : chunk.byteLength;
      if (this.gated.writableLength + bytes > MAX_PENDING) {
        this.fail();
        const done = typeof encoding === "function" ? encoding : callback;
        done?.(unavailable()); return false;
      }
      return typeof encoding === "string" ? write(chunk, encoding, callback) : write(chunk, encoding ?? callback);
    }) as Writable["write"];
    this.gated.on("error", () => this.fail()); this.output.on("error", () => this.fail());
    this.input.on("error", () => this.fail());
    const raw = child.stdout;
    raw.on("data", (chunk: Buffer) => {
      if (this.closed) return;
      if (this.opened) { if (!this.output.write(chunk)) raw.pause(); return; }
      this.receive(chunk);
      if (this.output.writableLength >= this.output.writableHighWaterMark) raw.pause();
    });
    this.output.on("drain", () => { if (!this.closed) raw.resume(); });
    raw.on("error", () => this.fail());
    raw.on("end", () => {
      if (!this.opened) this.fail();
      else { this.outputEnded = true; this.output.end(); }
    });
    child.on("error", () => this.fail());
    child.once("exit", () => { if (!this.opened) this.fail(); });
    child.stdin = this.gated; child.stdout = this.output;
    this.timer = setTimeout(() => this.fail(), timeout); this.timer.unref();
  }
  private receive(bytes: Buffer): void {
    // Consume one bounded control line at a time. Bytes following ACK are
    // opaque provider output, including a frame-shaped provider message.
    while (bytes.length && !this.closed) {
      if (this.opened) { this.output.write(bytes); return; }
      const newline = bytes.indexOf(10), count = newline < 0 ? bytes.length : newline;
      if (this.pending.length + count > MAX_FRAME) { this.fail(); return; }
      this.pending = Buffer.concat([this.pending, bytes.subarray(0, count)]);
      if (newline < 0) return;
      let value: { type: string; proof: unknown };
      try {
        value = JSON.parse(this.pending.toString("utf8")) as typeof value;
        if (!value || Object.keys(value).sort().join(",") !== "proof,type" ||
          !["native", "hello", "ack"].includes(value.type) || this.seen.has(value.type) ||
          value.type === "ack" && (!this.sent || !this.expected)) throw unavailable();
        const proof = parseCloudRunnerProof(value.proof, this.options.intent, this.expected ?? undefined);
        this.seen.add(value.type);
        if (value.type === "native") this.native.resolve(proof);
        else if (value.type === "hello") this.hello.resolve(proof);
        else {
          this.options.assertCurrent();
          this.opened = true; clearTimeout(this.timer);
          this.acknowledgement.resolve(proof);
          const blocked = this.blocked; this.blocked = undefined;
          if (blocked) this.input.write(blocked.bytes, blocked.done);
          const ended = this.blockedEnd; this.blockedEnd = undefined;
          if (ended) this.input.end(ended);
        }
      } catch { this.fail(); return; }
      this.pending = Buffer.alloc(0); bytes = bytes.subarray(newline + 1);
    }
  }
  async start(): Promise<void> {
    if (this.started || this.closed) throw unavailable();
    this.started = true;
    this.input.write(`${JSON.stringify({ type: "start", intent: this.options.intent })}\n`, error => { if (error) this.fail(); });
    await this.native.promise;
    if (this.closed) throw unavailable();
  }
  async connect(proof: CloudRunnerProof): Promise<CloudRunnerPrivateChannel> {
    if (!this.started || this.closed || this.expected) throw unavailable();
    this.expected = parseCloudRunnerProof(proof, this.options.intent);
    try {
      parseCloudRunnerProof(await this.native.promise, this.options.intent, this.expected);
      parseCloudRunnerProof(await this.hello.promise, this.options.intent, this.expected);
      if (this.closed) throw unavailable();
    } catch { this.fail(); throw unavailable(); }
    return { proof: this.expected,
      send: (request, signal) => this.send(request, signal), close: () => this.close() };
  }
  private async send(request: CloudRunnerNativeRequest, signal: AbortSignal): Promise<CloudRunnerProof> {
    if (this.closed || this.sent || !this.expected || signal.aborted) throw unavailable();
    this.options.assertCurrent();
    const encoded = Buffer.from(`${JSON.stringify({ type: "launch", request })}\n`);
    if (encoded.length > MAX_PRIVATE) throw unavailable();
    this.sent = true;
    const aborted = () => this.fail(); signal.addEventListener("abort", aborted, { once: true });
    try {
      this.input.write(encoded, error => { encoded.fill(0); if (error) this.fail(); });
      const proof = await this.acknowledgement.promise;
      if (this.closed || signal.aborted) throw unavailable();
      return proof;
    } finally { signal.removeEventListener("abort", aborted); }
  }
  private finish(interrupted: boolean): void {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.timer);
    const error = unavailable();
    this.native.reject(error); this.hello.reject(error); this.acknowledgement.reject(error);
    const blocked = this.blocked; this.blocked = undefined;
    blocked?.done(error);
    const ended = this.blockedEnd; this.blockedEnd = undefined;
    ended?.(error);
    this.gated.destroy(error);
    // Natural EOF already ended this stream. Preserve its unread tail until
    // the provider consumes it; an interrupted handoff still discards output.
    if (interrupted || !this.outputEnded) this.output.destroy();
    this.input.destroy(); this.pending = Buffer.alloc(0);
    if (interrupted) this.options.interrupted();
  }
  private fail(): void { this.finish(true); }
  close(): void { this.finish(false); }
}

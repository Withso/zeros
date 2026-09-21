/** Short, renewable authority for HTTP previews, including slow request bodies
 * and responses. A hung database check cannot extend the monotonic deadline. */
export class PreviewRequestLease {
  private readonly controller = new AbortController();
  readonly signal: AbortSignal;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private renewal: ReturnType<typeof setTimeout> | undefined;
  private readonly maximum: ReturnType<typeof setTimeout>;
  private deadline = 0;
  private closed = false;
  private readonly onAbort = () => this.close();
  constructor(expiresAtMs: number, caller: AbortSignal, private readonly check: () => Promise<number | null>) {
    this.signal = AbortSignal.any([caller, this.controller.signal]);
    this.maximum = setTimeout(() => this.close(), 60_000);
    this.maximum.unref?.();
    this.signal.addEventListener("abort", this.onAbort, {once: true});
    this.accept(expiresAtMs);
    if (this.signal.aborted) this.close(); else this.schedule();
  }
  private accept(expiresAtMs: number): void {
    const remaining = Math.min(10_000, expiresAtMs - Date.now());
    if (!Number.isFinite(remaining) || remaining <= 0) { this.close(); return; }
    this.deadline = performance.now() + remaining;
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = setTimeout(() => this.close(), remaining);
    this.expiry.unref?.();
  }
  private schedule(): void {
    if (this.closed) return;
    if (this.renewal) clearTimeout(this.renewal);
    this.renewal = setTimeout(() => {
      this.renewal = undefined;
      void this.revalidate().then(() => this.schedule()).catch(() => {});
    }, Math.max(1, Math.min(5000, (this.deadline - performance.now()) / 2)));
    this.renewal.unref?.();
  }
  async revalidate(): Promise<void> {
    try {
      this.assertLive();
      const expiresAt = await this.wait(this.check);
      this.assertLive();
      if (expiresAt === null) throw new Error("Preview authority revoked");
      this.accept(expiresAt); this.assertLive();
    } catch { this.close(); throw new Error("Preview authority revoked"); }
  }
  assertLive(): void {
    if (this.closed || this.signal.aborted || performance.now() >= this.deadline) {
      this.close(); throw new Error("Preview authority expired");
    }
  }
  async wait<T>(operation: () => Promise<T>): Promise<T> {
    this.assertLive();
    let onAbort: (() => void) | undefined;
    try {
      const value = await Promise.race([Promise.resolve().then(() => { this.assertLive(); return operation(); }), new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error("Preview authority expired"));
        this.signal.addEventListener("abort", onAbort, {once: true});
        if (this.signal.aborted) onAbort();
      })]);
      this.assertLive(); return value;
    } finally { if (onAbort) this.signal.removeEventListener("abort", onAbort); }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.maximum); if (this.expiry) clearTimeout(this.expiry); if (this.renewal) clearTimeout(this.renewal);
    this.signal.removeEventListener("abort", this.onAbort);
    this.controller.abort();
  }
}

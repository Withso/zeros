/** Volatile pending requests, keyed by the exact owned Chromium frame object.
 * Revoke/hidden-tab cleanup fences admission even before a grant is returned.
 * A replacement frame with the same React name never inherits that request. */
export class CloudPreviewFrameAdmissions<T extends object> {
  private readonly pending = new Map<string, object>();
  constructor(private readonly maximum = 32) {}
  begin(frameName: string, frame: T) {
    const marker = {};
    this.pending.delete(frameName);
    this.pending.set(frameName, marker);
    while (this.pending.size > this.maximum)
      this.pending.delete(this.pending.keys().next().value!);
    return {
      current: (candidate: T | null) =>
        candidate === frame && this.pending.get(frameName) === marker,
    };
  }
  cancel(frameName: string): void {
    this.pending.delete(frameName);
  }
  clear(): void {
    this.pending.clear();
  }
}

import type { TokenizedCode } from "./syntax";

/** Payload accounting, not a claim about V8 heap layout. Charge UTF-16 source
 * and token text plus line/token structure; sparse files must not be free. */
function cost(code: string, value: TokenizedCode): { bytes: number; tokens: number } {
  let bytes = code.length * 2 + value.tokens.length * 32 + 256;
  let tokens = 0;
  for (const line of value.tokens) for (const token of line) {
    tokens++;
    bytes += token.content.length * 2 + 128;
  }
  return { bytes, tokens };
}

/** Local editor results stay warm under independent source, entry and token
 * budgets. A single oversized result is returned to its editor but not pinned. */
export class LocalTokenCache {
  private readonly values = new Map<string, Map<string, {
    value: TokenizedCode; bytes: number; tokens: number;
  }>>();
  private bytes = 0;
  private tokens = 0;
  private entries = 0;

  get(code: string, variant: string): TokenizedCode | undefined {
    const variants = this.values.get(code);
    const hit = variants?.get(variant);
    if (hit && variants) {
      this.values.delete(code);
      this.values.set(code, variants);
    }
    return hit?.value;
  }

  put(code: string, variant: string, value: TokenizedCode): void {
    if (value.partial || code.length > 200_000) return;
    const entry = { value, ...cost(code, value) };
    if (entry.bytes > 8_000_000 || entry.tokens > 60_000) return;
    const variants = this.values.get(code) ?? new Map();
    const previous = variants.get(variant);
    if (previous) {
      this.bytes -= previous.bytes;
      this.tokens -= previous.tokens;
      this.entries--;
    }
    variants.set(variant, entry);
    this.values.delete(code);
    this.values.set(code, variants);
    this.bytes += entry.bytes;
    this.tokens += entry.tokens;
    this.entries++;
    while (this.bytes > 8_000_000 || this.tokens > 60_000 || this.entries > 64) {
      const oldest = this.values.keys().next().value;
      if (oldest === undefined) break;
      for (const evicted of this.values.get(oldest)!.values()) {
        this.bytes -= evicted.bytes;
        this.tokens -= evicted.tokens;
        this.entries--;
      }
      this.values.delete(oldest);
    }
  }
}

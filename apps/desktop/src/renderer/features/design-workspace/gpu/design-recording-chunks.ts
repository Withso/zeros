// Recordings are content-addressed chunks: identical bytes (the web fonts every
// picture embeds, shared drawing) travel and live once. The cache owns those
// bytes for the renderer; a picture is reassembled only when the rasterizer
// needs it, so font copies never multiply in this heap.

export const DESIGN_RECORDING_CHUNK_BYTES = 128 * 1024 * 1024;

export async function designRecordingChunkIdOf(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  let hex = "";
  for (let index = 0; index < 16; index++) hex += digest[index]!.toString(16).padStart(2, "0");
  return hex;
}

type Base64Decoder = (value: string) => Uint8Array;
const nativeBase64 = (Uint8Array as unknown as { fromBase64?: Base64Decoder }).fromBase64;
function decodeBase64(value: string): Uint8Array {
  if (nativeBase64) return nativeBase64(value);
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export interface DesignRecordingChunksUsage {
  count: number;
  bytes: number;
  budget: number;
  /** Chunks delivered, including ones already held. */
  received: number;
  receivedBytes: number;
  /** Chunks whose bytes did not hash to their id, or did not decode. */
  rejected: number;
  evicted: number;
  leased: number;
}

export class DesignRecordingChunks {
  /** Least recently used first. */
  private readonly entries = new Map<string, Uint8Array>();
  private readonly leases = new Map<string, number>();
  /** How many adopted recordings reference each chunk. */
  private readonly refs = new Map<string, number>();
  private bytes = 0;
  private readonly counts = { received: 0, receivedBytes: 0, rejected: 0, evicted: 0 };
  private readonly budget: number;

  constructor(options: { budgetBytes?: number } = {}) {
    this.budget = options.budgetBytes ?? DESIGN_RECORDING_CHUNK_BYTES;
  }

  /** A chunk is stored only when its bytes hash to its id. An id is the
   * cache identity of every later frame that references it, so one corrupt
   * chunk must never be adopted. Admission never evicts; with `lease` the
   * admitted chunks stay until the caller has adopted its recordings. */
  async admit(chunks: ReadonlyArray<{ id: string; data: string }>, options: { lease?: boolean } = {}):
    Promise<{ admitted: string[]; rejected: string[]; release(): void }> {
    const admitted: string[] = [], rejected: string[] = [];
    const decoded = chunks.map(({ id, data }) => {
      this.counts.received++;
      try {
        const bytes = decodeBase64(data);
        this.counts.receivedBytes += bytes.byteLength;
        return { id, bytes };
      } catch { return { id, bytes: null }; }
    });
    const verified = await Promise.all(decoded.map(async ({ id, bytes }) =>
      bytes && (this.entries.has(id) || await designRecordingChunkIdOf(bytes) === id) ? bytes : null));
    decoded.forEach(({ id }, index) => {
      const bytes = verified[index];
      if (!bytes) { this.counts.rejected++; rejected.push(id); return; }
      if (!this.entries.has(id)) { this.entries.set(id, bytes); this.bytes += bytes.byteLength; }
      else this.touch(id);
      admitted.push(id);
    });
    // Leasing in the same task as insertion: no other release can trim the
    // reply's chunks before its recordings are adopted.
    return { admitted, rejected, release: options.lease ? this.lease(admitted) : () => {} };
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Keeps chunks a request claims to hold until its reply is processed. */
  lease(ids: Iterable<string>): () => void {
    const held = [...new Set(ids)].filter((id) => this.entries.has(id));
    for (const id of held) this.leases.set(id, (this.leases.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const id of held) {
        const count = (this.leases.get(id) ?? 1) - 1;
        if (count > 0) this.leases.set(id, count);
        else this.leases.delete(id);
      }
      this.trim();
    };
  }

  reference(ids: readonly string[]): void {
    for (const id of new Set(ids)) this.refs.set(id, (this.refs.get(id) ?? 0) + 1);
  }

  unreference(ids: readonly string[]): void {
    for (const id of new Set(ids)) {
      const count = (this.refs.get(id) ?? 1) - 1;
      if (count > 0) this.refs.set(id, count);
      else this.refs.delete(id);
    }
  }

  /** Chunks to claim in a request: the caller's preferred chunks first (the
   * frames' previous manifests), then those shared by the most recordings.
   * Only chunks held now are claimed; the caller leases what it sends. */
  known(preferred: Iterable<string>, max: number): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const id of preferred) {
      if (result.length >= max) return result;
      if (!seen.has(id) && this.entries.has(id)) { seen.add(id); result.push(id); }
    }
    const shared = [...this.refs].filter(([id]) => !seen.has(id) && this.entries.has(id))
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    for (const [id] of shared) {
      if (result.length >= max) break;
      result.push(id);
    }
    return result;
  }

  /** A layer's picture bytes are its chunks concatenated in order. One missing
   * chunk leaves the layer incomplete; it is never drawn partially. */
  assemble(ids: readonly string[]): Uint8Array | null {
    let length = 0;
    for (const id of ids) {
      const bytes = this.entries.get(id);
      if (!bytes) return null;
      length += bytes.byteLength;
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const id of ids) {
      const bytes = this.touch(id)!;
      result.set(bytes, offset);
      offset += bytes.byteLength;
    }
    return result;
  }

  usage(): DesignRecordingChunksUsage {
    return { count: this.entries.size, bytes: this.bytes, budget: this.budget, ...this.counts, leased: this.leases.size };
  }

  clear(): void {
    this.entries.clear();
    this.refs.clear();
    this.bytes = 0;
  }

  private touch(id: string): Uint8Array | undefined {
    const bytes = this.entries.get(id);
    if (bytes) { this.entries.delete(id); this.entries.set(id, bytes); }
    return bytes;
  }

  trim(): void {
    if (this.bytes <= this.budget) return;
    for (const [id, bytes] of this.entries) {
      if (this.bytes <= this.budget) break;
      if (this.leases.has(id)) continue;
      this.entries.delete(id);
      this.bytes -= bytes.byteLength;
      this.counts.evicted++;
    }
  }
}

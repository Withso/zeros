import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { chunkDesignRecording, designRecordingChunkId, RECORDING_CHUNK_MAX, RECORDING_CHUNK_MIN } from "../recording-chunks";

/** Deterministic pseudo-random bytes, so cut points are reproducible. */
function bytesFrom(seed: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; out[i] = x & 0xff; }
  return out;
}
const join = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };

describe("recording chunks", () => {
  it("cuts the same bytes the same way, within size bounds, and reassembles exactly", () => {
    const bytes = bytesFrom(7, 600_000);
    const a = chunkDesignRecording(bytes), b = chunkDesignRecording(bytes);
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
    expect(join(...a.map((c) => c.bytes))).toEqual(bytes);
    for (const chunk of a.slice(0, -1)) {
      expect(chunk.bytes.length).toBeGreaterThanOrEqual(RECORDING_CHUNK_MIN);
      expect(chunk.bytes.length).toBeLessThanOrEqual(RECORDING_CHUNK_MAX);
    }
    expect(a.every((c) => c.id === designRecordingChunkId(c.bytes) && /^[a-f0-9]{32}$/.test(c.id))).toBe(true);
    // Normalized chunking keeps sizes near the average: about 75 chunks for 600 KB.
    expect(a.length).toBeGreaterThan(40);
    expect(a.length).toBeLessThan(160);
  });

  it("shares the chunks of an embedded block wherever it sits, as fonts do across a page's recordings", () => {
    const font = bytesFrom(11, 400_000);
    const first = join(bytesFrom(1, 5_000), font, bytesFrom(2, 9_000));
    const second = join(bytesFrom(3, 31_337), font, bytesFrom(4, 700));
    const ids = new Set(chunkDesignRecording(first).map((c) => c.id));
    const other = chunkDesignRecording(second);
    const sharedBytes = other.filter((c) => ids.has(c.id)).reduce((n, c) => n + c.bytes.length, 0);
    expect(sharedBytes / font.length).toBeGreaterThan(0.9);
  });

  it("resynchronizes after an insertion: later chunks are unchanged", () => {
    const tail = bytesFrom(5, 300_000);
    const before = chunkDesignRecording(join(bytesFrom(6, 20_000), tail)).map((c) => c.id);
    const after = new Set(chunkDesignRecording(join(bytesFrom(6, 20_000), randomBytes(17), tail)).map((c) => c.id));
    expect(before.slice(-20).every((id) => after.has(id))).toBe(true);
  });

  it("returns one chunk for a small recording and none for empty bytes", () => {
    expect(chunkDesignRecording(new Uint8Array(100))).toHaveLength(1);
    expect(chunkDesignRecording(new Uint8Array(0))).toHaveLength(0);
  });
});

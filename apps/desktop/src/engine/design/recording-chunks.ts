import { createHash } from "node:crypto";

// Content-defined chunking for recorded frames (FastCDC, normalized chunking,
// Xia et al. 2020). A recording embeds the full data of every font it draws
// with, identical across a page's frames; cut points chosen by content make
// those bytes produce the same chunks wherever they sit, so they are stored
// and sent once. The gear table, masks and sizes are a stored format: changing
// any of them changes chunk ids, so bump DESIGN_RECORDING_CHUNKER with them.
export const DESIGN_RECORDING_CHUNKER = "fastcdc-1";
export const RECORDING_CHUNK_MIN = 2 * 1024;
export const RECORDING_CHUNK_AVG = 8 * 1024;
export const RECORDING_CHUNK_MAX = 64 * 1024;

/** 256 fixed pseudo-random words (xorshift32 from a fixed seed). */
const GEAR = (() => {
  const table = new Uint32Array(256);
  let x = 0x9e3779b9;
  for (let i = 0; i < 256; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    table[i] = x;
  }
  return table;
})();
// A gear hash shifts left, so its high bits depend on the most recent bytes
// (bit k on the last k + 1). Masks use high bits: 15 before the average size
// (harder to cut), 11 after it (easier), which narrows the size spread.
const MASK_SMALL = 0xfffe0000 >>> 0;
const MASK_LARGE = 0xffe00000 >>> 0;

function cut(bytes: Uint8Array, start: number, end: number): number {
  const available = end - start;
  if (available <= RECORDING_CHUNK_MIN) return end;
  const max = start + Math.min(RECORDING_CHUNK_MAX, available);
  const normal = Math.min(start + RECORDING_CHUNK_AVG, max);
  let hash = 0;
  let i = start + RECORDING_CHUNK_MIN;
  for (; i < normal; i++) {
    hash = ((hash << 1) + GEAR[bytes[i]!]!) >>> 0;
    if ((hash & MASK_SMALL) === 0) return i + 1;
  }
  for (; i < max; i++) {
    hash = ((hash << 1) + GEAR[bytes[i]!]!) >>> 0;
    if ((hash & MASK_LARGE) === 0) return i + 1;
  }
  return max;
}

export function designRecordingChunkId(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 32);
}

export interface DesignRecordingChunk {
  readonly id: string;
  readonly bytes: Uint8Array;
}

/** Splits a recording into content-defined chunks, in order. */
export function chunkDesignRecording(bytes: Uint8Array): DesignRecordingChunk[] {
  const chunks: DesignRecordingChunk[] = [];
  for (let start = 0; start < bytes.length;) {
    const end = cut(bytes, start, bytes.length);
    const part = bytes.subarray(start, end);
    chunks.push({ id: designRecordingChunkId(part), bytes: part });
    start = end;
  }
  return chunks;
}

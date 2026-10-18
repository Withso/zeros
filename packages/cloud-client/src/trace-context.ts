/** W3C trace-context version 00 with non-zero trace and parent IDs. */
export const TRACEPARENT_PATTERN = /^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/;
export type TraceparentOptions = { sampled: boolean; randomBytes?: (length: number) => Uint8Array };

const defaultRandomBytes = (length: number): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(length));

function randomHex(randomBytes: (length: number) => Uint8Array, length: number): string {
  const bytes = randomBytes(length);
  if (bytes.length !== length) throw new RangeError("randomBytes returned the wrong length");
  const digits = Array.from(bytes, byte => byte.toString(16).padStart(2, "0"));
  // W3C forbids an all-zero trace or parent ID, so an all-zero draw ends in 01.
  if (bytes.every(byte => byte === 0)) digits[length - 1] = "01";
  return digits.join("");
}

export function createTraceparent(options: TraceparentOptions): string {
  const randomBytes = options.randomBytes ?? defaultRandomBytes;
  return `00-${randomHex(randomBytes, 16)}-${randomHex(randomBytes, 8)}-${options.sampled ? "01" : "00"}`;
}

// Portable base64url (Node + browser + React Native), no external deps.
// Shared by pairing offers and the E2EE channel framing.

export function bytesToBase64Url(bytes: Uint8Array): string {
  const g = globalThis as unknown as {
    btoa?: (s: string) => string;
    Buffer?: { from(b: Uint8Array): { toString(enc: string): string } };
  };
  let b64: string;
  if (typeof g.btoa === "function") {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    b64 = g.btoa(bin);
  } else if (g.Buffer) {
    b64 = g.Buffer.from(bytes).toString("base64");
  } else {
    throw new Error("No base64 encoder available in this runtime");
  }
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(s: string): Uint8Array {
  const g = globalThis as unknown as {
    atob?: (s: string) => string;
    Buffer?: { from(s: string, enc: string): { length: number; [i: number]: number } };
  };
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, "=");
  if (typeof g.atob === "function") {
    const bin = g.atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  if (g.Buffer) {
    const buf = g.Buffer.from(padded, "base64");
    const out = new Uint8Array(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = buf[i];
    return out;
  }
  throw new Error("No base64 decoder available in this runtime");
}

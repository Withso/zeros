// Small crypto + response helpers for the handoff Functions.
//
// SHA-256 is computed over a string's UTF-8 bytes and base64url-encoded the SAME
// way the desktop does (node:crypto → base64 → url-safe, no padding), so the
// handoff-PKCE challenge comparison matches across runtimes.

export function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Bytes(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return new Uint8Array(digest);
}

/** Hex SHA-256 — used to store ONLY the hash of a ticket (never the ticket). */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = await sha256Bytes(input);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** base64url SHA-256 — used to verify the handoff-PKCE challenge. */
export async function sha256B64url(input: string): Promise<string> {
  return b64url(await sha256Bytes(input));
}

export function json(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

// Opaque tokens we accept on the wire: base64url (ticket/verifier/challenge) or a
// UUID/fallback nonce — all within this charset. Bounds length to avoid abuse.
export const TOKENISH = /^[A-Za-z0-9_-]{1,512}$/;

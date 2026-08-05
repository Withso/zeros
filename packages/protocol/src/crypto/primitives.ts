// ──────────────────────────────────────────────────────────
// Crypto primitives — thin, audited wrappers over @noble
// ──────────────────────────────────────────────────────────
//
// All @noble imports are centralized here so the rest of the codebase
// depends on a stable local surface (and a version bump only touches
// this file). Pure JS — runs in Node, the browser, and React Native
// (RN needs a `crypto.getRandomValues` polyfill loaded at startup).
//
//   Identity (long-term):  Ed25519  — sign / verify
//   Key exchange (ephemeral): X25519 — ECDH
//   KDF:                   HKDF-SHA256
//   AEAD:                  ChaCha20-Poly1305
// ──────────────────────────────────────────────────────────

import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { randomBytes as nobleRandomBytes } from "@noble/hashes/utils.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { bytesToBase64Url, base64UrlToBytes } from "../b64";

export interface KeyPairBytes {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

// ── Identity (Ed25519) ──────────────────────────────────────

export function generateIdentityKeyPair(): KeyPairBytes {
  const kp = ed25519.keygen();
  return { publicKey: Uint8Array.from(kp.publicKey), secretKey: Uint8Array.from(kp.secretKey) };
}

export function identityPublicKey(secretKey: Uint8Array): Uint8Array {
  return Uint8Array.from(ed25519.getPublicKey(secretKey));
}

export function sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return Uint8Array.from(ed25519.sign(message, secretKey));
}

export function verify(sig: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    return ed25519.verify(sig, message, publicKey);
  } catch {
    return false;
  }
}

// ── Key exchange (X25519) ───────────────────────────────────

export function generateEphemeralKeyPair(): KeyPairBytes {
  const kp = x25519.keygen();
  return { publicKey: Uint8Array.from(kp.publicKey), secretKey: Uint8Array.from(kp.secretKey) };
}

export function deriveSharedSecret(ownSecret: Uint8Array, peerPublic: Uint8Array): Uint8Array {
  return Uint8Array.from(x25519.getSharedSecret(ownSecret, peerPublic));
}

// ── Hash / KDF / RNG ────────────────────────────────────────

export function sha256Hash(data: Uint8Array): Uint8Array {
  return Uint8Array.from(sha256(data));
}

export function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Uint8Array {
  return Uint8Array.from(hkdf(sha256, ikm, salt, info, length));
}

export function randomBytes(length: number): Uint8Array {
  return Uint8Array.from(nobleRandomBytes(length));
}

// ── AEAD (ChaCha20-Poly1305) ────────────────────────────────

export function aeadSeal(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  return Uint8Array.from(chacha20poly1305(key, nonce, aad).encrypt(plaintext));
}

/** Throws if authentication fails (tampering / wrong key). */
export function aeadOpen(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  return Uint8Array.from(chacha20poly1305(key, nonce, aad).decrypt(ciphertext));
}

// ── Encoding helpers ────────────────────────────────────────

export function utf8Encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function utf8Decode(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

export const toBase64 = bytesToBase64Url;
export const fromBase64 = base64UrlToBytes;

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

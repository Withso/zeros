// Short-lived, main-process-only undo state for Personal Access Token removal.
//
// The renderer receives only an opaque random handle. The credential itself
// stays in Electron main memory until the toast expires and is written back to
// safeStorage only when that exact handle is consumed.

import { randomBytes } from "node:crypto";
import type { GithubCredential } from "@zeros/protocol/github-auth";

type PatCredential = Extract<GithubCredential, { method: "pat" }>;

export interface PendingGithubPatUndo {
  id: string;
  credential: PatCredential;
  wasSelected: boolean;
  expiresAtMs: number;
}

export interface GithubPatUndoStoreOptions {
  ttlMs?: number;
  now?: () => number;
  randomId?: () => string;
}

const DEFAULT_TTL_MS = 10_000;

export class GithubPatUndoStore {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private pending: PendingGithubPatUndo | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: GithubPatUndoStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
    this.randomId =
      options.randomId ?? (() => randomBytes(24).toString("base64url"));
  }

  stash(
    credential: PatCredential,
    wasSelected: boolean,
  ): { id: string; expiresAtMs: number } {
    this.clear();
    const id = this.randomId();
    const expiresAtMs = this.now() + this.ttlMs;
    this.pending = {
      id,
      credential: { ...credential },
      wasSelected,
      expiresAtMs,
    };
    this.timer = setTimeout(() => this.clear(), this.ttlMs);
    this.timer.unref?.();
    return { id, expiresAtMs };
  }

  take(id: string): PendingGithubPatUndo | null {
    const pending = this.pending;
    if (!pending || pending.id !== id || pending.expiresAtMs <= this.now()) {
      if (pending?.expiresAtMs && pending.expiresAtMs <= this.now()) {
        this.clear();
      }
      return null;
    }
    this.pending = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    return {
      ...pending,
      credential: { ...pending.credential },
    };
  }

  /**
   * Re-arm an exact pending removal after its keychain write failed. A newer
   * removal always wins, and the original absolute expiry is preserved so a
   * failing restore cannot extend a secret's in-memory lifetime indefinitely.
   */
  restore(pending: PendingGithubPatUndo): boolean {
    const remainingMs = pending.expiresAtMs - this.now();
    if (this.pending || remainingMs <= 0) return false;
    this.pending = {
      ...pending,
      credential: { ...pending.credential },
    };
    this.timer = setTimeout(() => this.clear(), remainingMs);
    this.timer.unref?.();
    return true;
  }

  clear(): void {
    this.pending = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

// ──────────────────────────────────────────────────────────
// Encrypted secret store backed by Electron safeStorage + JSON file.
// ──────────────────────────────────────────────────────────
//
// Replaces keytar, which crashed the main process on 2026-05-24
// when its native C++ threw across the N-API boundary
// (EXC_CRASH SIGABRT in keytar.node). safeStorage uses Chromium's
// OSCrypt under the hood — battle-tested in Chrome, raises catchable
// JS errors on failure, and never abort()s the process.
//
// Storage:
//   <userData>/secrets.json
//   {
//     "<account>": "<base64-encoded encrypted blob>"
//   }
//
// File is written atomically (.tmp + rename) so a mid-write crash
// leaves the previous copy intact. Only a genuinely missing file is treated
// as empty; an unreadable or malformed whole store fails closed so a later
// read-modify-write can never erase credentials we could not parse.
// ──────────────────────────────────────────────────────────

import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";

/** The directory holding secrets.json. Shared dev login: apps/desktop/electron/main.ts sets
 *  ZEROS_SHARED_SECRETS_DIR to the channel-PRIMARY data dir (com.zeros.dev) so
 *  every dev worktree reads/writes ONE secrets.json, decrypted by the ONE
 *  per-channel keychain key (app.getName() pinned to the channel) → log in once,
 *  every worktree authed. Falls back to THIS instance's own userData for
 *  stable/beta (single instance) or a ZEROS_ISOLATE=1 dev worktree. */
function secretsDir(): string {
  const shared = process.env.ZEROS_SHARED_SECRETS_DIR?.trim();
  return shared && shared.length > 0 ? shared : app.getPath("userData");
}

function filePath(): string {
  return path.join(secretsDir(), "secrets.json");
}

export class SecretStoreReadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SecretStoreReadError";
  }
}

/** Absolute path to the on-disk secret store (`<userData>/secrets.json`).
 *  Exported so the engine sidecar can pass it to the child engine — which
 *  can't call Electron safeStorage — via the ZEROS_SECRETS_FILE env var,
 *  for exists-only `secret-account` auth probes. The engine only checks
 *  key-presence; it never reads or decrypts the stored values. */
export function secretsFilePath(): string {
  return filePath();
}

function readAll(): Record<string, string> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    console.warn(`[secret-store] read failed: ${(err as Error).message}`);
    throw new SecretStoreReadError("Encrypted secret store is unreadable", {
      cause: err,
    });
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("secrets.json must be an object");
    }
    const data = Object.create(null) as Record<string, string>;
    for (const [account, encrypted] of Object.entries(parsed)) {
      if (typeof encrypted !== "string" || encrypted.length === 0) {
        throw new Error(
          `secrets.json entry for ${JSON.stringify(account)} is invalid`,
        );
      }
      data[account] = encrypted;
    }
    return data;
  } catch (err) {
    console.warn(
      `[secret-store] secrets.json malformed: ${(err as Error).message}`,
    );
    throw new SecretStoreReadError("Encrypted secret store is malformed", {
      cause: err,
    });
  }
}

function writeAll(data: Record<string, string>): void {
  const file = filePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Per-pid tmp so two worktrees flushing at once don't collide on the tmp name;
  // the rename is atomic so a reader always sees a complete file.
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Cross-process advisory lock around the secrets file. Multiple dev worktrees
 *  now share ONE secrets.json (ZEROS_SHARED_SECRETS_DIR), so a naive
 *  read-modify-write would last-writer-wins CLOBBER a sibling's just-written key
 *  (both do readAll → mutate → atomic rename of the WHOLE file). Serialize
 *  mutations with an O_EXCL lockfile; steal a stale lock after a bound so a
 *  crashed writer can't wedge every instance. Synchronous — mutations are rare
 *  (login only) and brief. */
function withSecretsLock<T>(fn: () => T): T {
  const lock = `${filePath()}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  const start = Date.now();
  const STALE_MS = 5000;
  let held = false;
  while (!held) {
    try {
      fs.closeSync(fs.openSync(lock, "wx")); // O_CREAT|O_EXCL — fails if held
      held = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let stale = false;
      try {
        stale = Date.now() - fs.statSync(lock).mtimeMs > STALE_MS;
      } catch {
        stale = true; // lock vanished between open + stat → retry now
      }
      if (stale) {
        try {
          fs.rmSync(lock, { force: true });
        } catch {
          /* raced with another stealer — retry */
        }
        continue;
      }
      if (Date.now() - start > STALE_MS) {
        // Never perform a whole-file read/modify/write without the lock. With
        // shared dev worktrees, "best effort" here means silently deleting a
        // sibling process's newly-written credential.
        throw new Error(
          "timed out waiting for the encrypted secret-store lock",
        );
      }
      Atomics.wait(waiter, 0, 0, 25); // sleep ~25ms with no CPU spin
    }
  }
  try {
    return fn();
  } finally {
    if (held) {
      try {
        fs.rmSync(lock, { force: true });
      } catch {
        /* best-effort unlock */
      }
    }
  }
}

function ensureEncryptionAvailable(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      "OS keystore unavailable — cannot encrypt secrets. " +
        "On macOS this usually means Keychain access was denied.",
    );
  }
}

export function setSecret(account: string, value: string): void {
  ensureEncryptionAvailable();
  const encrypted = safeStorage.encryptString(value).toString("base64");
  // Re-read UNDER the lock so a sibling worktree's concurrently-written keys
  // survive this write (merge, not clobber).
  withSecretsLock(() => {
    const data = readAll();
    data[account] = encrypted;
    writeAll(data);
  });
}

export function getSecret(account: string): string | null {
  const data = readAll();
  const b64 = data[account];
  if (typeof b64 !== "string" || b64.length === 0) return null;
  try {
    return safeStorage.decryptString(Buffer.from(b64, "base64"));
  } catch (err) {
    console.warn(
      `[secret-store] decrypt failed for "${account}": ${(err as Error).message}`,
    );
    return null;
  }
}

/** Whether an entry EXISTS for `account` — key presence only, never decrypts.
 *  Lets a caller distinguish "never stored" (getSecret null, hasSecret false)
 *  from "stored but unreadable" (getSecret null after a decrypt failure,
 *  hasSecret true) — the case a read-modify-write editor must treat as an
 *  error, not an empty value. */
export function hasSecret(account: string): boolean {
  const b64 = readAll()[account];
  return typeof b64 === "string" && b64.length > 0;
}

export function deleteSecret(account: string): void {
  withSecretsLock(() => {
    const data = readAll();
    if (!(account in data)) return;
    delete data[account];
    writeAll(data);
  });
}

/** Atomically replace one decrypted value when it still equals the caller's
 *  snapshot. GitHub refresh-token rotation uses this as a cross-process CAS:
 *  a sibling dev worktree that already installed a rotated pair must never be
 *  overwritten (or deleted after another caller receives a stale-token 401). */
export function replaceSecretIfUnchanged(
  account: string,
  expectedValue: string,
  nextValue: string | null,
): boolean {
  ensureEncryptionAvailable();
  return withSecretsLock(() => {
    const data = readAll();
    const currentEncrypted = data[account];
    if (typeof currentEncrypted !== "string" || currentEncrypted.length === 0) {
      return false;
    }
    let current: string;
    try {
      current = safeStorage.decryptString(
        Buffer.from(currentEncrypted, "base64"),
      );
    } catch {
      return false;
    }
    if (current !== expectedValue) return false;
    if (nextValue === null) {
      delete data[account];
    } else {
      data[account] = safeStorage.encryptString(nextValue).toString("base64");
    }
    writeAll(data);
    return true;
  });
}

/** Number of stored entries. Useful for diagnostics and tests. */
export function entryCount(): number {
  return Object.keys(readAll()).length;
}

/** Watch the (possibly shared) secrets.json and invoke `onChange` — debounced —
 *  whenever it's rewritten. Dev worktrees share ONE secrets.json
 *  (ZEROS_SHARED_SECRETS_DIR), so a sign-in / sign-out / token refresh in ANOTHER
 *  worktree replaces this file; apps/desktop/electron/main.ts forwards the signal to the
 *  renderer ("auth-store-changed") so it can re-sync the session live instead of
 *  waiting for a reload.
 *
 *  Watches the DIRECTORY, not the file: writeAll() replaces the file via atomic
 *  tmp + rename, which swaps the inode and would silently kill a file-level watch
 *  after the first write. We filter dir events down to "secrets.json" so the
 *  `.tmp-<pid>` and `.lock` siblings (touched on every mutation) don't fire it.
 *  Returns a disposer; never throws (a failed watch just disables live sync). */
export function watchSecrets(
  onChange: (changedAccounts: readonly string[]) => void,
): () => void {
  const file = filePath();
  const dir = path.dirname(file);
  const base = path.basename(file); // "secrets.json"
  let previous: Record<string, string>;
  try {
    previous = readAll();
  } catch (err) {
    // Keep watching so a repaired shared file can still notify this process,
    // but never pretend its unreadable contents were an empty store.
    previous = {};
    console.warn(
      `[secret-store] initial watch read failed: ${(err as Error).message}`,
    );
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watcher: fs.FSWatcher | null = null;
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      let next: Record<string, string>;
      try {
        next = readAll();
      } catch (err) {
        console.warn(
          `[secret-store] watch read failed: ${(err as Error).message}`,
        );
        return;
      }
      try {
        const changedAccounts = new Set([
          ...Object.keys(previous),
          ...Object.keys(next),
        ]);
        for (const account of changedAccounts) {
          if (previous[account] === next[account]) {
            changedAccounts.delete(account);
          }
        }
        previous = next;
        if (changedAccounts.size > 0) {
          onChange([...changedAccounts]);
        }
      } catch (err) {
        console.warn(
          `[secret-store] watch onChange threw: ${(err as Error).message}`,
        );
      }
    }, 200);
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    watcher = fs.watch(dir, (_event, filename) => {
      // Some platforms hand back a null filename — fire conservatively then.
      if (!filename || filename === base) fire();
    });
  } catch (err) {
    console.warn(
      `[secret-store] cannot watch ${dir} for live login sync: ${(err as Error).message}`,
    );
  }
  return () => {
    if (timer) clearTimeout(timer);
    try {
      watcher?.close();
    } catch {
      /* already closed */
    }
  };
}

import {
  createSecretIfAbsent,
  getSecret,
  replaceSecretIfUnchanged,
  watchSecrets,
} from "./secret-store";
import type { WorkOSDesktopAuthorizationCallback } from "./workos-desktop-flow";

const KEY = "auth-workos:dev-callbacks";
const STATE = /^zeros-dev\.[A-Za-z0-9_-]{43}$/;
const MAX_PENDING = 8;
const MAX_LIFETIME_MS = 10 * 60_000;

interface PendingCallback {
  state: string;
  expiresAt: number;
  callback: WorkOSDesktopAuthorizationCallback | null;
}

interface RelayStore {
  read: typeof getSecret;
  create: typeof createSecretIfAbsent;
  replace: typeof replaceSecretIfUnchanged;
  watch: typeof watchSecrets;
}

/** Accept only Dev state with a bounded code or the fixed provider-error tag. */
function validCallback(value: WorkOSDesktopAuthorizationCallback): boolean {
  return (
    STATE.test(value.state) &&
    ((typeof value.code === "string" &&
      value.code.length > 0 &&
      value.code.length <= 8_192 &&
      !value.error) ||
      (!value.code && value.error === "provider_error"))
  );
}

/** macOS may deliver zeros-dev:// to any running worktree. Relay only a
 * matching, short-lived callback through the shared encrypted store. The PKCE
 * verifier and token exchange stay in the initiating Electron main process. */
export class WorkOSDevCallbackRelay {
  /** Use the encrypted shared store in production; store and clock injection
   * let tests exercise races and expiry without native credential access. */
  constructor(
    private readonly store: RelayStore = {
      read: getSecret,
      create: createSecretIfAbsent,
      replace: replaceSecretIfUnchanged,
      watch: watchSecrets,
    },
    private readonly now: () => number = Date.now,
  ) {}

  /** Recover malformed v1 routing data while retaining valid sibling entries.
   * Unknown newer schemas throw so update cannot downgrade or erase them. */
  private entries(raw: string | null): PendingCallback[] {
    if (raw === null) return [];
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // This is disposable routing data, not a session. Recover only through
      // update's CAS so a sibling's valid replacement is never overwritten.
      return [];
    }
    if (Number.isInteger(parsed?.version) && parsed.version > 1) {
      // An unchanged newer record is not corruption. Older worktrees cannot
      // safely interpret or downgrade it, even while holding the CAS lock.
      throw new Error(
        "Pending Dev sign-in data requires a newer version; update this checkout",
      );
    }
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) return [];
    // Bound registrations made by this version, not valid sibling records:
    // another version may allow more attempts or a longer browser deadline.
    // Drop corrupt individual entries without discarding their valid siblings.
    return parsed.entries.filter(
      (entry: PendingCallback) =>
        entry &&
        typeof entry.state === "string" &&
        STATE.test(entry.state) &&
        Number.isFinite(entry.expiresAt) &&
        entry.expiresAt > this.now() &&
        (entry.callback === null ||
          (entry.callback &&
            validCallback(entry.callback) &&
            entry.callback.state === entry.state)),
    );
  }

  /** Reapply a pure change against the latest value until CAS succeeds, with
   * bounded retries that preserve concurrent writes from other worktrees. */
  private update<T>(
    change: (entries: PendingCallback[]) => {
      entries: PendingCallback[];
      result: T;
    },
  ): T {
    for (let attempt = 0; attempt < 8; attempt++) {
      const raw = this.store.read(KEY);
      const next = change(this.entries(raw));
      const serialized = JSON.stringify({ version: 1, entries: next.entries });
      if (serialized === raw || (raw === null && next.entries.length === 0))
        return next.result;
      if (
        raw === null
          ? this.store.create(KEY, serialized)
          : this.store.replace(KEY, raw, serialized)
      )
        return next.result;
    }
    throw new Error("Pending Dev sign-in store is busy");
  }

  /** Register one expiring browser attempt and watch for its callback. Returns
   * an idempotent disposer that removes only this attempt's routing state. */
  register(
    state: string,
    expiresAt: number,
    accept: (callback: WorkOSDesktopAuthorizationCallback) => boolean,
  ): () => void {
    if (
      !STATE.test(state) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= this.now() ||
      expiresAt > this.now() + MAX_LIFETIME_MS
    ) {
      throw new Error("Invalid pending Dev sign-in");
    }
    this.update((entries) => {
      if (
        entries.length >= MAX_PENDING ||
        entries.some((entry) => entry.state === state)
      ) {
        throw new Error(
          "Too many pending Dev sign-ins; cancel an existing attempt and retry",
        );
      }
      return {
        entries: [...entries, { state, expiresAt, callback: null }],
        result: undefined,
      };
    });
    let closed = false;
    let stopWatch: () => void = () => undefined;
    /** Stop active observers before best-effort removal of this attempt. */
    const dispose = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      stopWatch();
      try {
        this.update((entries) => ({
          entries: entries.filter((entry) => entry.state !== state),
          result: undefined,
        }));
      } catch {
        // Expiry bounds a leftover callback if the OS credential store fails.
      }
    };
    /** Consume a delivered callback atomically so a replay cannot reach accept. */
    const check = () => {
      if (closed) return;
      if (this.now() >= expiresAt) {
        dispose();
        return;
      }
      try {
        const callback = this.update((entries) => {
          const current = entries.find((entry) => entry.state === state);
          return {
            entries: current?.callback
              ? entries.filter((entry) => entry.state !== state)
              : entries,
            result: current?.callback ?? null,
          };
        });
        if (callback) {
          dispose();
          accept(callback);
        }
      } catch {
        // A transient credential-store failure keeps the bounded attempt alive.
      }
    };
    // File notifications can coalesce or be unavailable. Poll only while a
    // browser ceremony is active, never for a normal signed-in Dev session.
    const timer = setInterval(check, 1_000);
    timer.unref?.();
    stopWatch = this.store.watch((keys) => {
      if (keys.includes(KEY)) check();
    });
    check();
    return dispose;
  }

  /** Publish a matching callback once, returning false for unknown, expired,
   * replayed, incompatible, or temporarily inaccessible routing state. */
  deliver(input: WorkOSDesktopAuthorizationCallback): boolean {
    if (!validCallback(input)) return false;
    const callback = input.code
      ? { state: input.state, code: input.code }
      : { state: input.state, error: "provider_error" };
    try {
      return this.update((entries) => {
        const pending = entries.find((entry) => entry.state === input.state);
        if (!pending || pending.callback) return { entries, result: false };
        return {
          entries: entries.map((entry) =>
            entry === pending ? { ...entry, callback } : entry,
          ),
          result: true,
        };
      });
    } catch {
      return false;
    }
  }
}

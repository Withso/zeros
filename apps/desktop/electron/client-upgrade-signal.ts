/** Hands a control-plane "upgrade required" answer to the updater without
 * making every control-plane request path depend on the updater (and its
 * Electron updater/network/power modules). The updater registers at load;
 * answers that arrive earlier are kept, newest last, and delivered then. */
type Handler = (value: unknown) => void;
const MAX_PENDING = 8;
let handler: Handler | null = null;
const pending: unknown[] = [];

export function signalClientUpgrade(value: unknown): void {
  if (handler) return handler(value);
  pending.push(value);
  if (pending.length > MAX_PENDING) pending.shift();
}

export function onClientUpgrade(next: Handler): void {
  handler = next;
  for (const value of pending.splice(0)) {
    try { next(value); } catch { /* an invalid early answer must not block later ones */ }
  }
}

/** A durable outbox of edited TOML leaves. Browser values are synchronous
 * caches; only an engine acknowledgement retires a pending edit. */
export interface AgentPreferenceEdit {
  path: string[];
  value: unknown;
  version: number;
}
const OUTBOX = "zeros-agent-preferences-pending-v1";
const pending = new Map<string, AgentPreferenceEdit>();
const listeners = new Set<() => void>();
let version = 0;
let flush: (() => Promise<void>) | undefined;
export function registerAgentPreferencesFlush(
  callback: () => Promise<void>,
): () => void {
  flush = callback;
  return () => {
    if (flush === callback) flush = undefined;
  };
}
export async function flushAgentPreferences(): Promise<void> {
  if (!flush)
    throw new Error(
      "Agent settings are still connecting. Try again once the local engine is ready.",
    );
  await flush();
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const safePath = (segments: unknown): segments is string[] =>
  Array.isArray(segments) &&
  segments.length >= 2 &&
  segments.length <= 3 &&
  ["models", "providers"].includes(segments[0]) &&
  segments.every(
    (segment) =>
      typeof segment === "string" &&
      segment.length > 0 &&
      segment.length <= 128 &&
      !["__proto__", "constructor", "prototype"].includes(segment),
  );
try {
  const saved: unknown = JSON.parse(localStorage.getItem(OUTBOX) ?? "[]");
  if (Array.isArray(saved))
    for (const entry of saved.slice(0, 512)) {
      if (safePath(entry?.path) && entry.value !== undefined)
        pending.set(JSON.stringify(entry.path), {
          path: entry.path,
          value: entry.value,
          version: ++version,
        });
    }
} catch {
  /* no persisted outbox */
}
function persist(): void {
  try {
    localStorage.setItem(OUTBOX, JSON.stringify([...pending.values()]));
  } catch {
    /* retain memory outbox; the sync surface reports failed engine saves */
  }
}
export function pendingAgentPreferences(): Map<string, AgentPreferenceEdit> {
  return new Map(pending);
}
export function onPendingAgentPreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function queueAgentPreferenceChanges(
  next: Record<string, unknown>,
  previous: Record<string, unknown> = {},
): void {
  let changed = false;
  const visit = (value: unknown, before: unknown, segments: string[]) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value))
        visit(child, object(before)[key], [...segments, key]);
    } else if (
      safePath(segments) &&
      JSON.stringify(value) !== JSON.stringify(before)
    ) {
      pending.set(JSON.stringify(segments), {
        path: segments,
        value: value ?? null,
        version: ++version,
      });
      changed = true;
    }
  };
  visit(next, previous, []);
  if (!changed) return;
  persist();
  for (const listener of listeners) listener();
}
export function acceptAgentPreferences(
  doc: Record<string, unknown>,
  sent: Map<string, AgentPreferenceEdit>,
): Record<string, unknown> {
  for (const [key, entry] of sent)
    if (pending.get(key)?.version === entry.version) pending.delete(key);
  persist();
  const result = structuredClone(doc);
  for (const { path, value } of pending.values()) {
    let target = result;
    for (const segment of path.slice(0, -1)) {
      target[segment] = object(target[segment]);
      target = target[segment] as Record<string, unknown>;
    }
    const leaf = path[path.length - 1];
    if (value === null) delete target[leaf];
    else target[leaf] = value;
  }
  return result;
}

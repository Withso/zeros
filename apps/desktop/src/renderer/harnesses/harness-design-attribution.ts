// Diagnostic wrappers for ?attributeContinuity. Never imported by the app.
// Wrapping named actions (not only the public Zustand setState) also sees the
// initializer's private `set` closure. Publications and scheduling are distinct:
// an action that bails out is not counted as a store publication.

interface AttributionSink {
  run<T>(kind: string, name: string, detail: unknown, work: () => T): T;
  record(kind: string, name: string, detail?: unknown): void;
  registerSubscription(name: string, subscribe: unknown): void;
}

type UnknownRecord = Record<string, unknown>;
type Store = {
  getState(): UnknownRecord;
  setState(...args: unknown[]): void;
  subscribe(listener: (state: UnknownRecord, previous: UnknownRecord) => void): () => void;
};

const changes = (next: unknown, previous: unknown, prefix = "", depth = 0): string[] => {
  if (Object.is(next, previous)) return [];
  if (!next || !previous || typeof next !== "object" || typeof previous !== "object" || depth >= 4 ||
      Array.isArray(next) || Array.isArray(previous)) return [prefix];
  const a = next as UnknownRecord, b = previous as UnknownRecord;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter(key => typeof a[key] !== "function" && key !== "updatedAt")
    .flatMap(key => changes(a[key], b[key], prefix ? `${prefix}.${key}` : key, depth + 1)).slice(0, 48);
};

const brief = (value: unknown): unknown => {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length > 160 ? `${value.slice(0, 160)}…` : value;
  if (typeof value === "function") return "callback";
  if (!value || typeof value !== "object") return typeof value;
  const record = value as UnknownRecord;
  return Object.fromEntries(["workspaceId", "frame", "file", "nodeId", "oid", "sourceVersion", "active", "owner"]
    .filter(key => key in record).map(key => [key, brief(record[key])]));
};

export function installDesignAttribution(input: {
  stores: Record<string, unknown>;
  caches: Record<string, unknown>;
  previews: unknown;
  hiddenDocuments: unknown;
  subscribeIntent(listener: () => void): () => void;
}): () => void {
  const sink = (window as Window & { __zerosDesignAttribution?: AttributionSink }).__zerosDesignAttribution;
  if (!sink) throw new Error("Attribution requires the continuity runner's profiling probe.");
  const cleanups: Array<() => void> = [];
  const method = (target: unknown, key: string, name: string, detail: (...args: unknown[]) => unknown) => {
    const object = target as Record<string, (...args: unknown[]) => unknown>;
    const original = object[key];
    if (typeof original !== "function") throw new Error(`Attribution method unavailable: ${name}`);
    object[key] = function (...args: unknown[]) {
      return sink.run("publication", name, detail(...args), () => original.apply(this, args));
    };
    cleanups.push(() => { object[key] = original; });
  };
  for (const [name, candidate] of Object.entries(input.stores)) {
    const store = candidate as Store;
    sink.registerSubscription(`${name}.subscribe`, store.subscribe);
    const originals: UnknownRecord = {};
    const wrapped: UnknownRecord = {};
    for (const [action, original] of Object.entries(store.getState())) {
      if (typeof original !== "function") continue;
      originals[action] = original;
      wrapped[action] = function (...args: unknown[]) {
        return sink.run("action", `${name}.${action}`, args.slice(0, 6).map(brief), () => original(...args));
      };
    }
    store.setState(wrapped);
    cleanups.push(() => store.setState(originals));
    cleanups.push(store.subscribe((next, previous) => sink.record("publication", name, { changed: changes(next, previous) })));
    const originalSet = store.setState;
    store.setState = (...args) => sink.run("action", `${name}.setState`, args.map(brief), () => originalSet(...args));
    cleanups.push(() => { store.setState = originalSet; });
  }
  for (const [name, cache] of Object.entries(input.caches)) {
    // Exact actual fan-out, including async load completions that did not pass
    // through public setData. This private method is deliberately fixture-only.
    method(cache, "replaceSnapshot", `${name}.replaceSnapshot`, (key, entry, next) => ({
      key: brief(key), changed: changes(next, (entry as { snapshot: unknown }).snapshot),
    }));
  }
  method(input.previews, "changed", "previews.changed", key => ({ key: brief(key) }));
  // The global preview notification is deferred; record that later fan-out
  // separately rather than crediting it to the earlier picture insertion.
  const previews = input.previews as { subscribeChanges(listener: () => void): () => void };
  cleanups.push(previews.subscribeChanges(() => sink.record("publication", "previews.subscribeChanges")));
  const hidden = input.hiddenDocuments as { subscribe(listener: () => void): () => void };
  sink.registerSubscription("hiddenDocuments.subscribe", hidden.subscribe);
  sink.registerSubscription("frameIntent.subscribe", input.subscribeIntent);
  cleanups.push(hidden.subscribe(() => sink.record("publication", "hiddenDocuments.reconcile")));
  cleanups.push(input.subscribeIntent(() => sink.record("publication", "frameIntent.publish")));
  return () => { for (const cleanup of cleanups.reverse()) cleanup(); };
}

import {
  isLoopbackHost,
  normalizeBrowserUrl,
} from "../workbench/tabs/localhost-url";

export interface RunPreviewTarget {
  folderKey: string;
  workspaceId: string;
  sessionId: string;
  startedAt: number | null;
}

// Only complete terminal lines qualify: a split write must not publish a
// half-written port. Strip terminal styling and OSC links before URL parsing.
export function findRunPreviewUrl(output: string): string | null {
  const complete = output.slice(
    0,
    Math.max(output.lastIndexOf("\n"), output.lastIndexOf("\r")) + 1,
  );
  if (!/https?:\/\//i.test(complete)) return null;
  const plain = complete.replace(
    // Terminal escape sequences are the input being parsed here.
    // eslint-disable-next-line no-control-regex
    /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g,
    "",
  );
  let found: string | null = null;
  // A control byte terminates a terminal URL rather than becoming part of it.
  // eslint-disable-next-line no-control-regex
  for (const match of plain.matchAll(/https?:\/\/[^\s<>"'\x00-\x20]+/gi)) {
    const normalized = normalizeBrowserUrl(match[0].replace(/[),.;]+$/, ""));
    if (!normalized) continue;
    const url = new URL(normalized);
    if (url.hostname === "0.0.0.0" || url.hostname === "[::]")
      url.hostname = "localhost";
    if (isLoopbackHost(url.hostname)) found = url.href;
  }
  return found;
}

interface PreviewEntry {
  target: RunPreviewTarget;
  tail: string;
  url: string | null;
  revision: number;
  addressRevision: number;
  readEpoch: number;
  pendingEpoch?: number;
  pending?: Promise<void>;
}

/** Ephemeral, bounded exact-run state. Output without an address change never
 * notifies React. Snapshots share requests and cannot overwrite newer output. */
export class RunPreviewCache {
  private entries = new Map<string, PreviewEntry>();
  private listeners = new Set<() => void>();
  private version = 0;
  constructor(private readonly maximum = 128) {}

  private key(target: RunPreviewTarget) {
    return JSON.stringify([
      target.folderKey,
      target.workspaceId,
      target.sessionId,
      target.startedAt,
    ]);
  }
  private entry(target: RunPreviewTarget) {
    const key = this.key(target);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        target,
        tail: "",
        url: null,
        revision: 0,
        addressRevision: 0,
        readEpoch: 0,
      };
      this.entries.set(key, entry);
      while (this.entries.size > this.maximum) {
        const oldest = this.entries.keys().next().value!;
        const removed = this.entries.get(oldest);
        this.entries.delete(oldest);
        if (removed?.url) this.changed();
      }
    }
    return entry;
  }
  private changed() {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
  private publish(entry: PreviewEntry, url: string | null) {
    if (!url || url === entry.url) return;
    entry.url = url;
    this.changed();
  }
  getVersion = () => this.version;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  peek(target: RunPreviewTarget) {
    return this.entries.get(this.key(target))?.url ?? null;
  }
  append(target: RunPreviewTarget, chunk: string) {
    const entry = this.entry(target);
    entry.revision += 1;
    const text = entry.tail + chunk;
    const address = findRunPreviewUrl(text);
    if (address) entry.addressRevision += 1;
    this.publish(entry, address);
    const end = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
    entry.tail = text.slice(end + 1).slice(-8192);
  }
  warm(
    target: RunPreviewTarget,
    fetch: () => Promise<{ log: string }>,
  ): Promise<void> {
    const entry = this.entry(target);
    const epoch = entry.readEpoch;
    if (entry.pending) {
      if (entry.pendingEpoch === epoch) return entry.pending;
      // Returning after an inactive interval needs one read newer than any
      // old in-flight snapshot. A later hide or owner removal cancels it.
      return entry.pending.then(() => {
        if (
          this.entries.get(this.key(target)) === entry &&
          entry.readEpoch === epoch
        )
          return this.warm(target, fetch);
      });
    }
    const revision = entry.revision;
    const addressRevision = entry.addressRevision;
    entry.pendingEpoch = epoch;
    const request = fetch()
      .then(({ log }) => {
        if (
          this.entries.get(this.key(target)) !== entry ||
          entry.readEpoch !== epoch
        )
          return;
        if (entry.addressRevision === addressRevision)
          this.publish(entry, findRunPreviewUrl(log));
        if (entry.revision === revision) {
          const end = Math.max(log.lastIndexOf("\n"), log.lastIndexOf("\r"));
          entry.tail = log.slice(end + 1).slice(-8192);
        }
      })
      .catch(() => {
        // Keep the last confirmed exact-run address on a transient read failure.
      })
      .finally(() => {
        if (entry.pending === request) entry.pending = undefined;
      });
    entry.pending = request;
    return request;
  }
  /** Inactive surfaces cannot observe output; their in-flight reads no longer
   * answer a later activation. Keep the last confirmed URL until revalidated. */
  invalidate(target: RunPreviewTarget) {
    const entry = this.entries.get(this.key(target));
    if (entry) entry.readEpoch += 1;
  }
  clearFolders(removed: (folder: string) => boolean) {
    let changed = false;
    for (const [key, entry] of this.entries) {
      if (!removed(entry.target.folderKey)) continue;
      this.entries.delete(key);
      changed ||= entry.url !== null;
    }
    if (changed) this.changed();
  }
}

export const runPreviewCache = new RunPreviewCache();

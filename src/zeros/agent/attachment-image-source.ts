// ──────────────────────────────────────────────────────────
// Disk-backed transcript image sources
// ──────────────────────────────────────────────────────────
//
// Persisted messages carry only a workspace-relative attachment path. Visible
// pills acquire a short-lived blob URL here; exact-key consumers share one
// bounded read, and the URL is revoked when the final mounted consumer leaves.
// Full-resolution base64 is therefore transient bridge data, never transcript
// state. Legacy transcript data URLs are returned directly for compatibility.
// ──────────────────────────────────────────────────────────

import { useEffect, useState } from "react";

import { readWorkspaceFile } from "@/native/files";
import { isAgentAttachmentDiskPath } from "./agent-history-client";

export interface AttachmentImageLease {
  source: Promise<string | null>;
  release(): void;
}

interface CacheEntry {
  refs: number;
  settled: boolean;
  value: string | null;
  source: Promise<string | null>;
}

type SourceLoader = (cwd: string, diskPath: string) => Promise<string | null>;
type SourceReleaser = (source: string) => void;

export class AttachmentImageSourceCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly load: SourceLoader,
    private readonly revoke: SourceReleaser,
  ) {}

  acquire(cwd: string, diskPath: string): AttachmentImageLease {
    const key = `${cwd}\u0000${diskPath}`;
    let entry = this.entries.get(key);
    if (!entry) {
      const created: CacheEntry = {
        refs: 0,
        settled: false,
        value: null,
        source: Promise.resolve(null),
      };
      created.source = this.load(cwd, diskPath)
        .catch(() => null)
        .then((source) => {
          created.settled = true;
          created.value = source;
          if (created.refs === 0 && this.entries.get(key) === created) {
            this.entries.delete(key);
            if (source) this.revoke(source);
          }
          return source;
        });
      entry = created;
      this.entries.set(key, created);
    }
    entry.refs += 1;
    let released = false;
    return {
      source: entry.source,
      release: () => {
        if (released) return;
        released = true;
        entry!.refs = Math.max(0, entry!.refs - 1);
        if (
          entry!.refs === 0 &&
          entry!.settled &&
          this.entries.get(key) === entry
        ) {
          this.entries.delete(key);
          if (entry!.value) this.revoke(entry!.value);
        }
      },
    };
  }
}

function dataUrlToBlobUrl(dataUrl: string): string | null {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match || typeof URL.createObjectURL !== "function") return null;
  const decoded = atob(match[2]);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i += 1) {
    bytes[i] = decoded.charCodeAt(i);
  }
  return URL.createObjectURL(new Blob([bytes], { type: match[1] }));
}

async function loadDiskImageSource(
  cwd: string,
  diskPath: string,
): Promise<string | null> {
  if (!cwd || !isAgentAttachmentDiskPath(diskPath)) return null;
  const result = await readWorkspaceFile(cwd, diskPath);
  if (result?.kind !== "image" || !result.dataUrl) return null;
  return dataUrlToBlobUrl(result.dataUrl);
}

const attachmentImageSources = new AttachmentImageSourceCache(
  loadDiskImageSource,
  (source) => URL.revokeObjectURL(source),
);

export function useAttachmentImageSource(args: {
  cwd?: string | null;
  diskPath?: string;
  legacyUri?: string;
  /** Hidden retained chat surfaces stay mounted. Disable their reads so the
   *  twelve-view deck does not pin full-resolution blobs for invisible chats. */
  enabled?: boolean;
}): string | null {
  const { cwd, diskPath, legacyUri, enabled = true } = args;
  const [source, setSource] = useState<string | null>(
    enabled ? (legacyUri ?? null) : null,
  );

  useEffect(() => {
    if (!enabled) {
      setSource(null);
      return;
    }
    if (legacyUri) {
      setSource(legacyUri);
      return;
    }
    if (!cwd || !diskPath) {
      setSource(null);
      return;
    }
    const lease = attachmentImageSources.acquire(cwd, diskPath);
    let live = true;
    setSource(null);
    void lease.source.then((next) => {
      if (live) setSource(next);
    });
    return () => {
      live = false;
      lease.release();
    };
  }, [cwd, diskPath, legacyUri, enabled]);

  return source;
}

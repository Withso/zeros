// ──────────────────────────────────────────────────────────
// Legacy transcript image externalization
// ──────────────────────────────────────────────────────────
//
// Two layouts predate the context graph: full data URLs in transcript JSON and
// disk references under `.context/attachments/<chat>/`. Window reads migrate
// only the rows being opened: copy each unique image once into the workspace
// graph, replace both transcript copies with the same stable record id/path,
// and upsert the compact payload. A failed copy leaves the old reference intact
// so the chat remains viewable/editable.
// ──────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import path from "node:path";

import type { PersistedMessage } from "../db/messages";
import { upsertChatMessagesBulk } from "../db/messages";
import { stageContextGraphAttachment } from "./context-graph";
import { readWorkspaceFile } from "./read-file";

interface LegacyImageRef {
  name?: unknown;
  mimeType?: unknown;
  kind?: unknown;
  type?: unknown;
  thumbnailUri?: unknown;
  diskPath?: unknown;
  attachmentId?: unknown;
}

interface MigratedImage {
  diskPath: string;
  attachmentId: string;
}

const ID_OK = /^[a-zA-Z0-9_-]{1,128}$/;
const CONTEXT_GRAPH_PATH =
  /^\.context-graph\/(?:local|shared)\/attachments\/([a-zA-Z0-9_-]{1,128})\/[a-zA-Z0-9._-]+$/;
const LEGACY_DISK_PATH =
  /^\.context\/attachments\/[a-zA-Z0-9_-]{1,128}\/[a-zA-Z0-9._-]+$/;

/** Cheap raw-payload gate shared with the window handlers. */
export function payloadNeedsLegacyImageMigration(payload: string): boolean {
  return (
    (payload.includes('"thumbnailUri"') && payload.includes("data:image/")) ||
    payload.includes(".context/attachments/")
  );
}

function dataUrlParts(
  value: unknown,
): { mimeType: string; base64: string } | null {
  if (typeof value !== "string") return null;
  const match = /^data:([^;]+);base64,(.+)$/.exec(value);
  if (!match || !match[1].startsWith("image/")) return null;
  return { mimeType: match[1], base64: match[2] };
}

function imageRefs(message: Record<string, unknown>): LegacyImageRef[] {
  const refs: LegacyImageRef[] = [];
  if (Array.isArray(message.attachments)) {
    for (const value of message.attachments) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const ref = value as LegacyImageRef;
        if (ref.kind === "image") refs.push(ref);
      }
    }
  }
  if (Array.isArray(message.segments)) {
    for (const value of message.segments) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const ref = value as LegacyImageRef;
        if (ref.type === "attachment" && ref.kind === "image") refs.push(ref);
      }
    }
  }
  return refs;
}

/** Externalize legacy image data in a transcript window and persist successful
 * rewrites. Rows without legacy images retain their original references. */
export async function externalizeLegacyMessageImages(args: {
  cwd: string;
  chatId: string;
  rows: PersistedMessage[];
}): Promise<PersistedMessage[]> {
  if (!path.isAbsolute(args.cwd) || args.rows.length === 0) return args.rows;
  const changedRows: PersistedMessage[] = [];
  const result: PersistedMessage[] = [];

  for (const row of args.rows) {
    // The common path is every newly-written message. Avoid JSON.parse over
    // large tool payloads unless the raw row can actually contain a legacy
    // image URI.
    if (!payloadNeedsLegacyImageMigration(row.payload)) {
      result.push(row);
      continue;
    }
    let message: Record<string, unknown>;
    try {
      const parsed = JSON.parse(row.payload) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        result.push(row);
        continue;
      }
      message = parsed as Record<string, unknown>;
    } catch {
      result.push(row);
      continue;
    }

    const refs = imageRefs(message);
    const writes = new Map<string, Promise<MigratedImage | null>>();
    let changed = false;
    for (const ref of refs) {
      const currentGraph =
        typeof ref.diskPath === "string"
          ? CONTEXT_GRAPH_PATH.exec(ref.diskPath)
          : null;
      if (currentGraph) {
        if (ref.attachmentId !== currentGraph[1]) {
          ref.attachmentId = currentGraph[1];
          changed = true;
        }
        if (dataUrlParts(ref.thumbnailUri)) {
          delete ref.thumbnailUri;
          changed = true;
        }
        continue;
      }

      const legacyDiskPath =
        typeof ref.diskPath === "string" && LEGACY_DISK_PATH.test(ref.diskPath)
          ? ref.diskPath
          : null;
      const inline = dataUrlParts(ref.thumbnailUri);
      if (!legacyDiskPath && !inline) continue;
      const source = legacyDiskPath ?? (ref.thumbnailUri as string);
      const sourceKey = `${legacyDiskPath ? "disk" : "data"}\0${source}`;
      let write = writes.get(sourceKey);
      if (!write) {
        const digest = createHash("sha256")
          .update(args.chatId)
          .update("\0")
          .update(row.msgId)
          .update("\0")
          .update(source)
          .digest("hex")
          .slice(0, 20);
        const attachmentId =
          typeof ref.attachmentId === "string" && ID_OK.test(ref.attachmentId)
            ? ref.attachmentId
            : `legacy_${digest}`;
        write = (async (): Promise<MigratedImage | null> => {
          let base64 = inline?.base64 ?? null;
          if (legacyDiskPath) {
            const read = readWorkspaceFile(args.cwd, legacyDiskPath);
            if (read.kind !== "image" || !read.dataUrl) return null;
            base64 = dataUrlParts(read.dataUrl)?.base64 ?? null;
          }
          if (!base64) return null;
          const written = await stageContextGraphAttachment(args.cwd, {
            attachmentId,
            base64,
            filename:
              typeof ref.name === "string" && ref.name
                ? ref.name
                : legacyDiskPath
                  ? path.posix.basename(legacyDiskPath)
                  : `legacy-${digest}`,
          });
          return written.ok && written.relativePath
            ? { diskPath: written.relativePath, attachmentId }
            : null;
        })().catch(() => null);
        writes.set(sourceKey, write);
      }
      const migrated = await write;
      if (!migrated) continue;
      ref.diskPath = migrated.diskPath;
      ref.attachmentId = migrated.attachmentId;
      delete ref.thumbnailUri;
      changed = true;
    }

    if (!changed) {
      result.push(row);
      continue;
    }
    const migrated = { ...row, payload: JSON.stringify(message) };
    result.push(migrated);
    changedRows.push(migrated);
  }

  if (changedRows.length > 0) {
    upsertChatMessagesBulk(args.chatId, changedRows);
  }
  return result;
}

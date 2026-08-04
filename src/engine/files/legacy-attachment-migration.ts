// ──────────────────────────────────────────────────────────
// Legacy transcript image externalization
// ──────────────────────────────────────────────────────────
//
// Pre-disk-protocol user messages persisted a full data URL in both the flat
// attachment list and the ordered segment list. Window reads migrate only the
// rows being opened: write each unique message image once, replace both copies
// with the same diskPath, and upsert the compact payload. A failed write leaves
// that legacy URI untouched so old chats remain viewable/editable.
// ──────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import path from "node:path";

import type { PersistedMessage } from "../db/messages";
import { upsertChatMessagesBulk } from "../db/messages";
import { writeAgentAttachment } from "./agent-attachment";

interface LegacyImageRef {
  name?: unknown;
  mimeType?: unknown;
  kind?: unknown;
  type?: unknown;
  thumbnailUri?: unknown;
  diskPath?: unknown;
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
    if (
      !row.payload.includes('"thumbnailUri"') ||
      !row.payload.includes("data:image/")
    ) {
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
    const writes = new Map<string, Promise<string | null>>();
    let changed = false;
    for (const ref of refs) {
      if (typeof ref.diskPath === "string") continue;
      const parts = dataUrlParts(ref.thumbnailUri);
      if (!parts) continue;
      const source = ref.thumbnailUri as string;
      let write = writes.get(source);
      if (!write) {
        const digest = createHash("sha256")
          .update(row.msgId)
          .update("\0")
          .update(source)
          .digest("hex")
          .slice(0, 20);
        write = writeAgentAttachment(args.cwd, {
          chatId: args.chatId,
          attachmentId: `legacy_${digest}`,
          base64: parts.base64,
          mimeType: parts.mimeType,
          filename:
            typeof ref.name === "string" && ref.name
              ? ref.name
              : `legacy-${digest}`,
        })
          .then((written) => written.relativePath)
          .catch(() => null);
        writes.set(source, write);
      }
      const diskPath = await write;
      if (!diskPath) continue;
      ref.diskPath = diskPath;
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

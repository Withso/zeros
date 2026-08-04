// ──────────────────────────────────────────────────────────
// reconstruct.ts — sent message → editor content (edit-in-place)
// ──────────────────────────────────────────────────────────
//
// Editing a user message rebuilds the WHOLE message as inline editor content:
// text + mention pills + attachment pills, exactly where they were composed
// (no separate "originals" chip row). Image bytes are recovered from the
// persisted disk reference (legacy messages still decode their data URL);
// text-file bodies weren't stored, so they reconstruct empty.
// ──────────────────────────────────────────────────────────

import type {
  MessageContentSegment,
  AgentTextMessageAttachment,
} from "@zeros/core/agent-messages";

import type { ComposerAttachment } from "../composer-attachments";
import type { ComposerInitialContent } from "./use-composer-editor";

/** Ids minted here mark a chip REBUILT from an already-sent message, not a
 *  fresh attach. The context-graph staging paths key off this prefix: the
 *  original send already recorded the file under its original id, so staging
 *  a reconstruction would duplicate the card on every edit-in-place. */
export const RECONSTRUCTED_ATTACHMENT_ID_PREFIX = "att-edit-";

let seq = 0;
function freshId(): string {
  seq += 1;
  return `${RECONSTRUCTED_ATTACHMENT_ID_PREFIX}${Date.now().toString(36)}-${seq.toString(36)}`;
}

function approxBytes(b64: string): number {
  return Math.floor((b64.length * 3) / 4);
}

function reconstructAttachment(
  seg: {
    name: string;
    mimeType: string;
    kind: "image" | "text";
    thumbnailUri?: string;
    diskPath?: string;
  },
  id: string,
): ComposerAttachment {
  let data = "";
  if (seg.kind === "image" && seg.thumbnailUri) {
    const comma = seg.thumbnailUri.indexOf(",");
    data = comma >= 0 ? seg.thumbnailUri.slice(comma + 1) : "";
  }
  return {
    id,
    name: seg.name,
    mimeType: seg.mimeType,
    kind: seg.kind,
    data,
    text: seg.kind === "text" ? "" : undefined,
    size: data ? approxBytes(data) : 0,
    validation: { ok: true },
    ...(seg.diskPath ? { diskPath: seg.diskPath } : {}),
  };
}

/** Rebuild editor content (doc JSON + the attachment side-store entries) from a
 *  sent message. Prefers the persisted `segments`; falls back to plain text +
 *  the flat attachment list for pre-editor messages. */
export function messageToEditorContent(opts: {
  text: string;
  segments?: MessageContentSegment[];
  attachments?: AgentTextMessageAttachment[];
}): ComposerInitialContent {
  const segments: MessageContentSegment[] =
    opts.segments && opts.segments.length > 0
      ? opts.segments
      : [
          ...(opts.text ? [{ type: "text" as const, text: opts.text }] : []),
          ...(opts.attachments ?? []).map(
            (a): MessageContentSegment => ({
              type: "attachment",
              name: a.name,
              mimeType: a.mimeType,
              kind: a.kind,
              thumbnailUri: a.thumbnailUri,
              diskPath: a.diskPath,
            }),
          ),
        ];

  const content: object[] = [];
  const attachments: ComposerAttachment[] = [];
  for (const s of segments) {
    if (s.type === "text") {
      if (s.text) content.push({ type: "text", text: s.text });
    } else if (s.type === "mention") {
      const token =
        s.kind === "selection"
          ? "@selection"
          : `\`${s.path}${s.kind === "folder" ? "/" : ""}\``;
      content.push({
        type: "mention",
        attrs: { token, label: s.label, path: s.path, kind: s.kind },
      });
    } else {
      const id = freshId();
      attachments.push(reconstructAttachment(s, id));
      content.push({
        type: "attachment",
        attrs: {
          attachmentId: id,
          name: s.name,
          mimeType: s.mimeType,
          kind: s.kind,
        },
      });
    }
  }

  return {
    json: {
      type: "doc",
      content: [
        content.length > 0
          ? { type: "paragraph", content }
          : { type: "paragraph" },
      ],
    },
    attachments,
  };
}

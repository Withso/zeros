// Composer attachments are delivered as confirmed workspace file references for
// every agent. Attach-time staging starts the disk copy; sending awaits an
// idempotent write before publishing the path. Legacy drafts/transcript chips
// remain readable, but their restored bytes never become native prompt input.

import { attachmentReferenceBlock } from "./attachment-reference";
import {
  readImageAttachment,
  readTextAttachment,
  writeContextAttachment,
} from "./agent-history-client";
import type { ComposerAttachment } from "./composer-attachments";
import type { ContentBlock } from "../../platform/bridge/agent-events";
import type { AgentTextMessageAttachment } from "@zeros/protocol/agent-messages";

/** Everything the encoder needs from the surrounding session. Passed in rather
 *  than read from a hook so the function stays callable from both the live
 *  send path and the edit-resubmit path, and testable without a React tree. */
export interface EncodeAttachmentsContext {
  /** Accepted for existing callers; native image support does not affect
   * attachment delivery. Images are opened by the agent from disk. */
  supportsImage: boolean;
  /** The workspace that owns the saved files and the agent's working directory. */
  cwd: string | null;
  /** Provenance only — the graph is workspace-scoped, so encoding (and its
   *  graph writes) works before the first prompt creates the chat. */
  chatId: string | null;
  /** Caller identity retained for compatibility; reference syntax is shared. */
  agentId: string | null;
}

export interface EncodedAttachments {
  blocks: ContentBlock[];
  bubbleAttachments: AgentTextMessageAttachment[];
  /** Ephemeral composer-id lookup used to stamp disk references onto ordered
   *  message segments. Composer ids themselves are not persisted there. */
  bubbleAttachmentById: Map<string, AgentTextMessageAttachment>;
  /** Attachments that will NOT reach the agent, with why.
   *
   *  Returned rather than logged because dropping silently is the bug this
   *  module exists to end, and the reasons are all reachable in normal use:
   *  a verdict stamped under one model and sent under another, a body the
   *  editor could not reconstruct, a disk write that failed. The caller owns
   *  telling the user — it is the one that knows a send just happened. */
  skipped: { name: string; reason: string }[];
}

/** UTF-8 → base64 without Node's Buffer (this runs in the renderer). Chunked
 *  so a multi-MB text attachment doesn't blow the argument-spread limit.
 *  Exported for the composer's attach-time staging, which encodes the same
 *  text bodies for the same IPC. */
export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Edit-in-place gives a reconstructed chip a fresh composer id, but its image
 *  already owns a durable graph record. Reuse that record's id for the
 *  idempotent send-time write instead of creating a duplicate canvas card. */
function durableAttachmentId(attachment: ComposerAttachment): string {
  if (attachment.contextAttachmentId) {
    return attachment.contextAttachmentId;
  }
  const match =
    typeof attachment.diskPath === "string"
      ? /^\.context(?:-graph)?\/(?:local|shared)\/attachments\/([a-zA-Z0-9_-]+)\//.exec(
          attachment.diskPath,
        )
      : null;
  return match?.[1] ?? attachment.id;
}

/** Hand `skipped` to the user, one warning per attachment.
 *
 *  Lives beside the producer, and takes the notifier rather than importing
 *  one, so the wording is defined once and stays testable without a toast
 *  host. `skipped` is only worth returning if EVERY send path reports it, and
 *  for a while only `handleSend` did: edit-resubmit and the queued-edit save
 *  both destructured around it, so re-sending a message whose transcript chip
 *  could not be reconstructed dropped the attachment AND said nothing — the
 *  exact silent drop this module was extracted to end.
 *
 * Callers retain the draft when any attachment is skipped; no prompt should
 * look successfully sent with missing context. */
export function reportSkippedAttachments(
  skipped: EncodedAttachments["skipped"],
  warn: (message: string) => void,
): void {
  for (const s of skipped) warn(`"${s.name}" wasn't sent — ${s.reason}.`);
}

/** Materialize staged attachments into ContentBlocks + sent-bubble metadata.
 *
 *  Invalid attachments are skipped. `agent-attachments.ts` documents that
 *  "submission filters out anything not ok", and until this function existed
 *  only the edit path honoured it — so an over-budget file was sent and
 *  silently discarded downstream, which is the worst of both outcomes. */
export async function encodeAttachments(
  attachments: ComposerAttachment[],
  ctx: EncodeAttachmentsContext,
): Promise<EncodedAttachments> {
  const blocks: ContentBlock[] = [];
  const bubbleAttachments: AgentTextMessageAttachment[] = [];
  const bubbleAttachmentById = new Map<string, AgentTextMessageAttachment>();
  const skipped: { name: string; reason: string }[] = [];

  for (const a of attachments) {
    if (!a.validation.ok) {
      skipped.push({
        name: a.name,
        reason:
          a.validation.reason ?? "it exceeds this model's attachment budget",
      });
      continue;
    }

    if (!ctx.cwd) {
      skipped.push({
        name: a.name,
        reason: "choose a workspace to save it first",
      });
      continue;
    }

    const attachmentId = durableAttachmentId(a);
    let base64: string;
    let mimeType = a.mimeType;

    if (a.kind === "text") {
      let body = a.text;
      if (!body && (a.contextAttachmentId || a.diskPath)) {
        try {
          body =
            (await readTextAttachment({
              cwd: ctx.cwd,
              attachmentId,
              diskPath: a.diskPath,
            })) ?? "";
        } catch {
          // Report an unavailable saved source instead of sending partial context.
        }
      }
      // Older reconstructed text chips use an empty string for missing bytes.
      // New file uploads (including empty files) own a confirmed disk reference.
      if (!body) {
        skipped.push({
          name: a.name,
          reason: "its contents aren't available to re-send — attach it again",
        });
        continue;
      }
      base64 = utf8ToBase64(body);
    } else {
      base64 = a.data;
      if (!base64 && a.diskPath) {
        try {
          const restored = await readImageAttachment({
            cwd: ctx.cwd,
            diskPath: a.diskPath,
            attachmentId: a.contextAttachmentId,
            mimeType,
          });
          base64 = restored.base64;
          mimeType = restored.mimeType;
        } catch {
          skipped.push({
            name: a.name,
            reason: "its saved copy isn't available — attach it again",
          });
          continue;
        }
      }
      if (!base64) {
        skipped.push({
          name: a.name,
          reason: "its image bytes aren't available — attach it again",
        });
        continue;
      }
    }

    try {
      // Use the durable id on every resend. The writer pins local/shared scope
      // and returns the engine's sanitized filename; never guess either path.
      const written = await writeContextAttachment({
        cwd: ctx.cwd,
        chatId: ctx.chatId ?? undefined,
        attachmentId,
        base64,
        mimeType,
        filename: a.name,
      });
      if (!written.absolutePath || !written.relativePath) {
        throw new Error("Attachment persistence did not return a saved file");
      }
      blocks.push({
        type: "text",
        text: attachmentReferenceBlock({
          name: a.name,
          absolutePath: written.absolutePath,
          mimeType,
        }),
      });
      const bubbleAttachment: AgentTextMessageAttachment = {
        name: a.name,
        mimeType,
        kind: a.kind,
        diskPath: written.relativePath,
        attachmentId,
      };
      bubbleAttachments.push(bubbleAttachment);
      bubbleAttachmentById.set(a.id, bubbleAttachment);
    } catch {
      skipped.push({ name: a.name, reason: "it couldn't be saved to disk" });
    }
  }

  return { blocks, bubbleAttachments, bubbleAttachmentById, skipped };
}

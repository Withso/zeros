// ──────────────────────────────────────────────────────────
// encode-attachments — staged ComposerAttachments → ContentBlocks
// ──────────────────────────────────────────────────────────
//
// The ONE place a staged attachment becomes wire content. Extracted
// 2026-07-30 because there were two of these and only one was correct:
//
//   • editAndResubmit (agent-chat.tsx) had the `kind === "text"` branch and
//     honoured `validation.ok`.
//   • encodeComposerAttachments — the encoder BOTH live send paths use
//     (handleSend and the queued-edit save) — had neither. Every text
//     attachment was emitted as `{type:"image", data:""}`, which the vision
//     path drops silently (falsy base64 → no source.url), the non-vision path
//     throws on (requireString in writeImageAttachment), and Codex turns into
//     a zero-byte temp file. So dragging a .md into the composer rendered a
//     chip, sent successfully, and the agent never saw the file.
//
// The asymmetry is why the bug survived: a .txt attached while EDITING an
// already-sent message did arrive, so the feature looked half-working rather
// than broken.
//
// Text attachments are INLINED into the prompt as `<file name="…">body</file>`
// — there is no disk round-trip and no @path indirection. That is deliberate:
// "the agent knows what happened" must not degrade to "the agent could find
// out" (agents routinely skim or skip a referenced file).
// ──────────────────────────────────────────────────────────

import { imageReferenceBlock } from "./agent-attachments";
import {
  readImageAttachment,
  writeImageAttachment,
} from "./agent-history-client";
import type { ComposerAttachment } from "./composer-attachments";
import type { ContentBlock } from "../bridge/agent-events";
import type { AgentTextMessageAttachment } from "@zeros/core/agent-messages";

/** Everything the encoder needs from the surrounding session. Passed in rather
 *  than read from a hook so the function stays callable from both the live
 *  send path and the edit-resubmit path, and testable without a React tree. */
export interface EncodeAttachmentsContext {
  /** False only for agents whose promptCapabilities.image is explicitly false.
   *  Undefined capabilities mean "assume yes" — the adapter drops what it
   *  can't use, and guessing "no" would write files nobody reads. */
  supportsImage: boolean;
  /** Working directory to persist non-vision images under. */
  cwd: string | null;
  chatId: string | null;
  /** Chooses the @-mention vs absolute-path form of an image reference. */
  agentId: string | null;
}

export interface EncodedAttachments {
  blocks: ContentBlock[];
  bubbleAttachments: AgentTextMessageAttachment[];
  /** Ephemeral composer-id lookup used to stamp disk references onto ordered
   *  message segments. IDs themselves are not persisted. */
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

/** The inline form a text attachment takes in the prompt.
 *
 *  Quotes in the name are folded to apostrophes rather than escaped: the
 *  wrapper is read by a model, not a parser, and a backslash escape inside an
 *  XML-ish attribute is likelier to confuse than a `'`. */
export function textAttachmentBlock(name: string, body: string): string {
  return `<file name="${name.replace(/"/g, "'")}">\n${body}\n</file>`;
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
 *  Callers pass `toast.warning`. Not `toast.error`: the prompt itself did
 *  send, and everything else on it arrived. */
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

    if (a.kind === "text") {
      // An empty body is not an empty file — it is a body we do not have.
      // The edit-resubmit path reconstructs text chips from the sent bubble,
      // which stores the NAME but never the bytes, so re-sending would emit
      // `<file name="x.txt"></file>` and tell the agent that chat was empty.
      // Saying nothing and reporting it beats asserting something false.
      if (!a.text) {
        skipped.push({
          name: a.name,
          reason: "its contents aren't available to re-send — attach it again",
        });
        continue;
      }
      blocks.push({
        type: "text" as const,
        text: textAttachmentBlock(a.name, a.text),
      });
      const bubbleAttachment: AgentTextMessageAttachment = {
        name: a.name,
        mimeType: a.mimeType,
        kind: "text",
      };
      bubbleAttachments.push(bubbleAttachment);
      bubbleAttachmentById.set(a.id, bubbleAttachment);
      continue;
    }

    let imageBase64 = a.data;
    let imageMimeType = a.mimeType;
    if (!imageBase64 && a.diskPath && ctx.cwd) {
      try {
        const restored = await readImageAttachment({
          cwd: ctx.cwd,
          diskPath: a.diskPath,
          mimeType: a.mimeType,
        });
        imageBase64 = restored.base64;
        imageMimeType = restored.mimeType;
      } catch {
        skipped.push({
          name: a.name,
          reason: "its saved copy isn't available — attach it again",
        });
        continue;
      }
    }
    if (!imageBase64) {
      skipped.push({
        name: a.name,
        reason: "its image bytes aren't available — attach it again",
      });
      continue;
    }

    // A chat without a cwd cannot own a durable file. Preserve the wire send,
    // but keep transcript metadata byte-free; edit-resend will explicitly ask
    // the user to attach it again rather than pretending an empty image exists.
    if (!ctx.cwd || !ctx.chatId) {
      blocks.push({
        type: "image" as const,
        mimeType: imageMimeType,
        data: imageBase64,
      });
      const bubbleAttachment: AgentTextMessageAttachment = {
        name: a.name,
        mimeType: imageMimeType,
        kind: "image",
      };
      bubbleAttachments.push(bubbleAttachment);
      bubbleAttachmentById.set(a.id, bubbleAttachment);
      continue;
    }

    try {
      const written = await writeImageAttachment({
        cwd: ctx.cwd,
        chatId: ctx.chatId,
        attachmentId: a.id,
        base64: imageBase64,
        mimeType: imageMimeType,
        filename: a.name,
      });
      if (ctx.supportsImage) {
        blocks.push({
          type: "image" as const,
          mimeType: imageMimeType,
          data: imageBase64,
        });
      } else {
        blocks.push({
          type: "text" as const,
          text: imageReferenceBlock({
            agentId: ctx.agentId,
            filename: a.name,
            absolutePath: written.absolutePath,
            relativePath: written.relativePath,
            mimeType: imageMimeType,
          }),
        });
      }
      const bubbleAttachment: AgentTextMessageAttachment = {
        name: a.name,
        mimeType: imageMimeType,
        kind: "image",
        diskPath: written.relativePath,
      };
      bubbleAttachments.push(bubbleAttachment);
      bubbleAttachmentById.set(a.id, bubbleAttachment);
    } catch (err) {
      console.warn(
        `[Zeros agent-chat] failed to persist image ${a.name}:`,
        err,
      );
      skipped.push({ name: a.name, reason: "it couldn't be saved to disk" });
    }
  }

  return { blocks, bubbleAttachments, bubbleAttachmentById, skipped };
}
